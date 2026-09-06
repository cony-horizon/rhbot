import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { DexPair } from "./dexscreener.js";
import { buys, liquidityUsd, priceUsd, sells, vol } from "./dexscreener.js";

export type Tier = "hot" | "dormant" | "dead";
export type AlertKind = "new_launch" | "revival";

export interface PairRow {
  pair_address: string;
  chain_id: string;
  dex_id: string;
  labels: string;
  base_address: string;
  base_symbol: string;
  base_name: string;
  quote_address: string;
  quote_symbol: string;
  url: string;
  pair_created_at: number | null;
  first_seen_at: number;
  last_refreshed_at: number;
  last_price_usd: number | null;
  last_liquidity_usd: number;
  last_vol_h1: number;
  last_vol_h24: number;
  tier: Tier;
  dead_since: number | null;
  source: string;
  manual: number;
  miss_count: number;
  /** この銘柄が記録した最大の 1h 出来高＝全盛期の熱量 */
  peak_vol_h1: number;
  peak_vol_at: number | null;
  peak_price: number;
  peak_price_at: number | null;
  peak_mc: number;
}

export interface SnapshotRow {
  ts: number;
  price_usd: number | null;
  vol_h1: number;
  vol_h24: number;
  liquidity_usd: number;
  buys_h1: number;
  sells_h1: number;
}

export interface AlertRow {
  id: number;
  kind: AlertKind;
  token_address: string;
  pair_address: string;
  ts: number;
  level: number;
  price_usd: number | null;
  symbol: string;
  summary: string;
  /** スキャム判定スコア (0-100) */
  scam_score: number;
  /** 判定理由。改行区切り */
  scam_reasons: string;
  /** 1 ならスコア超過で通知を止めたもの */
  suppressed: number;
}

export interface PendingRow {
  pair_address: string;
  source: string;
  first_seen_at: number;
  attempts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  pair_address TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  dex_id TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '',
  base_address TEXT NOT NULL,
  base_symbol TEXT NOT NULL DEFAULT '',
  base_name TEXT NOT NULL DEFAULT '',
  quote_address TEXT NOT NULL DEFAULT '',
  quote_symbol TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  pair_created_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_refreshed_at INTEGER NOT NULL DEFAULT 0,
  last_price_usd REAL,
  last_liquidity_usd REAL NOT NULL DEFAULT 0,
  last_vol_h1 REAL NOT NULL DEFAULT 0,
  last_vol_h24 REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'hot',
  dead_since INTEGER,
  source TEXT NOT NULL DEFAULT '',
  manual INTEGER NOT NULL DEFAULT 0,
  miss_count INTEGER NOT NULL DEFAULT 0,
  peak_vol_h1 REAL NOT NULL DEFAULT 0,
  peak_vol_at INTEGER,
  peak_price REAL NOT NULL DEFAULT 0,
  peak_price_at INTEGER,
  peak_mc REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pairs_peak ON pairs(peak_vol_h1);
CREATE INDEX IF NOT EXISTS idx_pairs_tier_refresh ON pairs(tier, last_refreshed_at);
CREATE INDEX IF NOT EXISTS idx_pairs_base ON pairs(base_address);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price_usd REAL,
  vol_h1 REAL NOT NULL DEFAULT 0,
  vol_h24 REAL NOT NULL DEFAULT 0,
  liquidity_usd REAL NOT NULL DEFAULT 0,
  buys_h1 INTEGER NOT NULL DEFAULT 0,
  sells_h1 INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON snapshots(pair_address, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  price_usd REAL,
  symbol TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  scam_score INTEGER NOT NULL DEFAULT 0,
  scam_reasons TEXT NOT NULL DEFAULT '',
  suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_kind_token_ts ON alerts(kind, token_address, ts);
CREATE TABLE IF NOT EXISTS pending_pairs (
  pair_address TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 既に bot.sqlite を持っている利用者のために、後から足した列を補う */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(alerts)").all() as unknown as { name: string }[]).map((c) => c.name),
    );
    const added: [string, string][] = [
      ["scam_score", "INTEGER NOT NULL DEFAULT 0"],
      ["scam_reasons", "TEXT NOT NULL DEFAULT ''"],
      ["suppressed", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, def] of added) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE alerts ADD COLUMN ${name} ${def}`);
    }

    const pairCols = new Set(
      (this.db.prepare("PRAGMA table_info(pairs)").all() as unknown as { name: string }[]).map((c) => c.name),
    );
    const peaks: [string, string][] = [
      ["peak_vol_h1", "REAL NOT NULL DEFAULT 0"],
      ["peak_vol_at", "INTEGER"],
      ["peak_price", "REAL NOT NULL DEFAULT 0"],
      ["peak_price_at", "INTEGER"],
      ["peak_mc", "REAL NOT NULL DEFAULT 0"],
    ];
    for (const [name, def] of peaks) {
      if (!pairCols.has(name)) this.db.exec(`ALTER TABLE pairs ADD COLUMN ${name} ${def}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /* ---------- kv ---------- */

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /* ---------- pairs ---------- */

  hasPair(pairAddress: string): boolean {
    const row = this.db.prepare("SELECT 1 AS x FROM pairs WHERE pair_address = ?").get(pairAddress.toLowerCase());
    return row !== undefined;
  }

  getPair(pairAddress: string): PairRow | null {
    return (this.db.prepare("SELECT * FROM pairs WHERE pair_address = ?").get(pairAddress.toLowerCase()) as PairRow | undefined) ?? null;
  }

  /** DexScreener のペア情報で upsert。戻り値は「新規追加されたか」 */
  upsertPair(p: DexPair, source: string, now: number, opts: { tier?: Tier; manual?: boolean } = {}): boolean {
    const addr = p.pairAddress.toLowerCase();
    const existed = this.hasPair(addr);
    const price = priceUsd(p);
    const liq = liquidityUsd(p);
    const h1 = vol(p, "h1");
    const h24 = vol(p, "h24");
    if (!existed) {
      this.db
        .prepare(
          `INSERT INTO pairs(pair_address, chain_id, dex_id, labels, base_address, base_symbol, base_name, quote_address, quote_symbol, url,
             pair_created_at, first_seen_at, last_refreshed_at, last_price_usd, last_liquidity_usd, last_vol_h1, last_vol_h24, tier, source, manual)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          addr,
          p.chainId,
          p.dexId ?? "",
          (p.labels ?? []).join(","),
          p.baseToken.address.toLowerCase(),
          p.baseToken.symbol ?? "",
          p.baseToken.name ?? "",
          (p.quoteToken?.address ?? "").toLowerCase(),
          p.quoteToken?.symbol ?? "",
          p.url ?? "",
          p.pairCreatedAt ?? null,
          now,
          now,
          price,
          liq,
          h1,
          h24,
          opts.tier ?? "hot",
          source,
          opts.manual ? 1 : 0,
        );
      this.recordPeak(addr, h1, price, p.marketCap ?? p.fdv ?? 0, now);
      return true;
    }
    this.db
      .prepare(
        `UPDATE pairs SET dex_id = ?, labels = ?, base_symbol = ?, base_name = ?, quote_address = ?, quote_symbol = ?, url = ?,
           pair_created_at = COALESCE(?, pair_created_at), last_refreshed_at = ?, last_price_usd = ?, last_liquidity_usd = ?,
           last_vol_h1 = ?, last_vol_h24 = ?, miss_count = 0,
           tier = COALESCE(?, tier), manual = CASE WHEN ? THEN 1 ELSE manual END
         WHERE pair_address = ?`,
      )
      .run(
        p.dexId ?? "",
        (p.labels ?? []).join(","),
        p.baseToken.symbol ?? "",
        p.baseToken.name ?? "",
        (p.quoteToken?.address ?? "").toLowerCase(),
        p.quoteToken?.symbol ?? "",
        p.url ?? "",
        p.pairCreatedAt ?? null,
        now,
        price,
        liq,
        h1,
        h24,
        opts.tier ?? null,
        opts.manual ? 1 : 0,
        addr,
      );
    this.recordPeak(addr, h1, price, p.marketCap ?? p.fdv ?? 0, now);
    return false;
  }

  /**
   * 全盛期を更新する。単調増加なので、スナップショットの保持期間を過ぎても
   * 「この銘柄はかつてどれだけ動いていたか」が残る。
   * 再点火の判定は、この履歴があるかどうかで確度が大きく変わる。
   */
  recordPeak(pairAddress: string, volH1: number, price: number | null, mc: number, now: number): void {
    // SQLite の UPDATE は全ての SET 式を更新前の行に対して評価するので、
    // 同じ文の中で「更新するか」と「いつ更新したか」を同時に判定できる。
    this.db
      .prepare(
        `UPDATE pairs SET
           peak_vol_at   = CASE WHEN ? > peak_vol_h1 THEN ? ELSE peak_vol_at END,
           peak_vol_h1   = CASE WHEN ? > peak_vol_h1 THEN ? ELSE peak_vol_h1 END,
           peak_price_at = CASE WHEN ? > peak_price  THEN ? ELSE peak_price_at END,
           peak_price    = CASE WHEN ? > peak_price  THEN ? ELSE peak_price END,
           peak_mc       = CASE WHEN ? > peak_mc     THEN ? ELSE peak_mc END
         WHERE pair_address = ?`,
      )
      .run(volH1, now, volH1, volH1, price ?? 0, now, price ?? 0, price ?? 0, mc, mc, pairAddress.toLowerCase());
  }

  /**
   * 全盛期が大きかった銘柄を、いま静かでも優先的に見に行く。
   * 「元大物のレンジ抜け」を早く掴むには、監視間隔そのものを短くする必要がある。
   */
  listPriorityForRefresh(minPeakVolUsd: number, staleBefore: number, limit: number): PairRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pairs
         WHERE peak_vol_h1 >= ? AND last_refreshed_at <= ? AND tier != 'dead'
         ORDER BY last_refreshed_at ASC LIMIT ?`,
      )
      .all(minPeakVolUsd, staleBefore, limit) as unknown as PairRow[];
  }

  countPriority(minPeakVolUsd: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pairs WHERE peak_vol_h1 >= ? AND tier != 'dead'")
      .get(minPeakVolUsd) as { n: number };
    return row.n;
  }

  setTier(pairAddress: string, tier: Tier, now: number): void {
    this.db
      .prepare(
        `UPDATE pairs SET tier = ?, dead_since = CASE WHEN ? = 'dead' THEN COALESCE(dead_since, ?) ELSE NULL END WHERE pair_address = ?`,
      )
      .run(tier, tier, now, pairAddress.toLowerCase());
  }

  setManual(pairAddress: string, manual: boolean): void {
    this.db.prepare("UPDATE pairs SET manual = ? WHERE pair_address = ?").run(manual ? 1 : 0, pairAddress.toLowerCase());
  }

  /** DexScreener が返さなかったペアの miss を記録し、更新時刻だけ進める */
  markMissed(pairAddress: string, now: number): void {
    this.db
      .prepare("UPDATE pairs SET miss_count = miss_count + 1, last_refreshed_at = ? WHERE pair_address = ?")
      .run(now, pairAddress.toLowerCase());
  }

  deletePair(pairAddress: string): void {
    const addr = pairAddress.toLowerCase();
    this.db.prepare("DELETE FROM pairs WHERE pair_address = ?").run(addr);
    this.db.prepare("DELETE FROM snapshots WHERE pair_address = ?").run(addr);
  }

  listPairsForRefresh(tier: Tier, staleBefore: number, limit: number): PairRow[] {
    return this.db
      .prepare("SELECT * FROM pairs WHERE tier = ? AND last_refreshed_at <= ? ORDER BY last_refreshed_at ASC LIMIT ?")
      .all(tier, staleBefore, limit) as unknown as PairRow[];
  }

  listPairsByToken(tokenAddress: string): PairRow[] {
    return this.db.prepare("SELECT * FROM pairs WHERE base_address = ?").all(tokenAddress.toLowerCase()) as unknown as PairRow[];
  }

  listTopByVolH1(limit: number): PairRow[] {
    return this.db.prepare("SELECT * FROM pairs ORDER BY last_vol_h1 DESC LIMIT ?").all(limit) as unknown as PairRow[];
  }

  listManual(): PairRow[] {
    return this.db.prepare("SELECT * FROM pairs WHERE manual = 1 ORDER BY last_vol_h1 DESC").all() as unknown as PairRow[];
  }

  listDeadOlderThan(deadBefore: number): PairRow[] {
    return this.db
      .prepare("SELECT * FROM pairs WHERE tier = 'dead' AND manual = 0 AND dead_since IS NOT NULL AND dead_since <= ?")
      .all(deadBefore) as unknown as PairRow[];
  }

  listStaleMissed(missCountAtLeast: number): PairRow[] {
    return this.db.prepare("SELECT * FROM pairs WHERE manual = 0 AND miss_count >= ?").all(missCountAtLeast) as unknown as PairRow[];
  }

  countByTier(): Record<Tier, number> {
    const rows = this.db.prepare("SELECT tier, COUNT(*) AS n FROM pairs GROUP BY tier").all() as { tier: Tier; n: number }[];
    const out: Record<Tier, number> = { hot: 0, dormant: 0, dead: 0 };
    for (const r of rows) out[r.tier] = r.n;
    return out;
  }

  countPairs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pairs").get() as { n: number };
    return row.n;
  }

  /* ---------- snapshots ---------- */

  insertSnapshot(p: DexPair, now: number): void {
    this.db
      .prepare(
        "INSERT INTO snapshots(pair_address, ts, price_usd, vol_h1, vol_h24, liquidity_usd, buys_h1, sells_h1) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(p.pairAddress.toLowerCase(), now, priceUsd(p), vol(p, "h1"), vol(p, "h24"), liquidityUsd(p), buys(p, "h1"), sells(p, "h1"));
  }

  /** 指定時刻以降のスナップショット中の最安値（価格欠損は除外） */
  minPriceSince(pairAddress: string, sinceTs: number): number | null {
    const row = this.db
      .prepare("SELECT MIN(price_usd) AS m FROM snapshots WHERE pair_address = ? AND ts >= ? AND price_usd IS NOT NULL AND price_usd > 0")
      .get(pairAddress.toLowerCase(), sinceTs) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /**
   * 「ヨコヨコがいつまで続いていたか」を測る。
   * いまと同程度に活発だった最後の時点を探し、その時刻を返す。
   * 見つからなければ null（＝保持期間のあいだずっと静かだった）。
   */
  lastActiveBefore(pairAddress: string, volThreshold: number, beforeTs: number): number | null {
    const row = this.db
      .prepare("SELECT MAX(ts) AS t FROM snapshots WHERE pair_address = ? AND ts < ? AND vol_h1 >= ?")
      .get(pairAddress.toLowerCase(), beforeTs, volThreshold) as { t: number | null } | undefined;
    return row?.t ?? null;
  }

  /** そのペアの最初のスナップショット時刻。観測履歴の長さを知るために使う */
  firstSnapshotAt(pairAddress: string): number | null {
    const row = this.db.prepare("SELECT MIN(ts) AS t FROM snapshots WHERE pair_address = ?").get(pairAddress.toLowerCase()) as
      | { t: number | null }
      | undefined;
    return row?.t ?? null;
  }

  /** 指定区間の最高値。「ヨコヨコのレンジ上限」を求めるために使う */
  maxPriceBetween(pairAddress: string, fromTs: number, toTs: number): number | null {
    const row = this.db
      .prepare("SELECT MAX(price_usd) AS m FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ? AND price_usd IS NOT NULL AND price_usd > 0")
      .get(pairAddress.toLowerCase(), fromTs, toTs) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /** 指定区間のスナップショット件数。レンジと呼べるだけの観測があるかの確認に使う */
  countSnapshotsBetween(pairAddress: string, fromTs: number, toTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ?")
      .get(pairAddress.toLowerCase(), fromTs, toTs) as { n: number };
    return row.n;
  }

  listSnapshots(pairAddress: string, sinceTs: number): SnapshotRow[] {
    return this.db
      .prepare("SELECT ts, price_usd, vol_h1, vol_h24, liquidity_usd, buys_h1, sells_h1 FROM snapshots WHERE pair_address = ? AND ts >= ? ORDER BY ts ASC")
      .all(pairAddress.toLowerCase(), sinceTs) as unknown as SnapshotRow[];
  }

  pruneSnapshots(beforeTs: number): number {
    const res = this.db.prepare("DELETE FROM snapshots WHERE ts < ?").run(beforeTs);
    return Number(res.changes);
  }

  /* ---------- alerts ---------- */

  lastAlert(kind: AlertKind, tokenAddress: string): AlertRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM alerts WHERE kind = ? AND token_address = ? AND suppressed = 0 ORDER BY ts DESC LIMIT 1")
        .get(kind, tokenAddress.toLowerCase()) as AlertRow | undefined) ?? null
    );
  }

  insertAlert(a: Omit<AlertRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO alerts(kind, token_address, pair_address, ts, level, price_usd, symbol, summary, scam_score, scam_reasons, suppressed)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.kind,
        a.token_address.toLowerCase(),
        a.pair_address.toLowerCase(),
        a.ts,
        a.level,
        a.price_usd,
        a.symbol,
        a.summary,
        a.scam_score,
        a.scam_reasons,
        a.suppressed,
      );
  }

  recentAlerts(limit: number): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE suppressed = 0 ORDER BY ts DESC LIMIT ?").all(limit) as unknown as AlertRow[];
  }

  /** スキャム判定で止めたもの。フィルタが効きすぎていないか確認するために使う */
  recentSuppressed(limit: number): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE suppressed = 1 ORDER BY ts DESC LIMIT ?").all(limit) as unknown as AlertRow[];
  }

  countSuppressedSince(sinceTs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE suppressed = 1 AND ts >= ?").get(sinceTs) as { n: number };
    return row.n;
  }

  countAlertsSince(sinceTs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE suppressed = 0 AND ts >= ?").get(sinceTs) as { n: number };
    return row.n;
  }

  /* ---------- pending (RPC で見つけたが DexScreener 未反映) ---------- */

  addPending(pairAddress: string, source: string, now: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO pending_pairs(pair_address, source, first_seen_at, attempts) VALUES(?, ?, ?, 0)")
      .run(pairAddress.toLowerCase(), source, now);
  }

  listPending(limit: number): PendingRow[] {
    return this.db.prepare("SELECT * FROM pending_pairs ORDER BY first_seen_at ASC LIMIT ?").all(limit) as unknown as PendingRow[];
  }

  bumpPending(pairAddress: string): void {
    this.db.prepare("UPDATE pending_pairs SET attempts = attempts + 1 WHERE pair_address = ?").run(pairAddress.toLowerCase());
  }

  removePending(pairAddress: string): void {
    this.db.prepare("DELETE FROM pending_pairs WHERE pair_address = ?").run(pairAddress.toLowerCase());
  }

  countPending(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pending_pairs").get() as { n: number };
    return row.n;
  }
}
