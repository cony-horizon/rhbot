import { log } from "./logger.js";

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

export interface TgMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; username?: string };
}

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class TelegramClient {
  private readonly base: string;
  constructor(
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body: { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new TelegramError(`Telegram API から非 JSON 応答 (HTTP ${res.status}): ${text.slice(0, 120)}`, res.status);
      }
      if (!body.ok) {
        const err = new TelegramError(body.description ?? `HTTP ${res.status}`, body.error_code);
        (err as TelegramError & { retryAfter?: number }).retryAfter = body.parameters?.retry_after;
        throw err;
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(chatId: string | number, html: string, opts: { disablePreview?: boolean } = {}): Promise<void> {
    const payload = {
      chat_id: chatId,
      text: html.length > 4000 ? html.slice(0, 3990) + "\n…" : html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: opts.disablePreview ?? true },
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.call("sendMessage", payload);
        return;
      } catch (err) {
        const retryAfter = (err as { retryAfter?: number }).retryAfter;
        if (err instanceof TelegramError && err.code === 429) {
          const wait = (retryAfter ?? 3) * 1000;
          log.warn(`Telegram 429 — ${wait}ms 待機`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (err instanceof TelegramError && err.code === 400) {
          // HTML パースエラー等 → プレーンテキストで再送
          log.warn(`Telegram 400 (${err.message}) — プレーンテキストで再送`);
          await this.call("sendMessage", { chat_id: chatId, text: stripTags(html) });
          return;
        }
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "channel_post"] },
      (timeoutSec + 10) * 1000,
    );
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {});
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export type CommandHandler = (cmd: string, args: string[], chatId: string) => Promise<string | null>;

/**
 * getUpdates ロングポーリングでコマンドを受け付ける。
 * 許可された chat_id 以外からのメッセージは無視する。
 */
export class CommandLoop {
  private running = false;
  private offset: number;

  constructor(
    private readonly client: TelegramClient,
    private readonly allowedChatIds: Set<string>,
    private readonly handler: CommandHandler,
    private readonly persistOffset: { get(): number | null; set(n: number): void },
  ) {
    this.offset = persistOffset.get() ?? 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let updates: TgUpdate[];
      try {
        updates = await this.client.getUpdates(this.offset);
      } catch (err) {
        if (!this.running) return;
        log.warn("Telegram getUpdates 失敗", err);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        this.persistOffset.set(this.offset);
        const msg = u.message ?? u.channel_post;
        if (!msg?.text) continue;
        const chatId = String(msg.chat.id);
        if (!this.allowedChatIds.has(chatId)) {
          log.debug(`許可されていない chat からのメッセージを無視: ${chatId}`);
          continue;
        }
        const parsed = parseCommand(msg.text);
        if (!parsed) continue;
        try {
          const reply = await this.handler(parsed.cmd, parsed.args, chatId);
          if (reply) await this.client.sendMessage(chatId, reply);
        } catch (err) {
          log.error(`コマンド処理エラー (${parsed.cmd})`, err);
          try {
            await this.client.sendMessage(chatId, `⚠️ エラー: ${err instanceof Error ? err.message : String(err)}`);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}

export function parseCommand(text: string): { cmd: string; args: string[] } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.split(/\s+/);
  const first = parts[0] ?? "";
  const cmd = first.slice(1).split("@")[0]?.toLowerCase() ?? "";
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}
