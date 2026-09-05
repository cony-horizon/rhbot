import { ConfigError, loadConfig, type Config } from "./config.js";
import { DexScreenerClient } from "./dexscreener.js";
import { Engine } from "./engine.js";
import { escapeHtml, fmtUsd, formatAlertRow, formatPairRow } from "./format.js";
import { log, setLogLevel } from "./logger.js";
import { RpcClient } from "./rpc.js";
import { every, type ScheduledTask } from "./scheduler.js";
import { Store } from "./store.js";
import { CommandLoop, TelegramClient } from "./telegram.js";

const COMMANDS = [
  { command: "status", description: "監視状況を表示" },
  { command: "top", description: "1h 出来高上位ペア" },
  { command: "alerts", description: "直近のアラート履歴" },
  { command: "test", description: "通知の見本を送って配信を確認" },
  { command: "watch", description: "アドレスを手動で監視に追加" },
  { command: "unwatch", description: "監視から外す" },
  { command: "list", description: "手動監視中のペア一覧" },
  { command: "mute", description: "通知を一時停止 (分)" },
  { command: "unmute", description: "通知を再開" },
  { command: "config", description: "検知しきい値を表示" },
  { command: "help", description: "ヘルプ" },
];

function helpText(): string {
  return [
    "<b>Robinhood Chain ミームコイン スパイク検知ボット</b>",
    "",
    "🚀 新規ローンチ: 作成から一定時間内に 1h 出来高が段階しきい値を超えたら通知",
    "🔥 復活スパイク: 20h 以上経過したペアで突発的な出来高と +30% 以上の価格上昇を検知",
    "",
    "通知が来ないときは /status で監視ペア数を、/test で配信経路を確認してください。",
    "",
    ...COMMANDS.map((c) => `/${c.command} — ${c.description}`),
  ].join("\n");
}

function configText(cfg: Config): string {
  return [
    "<b>検知設定</b>",
    `chain: ${cfg.chainId} | 最低流動性: ${fmtUsd(cfg.minLiquidityUsd)}`,
    `<b>新規</b> ${cfg.newLaunchEnabled ? "ON" : "OFF"}: 〜${cfg.newMaxAgeHours}h, 1h出来高段階 ${cfg.newVolH1TiersUsd.map((n) => fmtUsd(n)).join(" / ")}, 買>=${cfg.newMinBuysH1}`,
    `<b>復活</b> ${cfg.revivalEnabled ? "ON" : "OFF"}: ${cfg.revivalMinAgeHours}h〜, 価格 +${cfg.revivalPriceChangePct}% (1h or ${cfg.revivalLookbackMin}分安値比), 1h出来高>=${fmtUsd(
      cfg.revivalMinVolH1Usd,
    )}, 突発率>=${cfg.revivalVolSpikeRatio}x, 買>=${cfg.revivalMinBuysH1}, cooldown ${cfg.revivalCooldownMin}分, 追加上昇 +${cfg.revivalEscalationPct}%`,
    `更新間隔: hot ${cfg.pollIntervalSec}s / dormant ${cfg.dormantPollIntervalSec}s / dead ${cfg.deadPollIntervalSec}s`,
    `RPC: ${cfg.rpcUrl ?? "無効"}`,
    "",
    "変更は .env を編集して再起動してください。",
  ].join("\n");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info(`起動: chain=${cfg.chainId} db=${cfg.dbPath}`);

  const store = new Store(cfg.dbPath);
  const dex = new DexScreenerClient();
  const tg = new TelegramClient(cfg.telegramBotToken);
  const rpc = cfg.rpcUrl ? new RpcClient(cfg.rpcUrl) : null;

  const sink = {
    async broadcast(html: string) {
      for (const chatId of cfg.telegramChatIds) await tg.sendMessage(chatId, html);
    },
  };
  const engine = new Engine(cfg, store, dex, sink, rpc);

  try {
    const me = await tg.getMe();
    log.info(`Telegram bot: @${me.username ?? me.id}`);
    await tg.setMyCommands(COMMANDS);
  } catch (err) {
    log.error("Telegram への接続に失敗しました。TELEGRAM_BOT_TOKEN を確認してください", err);
    throw err;
  }

  const commands = new CommandLoop(
    tg,
    new Set(cfg.telegramChatIds),
    async (cmd, args) => {
      switch (cmd) {
        case "start":
        case "help":
          return helpText();
        case "config":
          return configText(cfg);
        case "status": {
          const tiers = store.countByTier();
          const s = engine.stats;
          return [
            "<b>監視状況</b>",
            `ペア: hot ${tiers.hot} / dormant ${tiers.dormant} / dead ${tiers.dead} (pending ${store.countPending()})`,
            `直近 24h アラート: ${store.countAlertsSince(Date.now() - 86_400_000)} 件 (送信累計 ${s.alertsSent})`,
            `最終 discovery: ${s.lastDiscoveryAt ? new Date(s.lastDiscoveryAt).toISOString() : "-"} (+${s.lastDiscoveryAdded})`,
            `RPC block: ${s.lastRpcBlock ?? "-"} / 検知イベント累計 ${s.rpcEventsTotal}`,
            `DexScreener リクエスト累計: ${dex.requestCount}`,
            engine.isMuted() ? `🔇 ミュート中 (残り ${engine.mutedRemainingMin()} 分)` : "🔔 通知 ON",
          ].join("\n");
        }
        case "top": {
          const n = Math.min(30, Number(args[0]) || 10);
          const rows = store.listTopByVolH1(n);
          if (rows.length === 0) return "まだ監視ペアがありません";
          return `<b>1h 出来高上位 ${rows.length}</b>\n` + rows.map(formatPairRow).join("\n");
        }
        case "alerts": {
          const n = Math.min(30, Number(args[0]) || 10);
          const rows = store.recentAlerts(n);
          if (rows.length === 0) return "アラート履歴はまだありません";
          return `<b>直近のアラート</b>\n` + rows.map(formatAlertRow).join("\n");
        }
        case "test":
          return await engine.sendSampleAlert();
        case "watch": {
          const addr = args[0];
          if (!addr || !/^0x[0-9a-fA-F]{40,64}$/.test(addr)) return "使い方: /watch <ペア or トークンアドレス>";
          const pairs = await engine.watch(addr);
          if (pairs.length === 0) return `DexScreener に ${escapeHtml(addr)} のペアが見つかりませんでした (chain=${cfg.chainId})`;
          return `✅ ${pairs.length} ペアを監視に追加:\n` + pairs.map((p) => `• $${escapeHtml(p.baseToken.symbol)}/${escapeHtml(p.quoteToken.symbol)} (${p.dexId})`).join("\n");
        }
        case "unwatch": {
          const addr = args[0];
          if (!addr) return "使い方: /unwatch <ペア or トークンアドレス>";
          const n = engine.unwatch(addr);
          return n > 0 ? `🗑 ${n} ペアを監視から外しました` : "該当ペアがありません";
        }
        case "list": {
          const rows = store.listManual();
          if (rows.length === 0) return "手動監視中のペアはありません (/watch で追加)";
          return `<b>手動監視中 ${rows.length}</b>\n` + rows.map(formatPairRow).join("\n");
        }
        case "mute": {
          const min = Number(args[0]) || 60;
          engine.mute(min);
          return `🔇 ${min} 分間通知を停止します（検知は継続し履歴に残ります）`;
        }
        case "unmute":
          engine.unmute();
          return "🔔 通知を再開しました";
        default:
          return null;
      }
    },
    {
      get: () => {
        const v = store.getKv("tg_offset");
        return v === null ? null : Number(v);
      },
      set: (n) => store.setKv("tg_offset", String(n)),
    },
  );
  commands.start();

  const tasks: ScheduledTask[] = [
    every("discovery", cfg.discoveryIntervalSec * 1000, () => engine.discover().then(() => undefined)),
    every("refresh:hot", Math.max(10, Math.floor(cfg.pollIntervalSec / 3)) * 1000, () =>
      engine.refreshTier("hot", cfg.pollIntervalSec).then(() => undefined),
    ),
    every("refresh:dormant", 30_000, () => engine.refreshTier("dormant", cfg.dormantPollIntervalSec).then(() => undefined)),
    every("refresh:dead", 120_000, () => engine.refreshTier("dead", cfg.deadPollIntervalSec, 300).then(() => undefined)),
    every("pending", 60_000, () => engine.resolvePending().then(() => undefined)),
    every("maintain", 3_600_000, async () => engine.maintain(), { immediate: false }),
  ];
  if (rpc) tasks.push(every("rpc-scan", cfg.rpcScanIntervalSec * 1000, () => engine.scanRpc().then(() => undefined)));

  if (cfg.notifyOnStart) {
    try {
      await sink.broadcast(
        `🟢 スパイク検知ボット起動 (chain=${cfg.chainId}, 監視 ${store.countPairs()} ペア)\n/help でコマンド一覧`,
      );
    } catch (err) {
      log.error("起動通知の送信に失敗 (TELEGRAM_CHAT_ID を確認してください)", err);
    }
  }

  const shutdown = (sig: string) => {
    log.info(`${sig} 受信 — 停止します`);
    for (const t of tasks) t.stop();
    commands.stop();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n⚠️  ${err.message}\n`);
    for (const line of err.hint) console.error(line);
    console.error("");
  } else {
    log.error("致命的エラー", err);
  }
  process.exit(1);
});
