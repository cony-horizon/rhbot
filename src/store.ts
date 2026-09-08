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
  /** この銘柄が記録した最高時価総額＝全盛期の評価額 */
  peak_mc: number;
  peak_mc_at: number | null;
}

export interface SnapshotRow {
  ts: number;
  price_usd: number | null;
  market_cap: number;
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
  /** 通知時点の時価総額 */
  mc_usd: number;
  /** 成立経路。new / reignite / dormant / breakout / fast */
  trigger: string;
  vol_h1: number;
  buys_h1: number;
  sells_h1: number;
  /** 通知時点でのペア年齢（時間） */
  age_hours: number | null;
}

/** 通知のその後。スナップショットから機械的に埋める */
export interface OutcomeRow {
  alert_id: number;
  alert_ts: number;
  base_price: number;
  p15m: number | null;
  p1h: number | null;
  p4h: number | null;
  p24h: number | null;
  max_gain_pct: number | null;
  max_gain_at: number | null;
  max_dd_pct: number | null;
  /** どの地平まで確定したか（ms）。24h で完了 */
  done_until: number;
  /** 4h 以内に HIT_PCT 以上 → 1、届かず → 0、未確定 → null */
  hit: number | null;
  bust: number | null;
}

export interface WalletRow {
  address: string;
  /** 早期に入っていた勝ち銘柄の数（銘柄単位） */
  hits: number;
  buys: number;
  quote_volume: number;
  first_seen: number;
  last_seen: number;
}

export interface WalletBuyRow {
  id: number;
  wallet: string;
  token_address: string;
  pair_address: string;
  alert_id: number;
  symbol: string;
  ts: number;
  block: number;
  quote_amount: number;
  tx_hash: string;
}

export interface DailyReportRow {
  date: string;
  ts: number;
  alerts: number;
  hits: number;
  hit_rate: number | null;
  text: string;
}

export interface PendingRow {
  pair_address: string;
  source: string;
  first_seen_at: number;
  attempts: number;
}

/**
 * 索引は表の定義とは分けて持ち、移行処理の「後」に張る。
 * 同じ文字列に混ぜると、既存 DB に対して「まだ追加していない列」へ索引を張ろうとして落ちる。
 * （peak_mc を足したときに実際に起きた）
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_pairs_peak ON pairs(peak_mc);
CREATE INDEX IF NOT EXISTS idx_pairs_tier_refresh ON pairs(tier, last_refreshed_at);
CREATE INDEX IF NOT EXISTS idx_pairs_base ON pairs(base_address);
CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON snapshots(pair_address, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_kind_token_ts ON alerts(kind, token_address, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
CREATE INDEX IF NOT EXISTS idx_wallets_hits ON wallets(hits DESC, quote_volume DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_buys_wallet ON wallet_buys(wallet);
`;

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
  peak_mc REAL NOT NULL DEFAULT 0,
  peak_mc_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price_usd REAL,
  market_cap REAL NOT NULL DEFAULT 0,
  vol_h1 REAL NOT NULL DEFAULT 0,
  vol_h24 REAL NOT NULL DEFAULT 0,
  liquidity_usd REAL NOT NULL DEFAULT 0,
  buys_h1 INTEGER NOT NULL DEFAULT 0,
  sells_h1 INTEGER NOT NULL DEFAULT 0
);
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
  suppressed INTEGER NOT NULL DEFAULT 0,
  mc_usd REAL NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT '',
  vol_h1 REAL NOT NULL DEFAULT 0,
  buys_h1 INTEGER NOT NULL DEFAULT 0,
  sells_h1 INTEGER NOT NULL DEFAULT 0,
  age_hours REAL
);
CREATE TABLE IF NOT EXISTS alert_outcomes (
  alert_id INTEGER PRIMARY KEY,
  alert_ts INTEGER NOT NULL,
  base_price REAL NOT NULL,
  p15m REAL, p1h REAL, p4h REAL, p24h REAL,
  max_gain_pct REAL, max_gain_at INTEGER, max_dd_pct REAL,
  done_until INTEGER NOT NULL DEFAULT 0,
  hit INTEGER, bust INTEGER
);
CREATE TABLE IF NOT EXISTS daily_reports (
  date TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  alerts INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  hit_rate REAL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  buys INTEGER NOT NULL DEFAULT 0,
  quote_volume REAL NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_buys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  alert_id INTEGER NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  block INTEGER NOT NULL,
  quote_amount REAL NOT NULL DEFAULT 0,
  tx_hash TEXT NOT NULL,
  UNIQUE(tx_hash, wallet, token_address)
);
CREATE TABLE IF NOT EXISTS harvests (
  alert_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  swaps INTEGER NOT NULL DEFAULT 0,
  buyers INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
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
    // 表 → 列の移行 → 索引 の順に流す。この順序でないと、
    // 既存 DB で「これから追加する列」に索引を張ろうとして失敗する
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(INDEXES);
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
      ["mc_usd", "REAL NOT NULL DEFAULT 0"],
      ["trigger", "TEXT NOT NULL DEFAULT ''"],
      ["vol_h1", "REAL NOT NULL DEFAULT 0"],
      ["buys_h1", "INTEGER NOT NULL DEFAULT 0"],
      ["sells_h1", "INTEGER NOT NULL DEFAULT 0"],
      ["age_hours", "REAL"],
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
      ["peak_mc_at", "INTEGER"],
    ];
    for (const [name, def] of peaks) {
      if (!pairCols.has(name)) this.db.exec(`ALTER TABLE pairs ADD COLUMN ${name} ${def}`);
    }

    const snapCols = new Set(
      (this.db.prepare("PRAGMA table_info(snapshots)").all() as unknown as { name: string }[]).map((c) => c.name),
    );
    if (!snapCols.has("market_cap")) this.db.exec("ALTER TABLE snapshots ADD COLUMN market_cap REAL NOT NULL DEFAULT 0");
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
           peak_mc_at    = CASE WHEN ? > peak_mc     THEN ? ELSE peak_mc_at END,
           peak_mc       = CASE WHEN ? > peak_mc     THEN ? ELSE peak_mc END
         WHERE pair_address = ?`,
      )
      .run(volH1, now, volH1, volH1, price ?? 0, now, price ?? 0, price ?? 0, mc, now, mc, mc, pairAddress.toLowerCase());
  }

  /**
   * 全盛期が大きかった銘柄を、いま静かでも優先的に見に行く。
   * 「元大物のレンジ抜け」を早く掴むには、監視間隔そのものを短くする必要がある。
   */
  listPriorityForRefresh(minPeakMcUsd: number, staleBefore: number, limit: number): PairRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pairs
         WHERE peak_mc >= ? AND last_refreshed_at <= ? AND tier != 'dead'
         ORDER BY last_refreshed_at ASC LIMIT ?`,
      )
      .all(minPeakMcUsd, staleBefore, limit) as unknown as PairRow[];
  }

  countPriority(minPeakMcUsd: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pairs WHERE peak_mc >= ? AND tier != 'dead'")
      .get(minPeakMcUsd) as { n: number };
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

  /**
   * 再点火を待っている銘柄の母集団。
   * 「かつて大きな時価総額をつけた」か「手動で監視に入れた」もの。
   * ヨコヨコを組んでいるかどうかはスナップショットを見ないと分からないので、
   * ここでは候補を絞るところまでを担う。
   */
  listRangeCandidates(minPeakMc: number, limit: number): PairRow[] {
    return this.db
      .prepare("SELECT * FROM pairs WHERE peak_mc >= ? OR manual = 1 ORDER BY peak_mc DESC LIMIT ?")
      .all(minPeakMc, limit) as unknown as PairRow[];
  }

  /** 直近のスナップショットの時価総額。pairs 表には現在値を持たせていないため */
  latestMc(pairAddress: string): number | null {
    const row = this.db
      .prepare("SELECT market_cap AS m FROM snapshots WHERE pair_address = ? AND market_cap > 0 ORDER BY ts DESC LIMIT 1")
      .get(pairAddress.toLowerCase()) as { m: number } | undefined;
    return row?.m ?? null;
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
        "INSERT INTO snapshots(pair_address, ts, price_usd, market_cap, vol_h1, vol_h24, liquidity_usd, buys_h1, sells_h1) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        p.pairAddress.toLowerCase(),
        now,
        priceUsd(p),
        p.marketCap ?? p.fdv ?? 0,
        vol(p, "h1"),
        vol(p, "h24"),
        liquidityUsd(p),
        buys(p, "h1"),
        sells(p, "h1"),
      );
  }

  /**
   * 指定区間の時価総額の上下と、観測の広がりをまとめて返す。
   * 「レンジを組んでいるか」を判定するには最大値だけでは足りず、
   * 下限・観測期間・件数を揃えて見る必要がある。
   */
  mcRangeBetween(
    pairAddress: string,
    fromTs: number,
    toTs: number,
  ): { high: number; low: number; samples: number; firstTs: number; lastTs: number } | null {
    const row = this.db
      .prepare(
        `SELECT MAX(market_cap) AS hi, MIN(market_cap) AS lo, COUNT(*) AS n, MIN(ts) AS t0, MAX(ts) AS t1
         FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ? AND market_cap > 0`,
      )
      .get(pairAddress.toLowerCase(), fromTs, toTs) as
      | { hi: number | null; lo: number | null; n: number; t0: number | null; t1: number | null }
      | undefined;
    if (!row || row.hi === null || row.lo === null || row.lo <= 0 || row.t0 === null || row.t1 === null) return null;
    return { high: row.hi, low: row.lo, samples: row.n, firstTs: row.t0, lastTs: row.t1 };
  }

  /** 指定区間の最高時価総額。ヨコヨコのレンジ上限を時価総額で測るために使う */
  maxMcBetween(pairAddress: string, fromTs: number, toTs: number): number | null {
    const row = this.db
      .prepare("SELECT MAX(market_cap) AS m FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ? AND market_cap > 0")
      .get(pairAddress.toLowerCase(), fromTs, toTs) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /** 指定時刻以降の最低時価総額＝ヨコヨコの底 */
  minMcSince(pairAddress: string, sinceTs: number): number | null {
    const row = this.db
      .prepare("SELECT MIN(market_cap) AS m FROM snapshots WHERE pair_address = ? AND ts >= ? AND market_cap > 0")
      .get(pairAddress.toLowerCase(), sinceTs) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /** 時価総額が取れているスナップショットの件数。レンジと呼べる観測があるかの確認に使う */
  countMcSnapshotsBetween(pairAddress: string, fromTs: number, toTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ? AND market_cap > 0")
      .get(pairAddress.toLowerCase(), fromTs, toTs) as { n: number };
    return row.n;
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

  /** 指定区間の価格の上下と観測の広がり。時価総額が取れない銘柄向けの代替 */
  priceRangeBetween(
    pairAddress: string,
    fromTs: number,
    toTs: number,
  ): { high: number; low: number; samples: number; firstTs: number; lastTs: number } | null {
    const row = this.db
      .prepare(
        `SELECT MAX(price_usd) AS hi, MIN(price_usd) AS lo, COUNT(*) AS n, MIN(ts) AS t0, MAX(ts) AS t1
         FROM snapshots WHERE pair_address = ? AND ts >= ? AND ts <= ? AND price_usd IS NOT NULL AND price_usd > 0`,
      )
      .get(pairAddress.toLowerCase(), fromTs, toTs) as
      | { hi: number | null; lo: number | null; n: number; t0: number | null; t1: number | null }
      | undefined;
    if (!row || row.hi === null || row.lo === null || row.lo <= 0 || row.t0 === null || row.t1 === null) return null;
    return { high: row.hi, low: row.lo, samples: row.n, firstTs: row.t0, lastTs: row.t1 };
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
      .prepare("SELECT ts, price_usd, market_cap, vol_h1, vol_h24, liquidity_usd, buys_h1, sells_h1 FROM snapshots WHERE pair_address = ? AND ts >= ? ORDER BY ts ASC")
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

  insertAlert(a: Omit<AlertRow, "id">): number {
    const res = this.db
      .prepare(
        `INSERT INTO alerts(kind, token_address, pair_address, ts, level, price_usd, symbol, summary, scam_score, scam_reasons, suppressed,
                            mc_usd, trigger, vol_h1, buys_h1, sells_h1, age_hours)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        a.mc_usd,
        a.trigger,
        a.vol_h1,
        a.buys_h1,
        a.sells_h1,
        a.age_hours,
      );
    return Number(res.lastInsertRowid);
  }

  getAlert(id: number): AlertRow | null {
    return (this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | undefined) ?? null;
  }

  /* ---------- 通知のその後（結果追跡） ---------- */

  /**
   * 結果をまだ確定しきっていない通知。
   * 15 分経過したものから対象にし、24h の地平まで埋まったら卒業する。
   * 通知しなかった（止めた）ものも含める。止めた中の逸材を知ることがフィルタ調整の材料になる。
   */
  listAlertsNeedingOutcome(now: number, maxAgeMs: number): (AlertRow & { done_until: number | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, o.done_until AS done_until
         FROM alerts a LEFT JOIN alert_outcomes o ON o.alert_id = a.id
         WHERE a.ts <= ? AND a.ts >= ? AND a.price_usd IS NOT NULL AND a.price_usd > 0
           AND (o.done_until IS NULL OR o.done_until < ?)
         ORDER BY a.ts ASC LIMIT 500`,
      )
      .all(now - 15 * 60_000, now - maxAgeMs, 24 * 3_600_000) as unknown as (AlertRow & { done_until: number | null })[];
  }

  /** 指定時刻に最も近いスナップショットの価格（許容範囲内に無ければ null） */
  /**
   * @param minLiquidity この額未満の流動性しか無い時点の価格は無視する。
   *   プールが枯れた銘柄は DexScreener が最後の約定価格を返し続けるので、
   *   放っておくと「+39741% で 4 時間保った」ように見える。売れない価格は価格ではない。
   */
  priceNear(pairAddress: string, ts: number, beforeMs: number, afterMs: number, minLiquidity = 0): number | null {
    const row = this.db
      .prepare(
        `SELECT price_usd FROM snapshots
         WHERE pair_address = ? AND ts BETWEEN ? AND ? AND price_usd IS NOT NULL AND price_usd > 0 AND liquidity_usd >= ?
         ORDER BY ABS(ts - ?) ASC LIMIT 1`,
      )
      .get(pairAddress.toLowerCase(), ts - beforeMs, ts + afterMs, minLiquidity, ts) as { price_usd: number } | undefined;
    return row?.price_usd ?? null;
  }

  /**
   * 区間内の最高値・最安値と、最高値をつけた時刻。
   *
   * 最高値だけ流動性で絞る。利益は売れて初めて実現するが、損失は流動性が抜かれた時点で確定するので、
   * 最安値まで絞るとラグを「無かったこと」にしてしまう。
   */
  priceExtremesBetween(pairAddress: string, fromTs: number, toTs: number, minLiquidity = 0): { max: number | null; min: number; maxTs: number | null } | null {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT MAX(price_usd) FROM snapshots WHERE pair_address = ? AND ts > ? AND ts <= ? AND price_usd > 0 AND liquidity_usd >= ?) AS mx,
           (SELECT MIN(price_usd) FROM snapshots WHERE pair_address = ? AND ts > ? AND ts <= ? AND price_usd > 0) AS mn`,
      )
      .get(pairAddress.toLowerCase(), fromTs, toTs, minLiquidity, pairAddress.toLowerCase(), fromTs, toTs) as
      | { mx: number | null; mn: number | null }
      | undefined;
    // 売れる価格が一つも無くても（流動性が抜かれた直後など）最安値は返す。損失はそこで確定している
    if (!row || row.mn === null) return null;
    if (row.mx === null) return { max: null, min: row.mn, maxTs: null };
    const at = this.db
      .prepare("SELECT ts FROM snapshots WHERE pair_address = ? AND ts > ? AND ts <= ? AND price_usd = ? AND liquidity_usd >= ? ORDER BY ts ASC LIMIT 1")
      .get(pairAddress.toLowerCase(), fromTs, toTs, row.mx, minLiquidity) as { ts: number } | undefined;
    return { max: row.mx, min: row.mn, maxTs: at?.ts ?? toTs };
  }

  upsertOutcome(o: OutcomeRow): void {
    this.db
      .prepare(
        `INSERT INTO alert_outcomes(alert_id, alert_ts, base_price, p15m, p1h, p4h, p24h, max_gain_pct, max_gain_at, max_dd_pct, done_until, hit, bust)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alert_id) DO UPDATE SET
           p15m = excluded.p15m, p1h = excluded.p1h, p4h = excluded.p4h, p24h = excluded.p24h,
           max_gain_pct = excluded.max_gain_pct, max_gain_at = excluded.max_gain_at, max_dd_pct = excluded.max_dd_pct,
           done_until = excluded.done_until, hit = excluded.hit, bust = excluded.bust`,
      )
      .run(o.alert_id, o.alert_ts, o.base_price, o.p15m, o.p1h, o.p4h, o.p24h, o.max_gain_pct, o.max_gain_at, o.max_dd_pct, o.done_until, o.hit, o.bust);
  }

  getOutcome(alertId: number): OutcomeRow | null {
    return (this.db.prepare("SELECT * FROM alert_outcomes WHERE alert_id = ?").get(alertId) as OutcomeRow | undefined) ?? null;
  }

  /** 期間内の通知と結果を結合して返す（レポート用） */
  listAlertsWithOutcomes(fromTs: number, toTs: number): (AlertRow & Partial<OutcomeRow>)[] {
    return this.db
      .prepare(
        `SELECT a.*, o.base_price, o.p15m, o.p1h, o.p4h, o.p24h, o.max_gain_pct, o.max_gain_at, o.max_dd_pct, o.done_until, o.hit, o.bust
         FROM alerts a LEFT JOIN alert_outcomes o ON o.alert_id = a.id
         WHERE a.ts >= ? AND a.ts < ? ORDER BY a.ts ASC`,
      )
      .all(fromTs, toTs) as unknown as (AlertRow & Partial<OutcomeRow>)[];
  }

  saveDailyReport(r: DailyReportRow): void {
    this.db
      .prepare(
        `INSERT INTO daily_reports(date, ts, alerts, hits, hit_rate, text) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, alerts = excluded.alerts, hits = excluded.hits, hit_rate = excluded.hit_rate, text = excluded.text`,
      )
      .run(r.date, r.ts, r.alerts, r.hits, r.hit_rate, r.text);
  }

  getDailyReport(date: string): DailyReportRow | null {
    return (this.db.prepare("SELECT * FROM daily_reports WHERE date = ?").get(date) as DailyReportRow | undefined) ?? null;
  }

  recentDailyReports(limit: number): DailyReportRow[] {
    return this.db.prepare("SELECT * FROM daily_reports ORDER BY date DESC LIMIT ?").all(limit) as unknown as DailyReportRow[];
  }

  /* ---------- スマートウォレット ---------- */

  /** 収穫の要否。勝ちと確定した復活系の通知で、まだ収穫していないもの */
  listAlertsToHarvest(limit: number): (AlertRow & { hit: number })[] {
    return this.db
      .prepare(
        `SELECT a.*, o.hit AS hit FROM alerts a
         JOIN alert_outcomes o ON o.alert_id = a.id
         LEFT JOIN harvests h ON h.alert_id = a.id
         WHERE a.kind = 'revival' AND o.hit = 1 AND h.alert_id IS NULL
         ORDER BY a.ts DESC LIMIT ?`,
      )
      .all(limit) as unknown as (AlertRow & { hit: number })[];
  }

  markHarvest(alertId: number, now: number, status: string, swaps: number, buyers: number, note = ""): void {
    this.db
      .prepare(
        `INSERT INTO harvests(alert_id, ts, status, swaps, buyers, note) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(alert_id) DO UPDATE SET ts = excluded.ts, status = excluded.status, swaps = excluded.swaps, buyers = excluded.buyers, note = excluded.note`,
      )
      .run(alertId, now, status, swaps, buyers, note);
  }

  /** 買いの記録を追加し、触れたウォレットの集計を更新する。戻り値は新規に記録できた件数 */
  recordWalletBuys(rows: Omit<WalletBuyRow, "id">[]): number {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO wallet_buys(wallet, token_address, pair_address, alert_id, symbol, ts, block, quote_amount, tx_hash)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    const touched = new Set<string>();
    for (const r of rows) {
      const res = ins.run(r.wallet.toLowerCase(), r.token_address.toLowerCase(), r.pair_address.toLowerCase(), r.alert_id, r.symbol, r.ts, r.block, r.quote_amount, r.tx_hash.toLowerCase());
      if (Number(res.changes) > 0) added++;
      touched.add(r.wallet.toLowerCase());
    }
    for (const w of touched) this.refreshWallet(w);
    return added;
  }

  /** wallet_buys から 1 ウォレットの集計をやり直す（hits は銘柄単位で数える） */
  refreshWallet(address: string): void {
    const agg = this.db
      .prepare(
        `SELECT COUNT(DISTINCT token_address) AS hits, COUNT(*) AS buys, COALESCE(SUM(quote_amount), 0) AS qv,
                MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM wallet_buys WHERE wallet = ?`,
      )
      .get(address.toLowerCase()) as { hits: number; buys: number; qv: number; first_seen: number | null; last_seen: number | null };
    if (!agg.first_seen || !agg.last_seen) return;
    this.db
      .prepare(
        `INSERT INTO wallets(address, hits, buys, quote_volume, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET hits = excluded.hits, buys = excluded.buys, quote_volume = excluded.quote_volume,
           first_seen = excluded.first_seen, last_seen = excluded.last_seen`,
      )
      .run(address.toLowerCase(), agg.hits, agg.buys, agg.qv, agg.first_seen, agg.last_seen);
  }

  topWallets(limit: number, minHits = 1): WalletRow[] {
    return this.db
      .prepare("SELECT * FROM wallets WHERE hits >= ? ORDER BY hits DESC, quote_volume DESC LIMIT ?")
      .all(minHits, limit) as unknown as WalletRow[];
  }

  getWallet(address: string): WalletRow | null {
    return (this.db.prepare("SELECT * FROM wallets WHERE address = ?").get(address.toLowerCase()) as WalletRow | undefined) ?? null;
  }

  walletBuys(address: string, limit = 30): WalletBuyRow[] {
    return this.db
      .prepare("SELECT * FROM wallet_buys WHERE wallet = ? ORDER BY ts DESC LIMIT ?")
      .all(address.toLowerCase(), limit) as unknown as WalletBuyRow[];
  }

  countWallets(minHits: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM wallets WHERE hits >= ?").get(minHits) as { n: number };
    return row.n;
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
