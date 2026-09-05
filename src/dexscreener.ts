import { log } from "./logger.js";

export type Window = "m5" | "h1" | "h6" | "h24";

export interface DexToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexToken;
  quoteToken: DexToken;
  priceNative: string;
  priceUsd?: string;
  txns: Partial<Record<Window, { buys: number; sells: number }>>;
  volume: Partial<Record<Window, number>>;
  priceChange: Partial<Record<Window, number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { platform?: string; type?: string; handle?: string; url?: string }[];
  };
  boosts?: { active: number };
}

export interface TokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
  amount?: number;
  totalAmount?: number;
}

export class DexScreenerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

/** 直近 60 秒のリクエスト数を上限以下に抑えるスライディングウィンドウ制限 */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      const oldest = this.stamps[0] ?? t;
      await this.sleep(Math.max(50, oldest + 60_000 - t));
    }
  }
}

export interface DexScreenerClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** 公式レート制限: pairs/search/tokens 系 300 req/min, profiles/boosts 系 60 req/min */
  mainPerMinute?: number;
  profilePerMinute?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_ADDRESSES_PER_REQUEST = 30;

export class DexScreenerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mainLimiter: RateLimiter;
  private readonly profileLimiter: RateLimiter;
  public requestCount = 0;

  constructor(opts: DexScreenerClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.dexscreener.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.mainLimiter = new RateLimiter(opts.mainPerMinute ?? 280, Date.now, this.sleep);
    this.profileLimiter = new RateLimiter(opts.profilePerMinute ?? 55, Date.now, this.sleep);
  }

  private async get<T>(path: string, limiter: RateLimiter): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await limiter.acquire();
      this.requestCount++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          signal: ctrl.signal,
          headers: { accept: "application/json", "user-agent": "rhbot/0.1" },
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000 * attempt;
          log.warn(`DexScreener 429 (rate limited) ${path} — ${waitMs}ms 待機`);
          lastErr = new DexScreenerError("rate limited", 429);
          await this.sleep(waitMs);
          continue;
        }
        if (res.status >= 500) {
          lastErr = new DexScreenerError(`HTTP ${res.status}`, res.status);
          await this.sleep(1_000 * attempt);
          continue;
        }
        if (!res.ok) {
          throw new DexScreenerError(`HTTP ${res.status} for ${path}`, res.status);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof DexScreenerError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        await this.sleep(1_000 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new DexScreenerError(String(lastErr));
  }

  /** 自由検索。全チェーン横断で最大 30 件しか返らない点に注意 */
  async search(query: string): Promise<DexPair[]> {
    const res = await this.get<{ pairs?: DexPair[] | null }>(
      `/latest/dex/search?q=${encodeURIComponent(query)}`,
      this.mainLimiter,
    );
    return res.pairs ?? [];
  }

  /** ペアアドレス（最大 30 件/リクエスト。超過分は自動分割） */
  async getPairs(chainId: string, pairAddresses: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (const chunk of chunked(dedupe(pairAddresses), MAX_ADDRESSES_PER_REQUEST)) {
      const res = await this.get<{ pairs?: DexPair[] | null; pair?: DexPair | null }>(
        `/latest/dex/pairs/${chainId}/${chunk.join(",")}`,
        this.mainLimiter,
      );
      if (res.pairs) out.push(...res.pairs);
      else if (res.pair) out.push(res.pair);
    }
    return out;
  }

  /** あるトークンを含む全プール */
  async getTokenPools(chainId: string, tokenAddress: string): Promise<DexPair[]> {
    const res = await this.get<DexPair[] | { pairs?: DexPair[] }>(
      `/token-pairs/v1/${chainId}/${tokenAddress}`,
      this.mainLimiter,
    );
    return Array.isArray(res) ? res : (res.pairs ?? []);
  }

  /** トークンアドレス複数（最大 30 件/リクエスト） */
  async getTokens(chainId: string, tokenAddresses: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (const chunk of chunked(dedupe(tokenAddresses), MAX_ADDRESSES_PER_REQUEST)) {
      const res = await this.get<DexPair[] | { pairs?: DexPair[] }>(
        `/tokens/v1/${chainId}/${chunk.join(",")}`,
        this.mainLimiter,
      );
      out.push(...(Array.isArray(res) ? res : (res.pairs ?? [])));
    }
    return out;
  }

  async latestTokenProfiles(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-profiles/latest/v1", this.profileLimiter);
  }

  async latestBoosts(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-boosts/latest/v1", this.profileLimiter);
  }

  async topBoosts(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-boosts/top/v1", this.profileLimiter);
  }
}

export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/* ---------- 数値ヘルパ（欠損に強い） ---------- */

export function priceUsd(p: DexPair): number | null {
  const n = Number(p.priceUsd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function vol(p: DexPair, w: Window): number {
  const n = p.volume?.[w];
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function buys(p: DexPair, w: Window): number {
  return p.txns?.[w]?.buys ?? 0;
}

export function sells(p: DexPair, w: Window): number {
  return p.txns?.[w]?.sells ?? 0;
}

export function liquidityUsd(p: DexPair): number {
  const n = p.liquidity?.usd;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function priceChange(p: DexPair, w: Window): number | null {
  const n = p.priceChange?.[w];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function pairAgeMs(p: DexPair, now: number): number | null {
  return typeof p.pairCreatedAt === "number" && p.pairCreatedAt > 0 ? now - p.pairCreatedAt : null;
}
