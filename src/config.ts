import type { LogLevel } from "./logger.js";

/**
 * 利用者が .env を直せば解決するエラー。
 * プログラムの不具合ではないので、スタックトレースではなく対処法だけを表示する。
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly hint: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  telegramBotToken: string;
  telegramChatIds: string[];
  chainId: string;

  discoverySearchQueries: string[];
  discoveryTokenAddresses: string[];
  discoveryUseProfiles: boolean;
  discoveryIntervalSec: number;

  rpcUrl: string | null;
  rpcScanIntervalSec: number;
  rpcBlockChunk: number;
  rpcBackfillBlocks: number;
  rpcFactoryAddresses: string[];

  pollIntervalSec: number;
  dormantPollIntervalSec: number;
  deadPollIntervalSec: number;
  deadLiquidityUsd: number;
  deadDropDays: number;
  hotVolH1Usd: number;

  minLiquidityUsd: number;
  quoteSymbols: string[];

  newLaunchEnabled: boolean;
  newMaxAgeHours: number;
  newVolH1TiersUsd: number[];
  newMinBuysH1: number;

  revivalEnabled: boolean;
  revivalMinAgeHours: number;
  revivalPriceChangePct: number;
  revivalLookbackMin: number;
  revivalMinVolH1Usd: number;
  revivalVolSpikeRatio: number;
  revivalMinBuysH1: number;
  revivalCooldownMin: number;
  revivalEscalationPct: number;

  dbPath: string;
  snapshotRetentionHours: number;
  logLevel: LogLevel;
  notifyOnStart: boolean;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, def: string): string {
  const v = env[key];
  return v === undefined || v.trim() === "" ? def : v.trim();
}

function num(env: Env, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${key} には数値を書いてください（いまは "${v}" になっています）`, [
      `.env の ${key} の行を確認してください。単位や記号（$ , % 円）は書かず、数字だけにします。`,
      `  正しい例: ${key}=30`,
    ]);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v.trim() === "") return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function list(env: Env, key: string, def: string[]): string[] {
  const v = env[key];
  if (v === undefined) return def;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function numList(env: Env, key: string, def: number[]): number[] {
  const raw = list(env, key, []);
  if (raw.length === 0) return def;
  const out = raw.map((s) => Number(s));
  if (out.some((n) => !Number.isFinite(n))) {
    throw new ConfigError(`${key} は数値をカンマで区切って書いてください`, [
      `  正しい例: ${key}=25000,100000,500000`,
    ]);
  }
  return out.sort((a, b) => a - b);
}

export const DEFAULT_WETH_ROBINHOOD = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/**
 * 環境変数から設定を組み立てる。`.env` の読み込みは呼び出し側で行う（テスト容易性のため）。
 * `strict=false` のときは Telegram の必須項目が無くてもエラーにしない（probe ツール用）。
 */
export function buildConfig(env: Env, strict = true): Config {
  const token = str(env, "TELEGRAM_BOT_TOKEN", "");
  const chatIds = list(env, "TELEGRAM_CHAT_ID", []);
  if (strict) {
    if (!token) {
      throw new ConfigError("TELEGRAM_BOT_TOKEN が設定されていません", [
        ".env ファイルを開いて、TELEGRAM_BOT_TOKEN= の右側にトークンを貼り付けてください。",
        "",
        "  例: TELEGRAM_BOT_TOKEN=1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
        "",
        "・トークンは Telegram の @BotFather から受け取った長い文字列です",
        "・= の前後にスペースを入れないでください",
        "・引用符 (\") で囲まないでください",
        "・先頭に bot を付けないでください",
        "",
        ".env が見つからない場合は、まず次を実行してひな形を作ってください。",
        "  Mac    : cp .env.example .env",
        "  Windows: copy .env.example .env",
      ]);
    }
    if (chatIds.length === 0) {
      throw new ConfigError("TELEGRAM_CHAT_ID が設定されていません", [
        ".env ファイルを開いて、TELEGRAM_CHAT_ID= の右側に宛先番号を貼り付けてください。",
        "",
        "  例: TELEGRAM_CHAT_ID=987654321",
        "",
        "宛先番号（chat_id）の調べ方:",
        "  1. Telegram で自分のボットに何かメッセージを送る",
        "  2. ブラウザで https://api.telegram.org/bot<トークン>/getUpdates を開く",
        '  3. "chat":{"id": のすぐ後ろの数字がそれです',
      ]);
    }
  }

  const rpcUrl = str(env, "RPC_URL", "");
  const logLevel = str(env, "LOG_LEVEL", "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL の値が正しくありません: ${logLevel}`, [
      "debug / info / warn / error のいずれかを指定してください。",
    ]);
  }

  return {
    telegramBotToken: token,
    telegramChatIds: chatIds,
    chainId: str(env, "CHAIN_ID", "robinhood"),

    discoverySearchQueries: list(env, "DISCOVERY_SEARCH_QUERIES", ["robinhood", "WETH", "HOOD", "ETH", "USDC"]),
    discoveryTokenAddresses: list(env, "DISCOVERY_TOKEN_ADDRESSES", [DEFAULT_WETH_ROBINHOOD]),
    discoveryUseProfiles: bool(env, "DISCOVERY_USE_PROFILES", true),
    discoveryIntervalSec: num(env, "DISCOVERY_INTERVAL_SEC", 120),

    rpcUrl: rpcUrl || null,
    rpcScanIntervalSec: num(env, "RPC_SCAN_INTERVAL_SEC", 20),
    rpcBlockChunk: num(env, "RPC_BLOCK_CHUNK", 2000),
    rpcBackfillBlocks: num(env, "RPC_BACKFILL_BLOCKS", 0),
    rpcFactoryAddresses: list(env, "RPC_FACTORY_ADDRESSES", []).map((a) => a.toLowerCase()),

    pollIntervalSec: num(env, "POLL_INTERVAL_SEC", 45),
    dormantPollIntervalSec: num(env, "DORMANT_POLL_INTERVAL_SEC", 240),
    deadPollIntervalSec: num(env, "DEAD_POLL_INTERVAL_SEC", 1800),
    deadLiquidityUsd: num(env, "DEAD_LIQUIDITY_USD", 300),
    deadDropDays: num(env, "DEAD_DROP_DAYS", 7),
    hotVolH1Usd: num(env, "HOT_VOL_H1_USD", 1000),

    minLiquidityUsd: num(env, "MIN_LIQUIDITY_USD", 5000),
    quoteSymbols: list(env, "QUOTE_SYMBOLS", []).map((s) => s.toUpperCase()),

    newLaunchEnabled: bool(env, "NEW_LAUNCH_ENABLED", true),
    newMaxAgeHours: num(env, "NEW_MAX_AGE_HOURS", 20),
    newVolH1TiersUsd: numList(env, "NEW_VOL_H1_TIERS_USD", [25_000, 100_000, 500_000]),
    newMinBuysH1: num(env, "NEW_MIN_BUYS_H1", 15),

    revivalEnabled: bool(env, "REVIVAL_ENABLED", true),
    revivalMinAgeHours: num(env, "REVIVAL_MIN_AGE_HOURS", 20),
    revivalPriceChangePct: num(env, "REVIVAL_PRICE_CHANGE_PCT", 30),
    revivalLookbackMin: num(env, "REVIVAL_LOOKBACK_MIN", 120),
    revivalMinVolH1Usd: num(env, "REVIVAL_MIN_VOL_H1_USD", 10_000),
    revivalVolSpikeRatio: num(env, "REVIVAL_VOL_SPIKE_RATIO", 3),
    revivalMinBuysH1: num(env, "REVIVAL_MIN_BUYS_H1", 10),
    revivalCooldownMin: num(env, "REVIVAL_COOLDOWN_MIN", 180),
    revivalEscalationPct: num(env, "REVIVAL_ESCALATION_PCT", 50),

    dbPath: str(env, "DB_PATH", "./data/bot.sqlite"),
    snapshotRetentionHours: num(env, "SNAPSHOT_RETENTION_HOURS", 48),
    logLevel,
    notifyOnStart: bool(env, "NOTIFY_ON_START", true),
  };
}

/** `.env` を読み込んで設定を返す（本番エントリ用） */
export function loadConfig(strict = true): Config {
  const envFile = process.env.ENV_FILE ?? ".env";
  try {
    process.loadEnvFile(envFile);
  } catch {
    // .env が無い場合は環境変数のみで動作
  }
  return buildConfig(process.env, strict);
}
