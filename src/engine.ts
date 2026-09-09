import type { Config } from "./config.js";
import { DexScreenerClient, liquidityUsd, pairAgeMs, priceUsd, vol, type DexPair } from "./dexscreener.js";
import { detectNewLaunch } from "./detectors/newLaunch.js";
import { detectRevival } from "./detectors/revival.js";
import { assessScam, formatScamSummary, type ScamAssessment } from "./detectors/scam.js";
import { candidateWindows, findLongestRange, toRange, type RangeInfo } from "./detectors/range.js";
import type { Detection } from "./detectors/types.js";
import { baseMetrics, HOUR_MS, MINUTE_MS } from "./detectors/common.js";
import { formatAlert, type AlertViewOptions } from "./format.js";
import { log } from "./logger.js";
import { PoolScanner, RpcClient } from "./rpc.js";
import type { AlertRow, EarlyBuyer, PairRow, Store, Tier } from "./store.js";
import { buildDailyReport, computeOutcomes, jst } from "./outcomes.js";
import { SwapHarvester, type HarvestResult } from "./smartwallets.js";

/** discovery が何回続けて空振りしたら利用者に知らせるか */
const HEALTH_EMPTY_THRESHOLD = 5;
/** 同じ警告を繰り返さない間隔 */
const HEALTH_WARN_COOLDOWN_MS = 6 * 3_600_000;

/** ヨコヨコ監視中の 1 銘柄（/ranges 用） */
export interface RangeWatch {
  row: PairRow;
  range: RangeInfo;
  currentMc: number;
  /** ここを超えたら再点火の通知が出る時価総額 */
  triggerMc: number;
  /** 上抜けまであと何 %。負なら既に条件を満たしている */
  toBreakoutPct: number;
  /** 帯の中でどの位置にいるか。0 = 下限、100 = 上限 */
  posInRangePct: number;
  /** 全盛期に対する現在の時価総額の比 */
  cooledRatio: number | null;
  /** 全盛期 MC と冷え込みの条件を満たし、あとは上抜けを待つだけか */
  primed: boolean;
}

export type HarvestTokenResult =
  | { ok: false; reason: string }
  | { ok: true; pair: PairRow; alert: AlertRow; hours: number; result: HarvestResult; tagged: number; buyers: EarlyBuyer[] };

export interface RangeWindowCheck {
  hours: number;
  ok: boolean;
  why: string;
}

/** /ranges <address> の診断結果 */
export interface RangeDiagnosis {
  row: PairRow;
  /** 全盛期 MC が門を超えているか */
  peakOk: boolean;
  /** 一覧の母集団に入っているか（門を超えるか手動） */
  inCandidates: boolean;
  currentMc: number | null;
  cooledRatio: number | null;
  cooled: boolean;
  range: RangeInfo | null;
  /** 長い窓から順に試した結果 */
  windows: RangeWindowCheck[];
  triggerMc: number | null;
  toBreakoutPct: number | null;
  /** 条件が全部揃い、あとは上抜けを待つだけか */
  primed: boolean;
}

export interface AlertSink {
  broadcast(html: string): Promise<void>;
}

export interface EngineStats {
  lastDiscoveryAt: number | null;
  lastDiscoveryAdded: number;
  lastRpcBlock: number | null;
  rpcEventsTotal: number;
  alertsSent: number;
  /** スキャム判定で止めた通知の数 */
  alertsSuppressed: number;
  refreshCounts: Record<Tier, number>;
  /** 対象チェーンのペアを 1 件も取得できなかった discovery の連続回数 */
  emptyDiscoveries: number;
  lastHealthWarningAt: number | null;
}

/** 発見・更新・検知・通知のコアロジック。スケジューリングは index.ts が担当 */
export class Engine {
  readonly stats: EngineStats = {
    lastDiscoveryAt: null,
    lastDiscoveryAdded: 0,
    lastRpcBlock: null,
    rpcEventsTotal: 0,
    alertsSent: 0,
    alertsSuppressed: 0,
    refreshCounts: { hot: 0, dormant: 0, dead: 0 },
    emptyDiscoveries: 0,
    lastHealthWarningAt: null,
  };
  private mutedUntil = 0;
  /** 通知の見せ方に関わる設定をまとめたもの */
  private readonly view: AlertViewOptions;
  /** RPC がある場合だけ、勝ち銘柄の早期買いウォレットを収穫する */
  private readonly harvester: SwapHarvester | null;
  private readonly scanner: PoolScanner | null;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly dex: DexScreenerClient,
    private readonly sink: AlertSink,
    rpc: RpcClient | null,
    private readonly now: () => number = Date.now,
  ) {
    this.view = {
      volLevelMidUsd: cfg.volLevelMidUsd,
      volLevelHighUsd: cfg.volLevelHighUsd,
      txnSkewShow: cfg.txnSkewShow,
      scamShowScoreFrom: cfg.scamShowScoreFrom,
    };
    this.harvester = rpc && cfg.smartWalletEnabled ? new SwapHarvester(rpc, store, cfg) : null;
    this.scanner = rpc
      ? new PoolScanner(
          rpc,
          {
            getLastBlock: () => {
              const v = store.getKv("rpc_last_block");
              return v === null ? null : Number(v);
            },
            setLastBlock: (n) => store.setKv("rpc_last_block", String(n)),
          },
          { blockChunk: cfg.rpcBlockChunk, backfillBlocks: cfg.rpcBackfillBlocks, factoryAddresses: cfg.rpcFactoryAddresses },
        )
      : null;
  }

  mute(minutes: number): void {
    this.mutedUntil = this.now() + minutes * MINUTE_MS;
  }
  unmute(): void {
    this.mutedUntil = 0;
  }
  isMuted(): boolean {
    return this.now() < this.mutedUntil;
  }
  mutedRemainingMin(): number {
    return Math.max(0, Math.ceil((this.mutedUntil - this.now()) / MINUTE_MS));
  }

  /* ---------------- 発見 ---------------- */

  /** DexScreener 検索 / トークンプール / プロフィール・ブーストから監視対象を追加 */
  async discover(): Promise<number> {
    const now = this.now();
    let added = 0;
    const seen = new Map<string, DexPair>();
    const collect = (pairs: DexPair[]) => {
      for (const p of pairs) {
        if (p.chainId !== this.cfg.chainId) continue;
        if (!p.pairAddress || !p.baseToken?.address) continue;
        seen.set(p.pairAddress.toLowerCase(), p);
      }
    };

    for (const q of this.cfg.discoverySearchQueries) {
      try {
        collect(await this.dex.search(q));
      } catch (err) {
        log.warn(`search("${q}") 失敗`, err);
      }
    }
    for (const t of this.cfg.discoveryTokenAddresses) {
      try {
        collect(await this.dex.getTokenPools(this.cfg.chainId, t));
      } catch (err) {
        log.warn(`token-pairs(${t}) 失敗`, err);
      }
    }
    if (this.cfg.discoveryUseProfiles) {
      const tokenAddrs = new Set<string>();
      for (const fn of [() => this.dex.latestTokenProfiles(), () => this.dex.latestBoosts(), () => this.dex.topBoosts()]) {
        try {
          for (const tp of await fn()) if (tp.chainId === this.cfg.chainId && tp.tokenAddress) tokenAddrs.add(tp.tokenAddress);
        } catch (err) {
          log.warn("token-profiles/boosts 取得失敗", err);
        }
      }
      if (tokenAddrs.size > 0) {
        try {
          collect(await this.dex.getTokens(this.cfg.chainId, [...tokenAddrs]));
        } catch (err) {
          log.warn("tokens/v1 取得失敗", err);
        }
      }
    }

    // 取得したデータは新規・既存を問わず必ず反映して検知にかける。
    // 既存ペアを素通りさせると upsertPair が last_refreshed_at を進めてしまい、
    // refreshTier がそのペアを「更新済み」と見なして永久に評価しなくなる
    // （＝検索上位に居座る＝いちばんスパイクしやすいペアほど取りこぼす）。
    for (const p of seen.values()) {
      const isNew = this.store.upsertPair(p, "discovery", now);
      if (isNew) added++;
      this.store.insertSnapshot(p, now);
      this.classify(p, now);
      await this.evaluate(p, now);
    }
    this.stats.lastDiscoveryAt = now;
    this.stats.lastDiscoveryAdded = added;
    this.stats.emptyDiscoveries = seen.size === 0 ? this.stats.emptyDiscoveries + 1 : 0;
    log.info(`discovery: ${seen.size} ペア取得, ${added} 件を新規追加 (合計 ${this.store.countPairs()})`);
    await this.checkHealth(now);
    return added;
  }

  /**
   * 「通知が来ない」が正常（市場が静か）なのか異常（設定ミスや API 変更）なのかは
   * 利用者から見分けがつかないため、明らかにおかしいときはボット自身に言わせる。
   */
  async checkHealth(now: number): Promise<void> {
    if (this.stats.emptyDiscoveries < HEALTH_EMPTY_THRESHOLD) return;
    if (this.stats.lastHealthWarningAt !== null && now - this.stats.lastHealthWarningAt < HEALTH_WARN_COOLDOWN_MS) return;
    this.stats.lastHealthWarningAt = now;
    const msg = [
      "⚠️ <b>監視対象が 1 件も見つかりません</b>",
      "",
      `DexScreener から chainId=<code>${this.cfg.chainId}</code> のペアを ${this.stats.emptyDiscoveries} 回連続で取得できませんでした。`,
      "設定か、DexScreener 側のチェーン名が変わった可能性があります。",
      "",
      "確認方法: ターミナルで <code>npm run probe</code> を実行し、",
      "表示された chainId が <code>.env</code> の <code>CHAIN_ID</code> と一致しているか見てください。",
    ].join("\n");
    try {
      await this.sink.broadcast(msg);
      log.warn(`健全性警告を送信: ${this.stats.emptyDiscoveries} 回連続で 0 件`);
    } catch (err) {
      log.error("健全性警告の送信に失敗", err);
    }
  }

  /** RPC のファクトリイベントから新規プールを拾い、pending に積む */
  async scanRpc(): Promise<number> {
    if (!this.scanner) return 0;
    const now = this.now();
    const events = await this.scanner.tick();
    const v = this.store.getKv("rpc_last_block");
    this.stats.lastRpcBlock = v === null ? null : Number(v);
    for (const ev of events) {
      if (this.store.hasPair(ev.poolAddress)) continue;
      this.store.addPending(ev.poolAddress, `rpc:${ev.kind}`, now);
      log.info(`RPC: 新規プール ${ev.kind} ${ev.poolAddress} (block ${ev.blockNumber})`);
    }
    this.stats.rpcEventsTotal += events.length;
    return events.length;
  }

  /** pending のプールを DexScreener で解決（インデックス反映待ち） */
  async resolvePending(maxAttempts = 360): Promise<number> {
    const now = this.now();
    const rows = this.store.listPending(90);
    if (rows.length === 0) return 0;
    const found = await this.dex.getPairs(
      this.cfg.chainId,
      rows.map((r) => r.pair_address),
    );
    const byAddr = new Map(found.map((p) => [p.pairAddress.toLowerCase(), p]));
    let resolved = 0;
    for (const r of rows) {
      const p = byAddr.get(r.pair_address);
      if (p) {
        this.store.removePending(r.pair_address);
        this.store.upsertPair(p, r.source, now);
        this.store.insertSnapshot(p, now);
        this.classify(p, now);
        await this.evaluate(p, now);
        resolved++;
        continue;
      }
      if (r.attempts + 1 >= maxAttempts) {
        this.store.removePending(r.pair_address);
        log.debug(`pending 破棄 (DexScreener 未反映): ${r.pair_address}`);
      } else {
        this.store.bumpPending(r.pair_address);
      }
    }
    if (resolved > 0) log.info(`pending 解決: ${resolved}/${rows.length}`);
    return resolved;
  }

  /* ---------------- 更新・検知 ---------------- */

  /** 指定 tier のうち更新期限切れのペアを DexScreener で更新し、検知を走らせる */
  async refreshTier(tier: Tier, intervalSec: number, maxPairs = 600): Promise<number> {
    const now = this.now();
    const rows = this.store.listPairsForRefresh(tier, now - intervalSec * 1000, maxPairs);
    if (rows.length === 0) return 0;
    const pairs = await this.dex.getPairs(
      this.cfg.chainId,
      rows.map((r) => r.pair_address),
    );
    const byAddr = new Map(pairs.map((p) => [p.pairAddress.toLowerCase(), p]));
    for (const r of rows) {
      const p = byAddr.get(r.pair_address);
      if (!p) {
        this.store.markMissed(r.pair_address, now);
        continue;
      }
      this.store.upsertPair(p, r.source, now);
      this.store.insertSnapshot(p, now);
      this.classify(p, now);
      await this.evaluate(p, now);
    }
    this.stats.refreshCounts[tier] += rows.length;
    log.debug(`refresh(${tier}): ${rows.length} 件`);
    return rows.length;
  }

  /**
   * ヨコヨコのレンジ上限を価格で測る（時価総額が取れない銘柄向けの代替）。
   * 直近の値動きそのものを含めると「自分自身を超えられない」ので、末尾を除いて評価する。
   */
  private measureRangeHigh(p: DexPair, now: number): number | null {
    // 生の最大値ではなく、帯として成立した区間の上限を使う。
    // そうしないと初動スパイクの天井を抵抗線と取り違え、
    // そこを +12% 超えるまで鳴らない＝倍以上になってからの通知になる。
    const r = findLongestRange((from, to) => this.store.priceRangeBetween(p.pairAddress, from, to), now, this.cfg);
    return r?.high ?? null;
  }

  /**
   * ヨコヨコの帯を時価総額で測る。
   * 価格ではなく時価総額で見るのは、供給量が変わっても比較が崩れないため。
   */
  private measureMcRange(p: DexPair, now: number) {
    return this.mcRangeOf(p.pairAddress, now);
  }

  private mcRangeOf(pairAddress: string, now: number) {
    return findLongestRange((from, to) => this.store.mcRangeBetween(pairAddress, from, to), now, this.cfg);
  }

  /**
   * いまヨコヨコを組んでいる銘柄の一覧（/ranges 用）。
   *
   * 再点火の通知は「上抜けた瞬間」に鳴る。その一瞬まで、何を待っているのかが
   * 見えないままでは、利用者は自分で板を追うしかない。
   * ここでは通知と同じ計算をそのまま使い、抜けるまであと何 % かを出す。
   * 判定式を書き写すと通知と一覧がずれるので、しきい値も detectRevival と同じものを読む。
   */
  rangeWatchlist(now = this.now(), limit = 200): RangeWatch[] {
    const out: RangeWatch[] = [];
    for (const row of this.store.listRangeCandidates(this.cfg.reigniteMinPeakMcUsd, limit)) {
      const range = this.mcRangeOf(row.pair_address, now);
      if (!range) continue;
      const currentMc = this.store.latestMc(row.pair_address);
      if (currentMc === null || currentMc <= 0) continue;

      // detectRevival と同じ条件。ここだけ緩めると「一覧には出るのに鳴らない」が起きる
      const cooledRatio = row.peak_mc > 0 ? currentMc / row.peak_mc : null;
      const primed =
        this.cfg.reigniteEnabled &&
        row.peak_mc >= this.cfg.reigniteMinPeakMcUsd &&
        cooledRatio !== null &&
        cooledRatio <= this.cfg.reigniteCooledRatio;

      const triggerMc = range.high * (1 + this.cfg.reigniteBreakoutPct / 100);
      out.push({
        row,
        range,
        currentMc,
        triggerMc,
        toBreakoutPct: (triggerMc / currentMc - 1) * 100,
        posInRangePct: range.high > range.low ? ((currentMc - range.low) / (range.high - range.low)) * 100 : 100,
        cooledRatio,
        primed,
      });
    }
    // 抜けそうな順。待っているものを上に出す
    return out.sort((a, b) => a.toBreakoutPct - b.toBreakoutPct);
  }

  /**
   * ヨコヨコがどれだけ続いたかを測る。
   * いま同等に活発だった最後の時点を探し、そこからの経過を返す。
   * 観測履歴が浅いうちは推測になるため null を返し、通知にも出さない。
   */
  private measureQuiet(p: DexPair, now: number): number | null {
    const first = this.store.firstSnapshotAt(p.pairAddress);
    if (first === null || now - first < HOUR_MS) return null;
    const current = vol(p, "h1");
    if (current <= 0) return null;
    const last = this.store.lastActiveBefore(p.pairAddress, current * 0.4, now);
    const since = last ?? first;
    const quiet = now - since;
    return quiet > 10 * MINUTE_MS ? quiet : null;
  }

  /**
   * 全盛期が大きかった銘柄を、いま静かでも短い間隔で見に行く。
   * 再点火はこういう銘柄から起きるので、dormant と同じ 4 分間隔では遅すぎる。
   */
  async refreshPriority(intervalSec: number, maxPairs = 300): Promise<number> {
    const now = this.now();
    const rows = this.store.listPriorityForRefresh(this.cfg.priorityPeakMcUsd, now - intervalSec * 1000, maxPairs);
    if (rows.length === 0) return 0;
    const pairs = await this.dex.getPairs(
      this.cfg.chainId,
      rows.map((r) => r.pair_address),
    );
    const byAddr = new Map(pairs.map((x) => [x.pairAddress.toLowerCase(), x]));
    for (const r of rows) {
      const p = byAddr.get(r.pair_address);
      if (!p) {
        this.store.markMissed(r.pair_address, now);
        continue;
      }
      this.store.upsertPair(p, r.source, now);
      this.store.insertSnapshot(p, now);
      this.classify(p, now);
      await this.evaluate(p, now);
    }
    log.debug(`refresh(priority): ${rows.length} 件`);
    return rows.length;
  }

  /** tier の再分類 */
  classify(p: DexPair, now: number): Tier {
    const age = pairAgeMs(p, now);
    const liq = liquidityUsd(p);
    const h1 = vol(p, "h1");
    let tier: Tier;
    if (liq < this.cfg.deadLiquidityUsd) tier = "dead";
    else if (h1 >= this.cfg.hotVolH1Usd || (age !== null && age < 24 * HOUR_MS)) tier = "hot";
    else tier = "dormant";
    this.store.setTier(p.pairAddress, tier, now);
    return tier;
  }

  /** 検知器を実行し、必要ならアラート送信 */
  async evaluate(p: DexPair, now: number): Promise<Detection[]> {
    const age = pairAgeMs(p, now);
    const row = this.store.getPair(p.pairAddress);
    const token = p.baseToken.address.toLowerCase();
    const out: Detection[] = [];

    const candidates: Detection[] = [];
    const nl = detectNewLaunch(
      { now, pair: p, ageMs: age, lastAlert: this.store.lastAlert("new_launch", token), lookbackMinPrice: null },
      this.cfg,
    );
    if (nl) candidates.push(nl);
    const rv = detectRevival(
      {
        now,
        pair: p,
        ageMs: age,
        lastAlert: this.store.lastAlert("revival", token),
        lookbackMinPrice: this.store.minPriceSince(p.pairAddress, now - this.cfg.revivalLookbackMin * MINUTE_MS),
        baseLowPrice: this.store.minPriceSince(p.pairAddress, now - this.cfg.revivalBaseWindowMin * MINUTE_MS),
        rangeHighPrice: this.measureRangeHigh(p, now),
        quietMs: this.measureQuiet(p, now),
        peakMc: row?.peak_mc ?? 0,
        peakMcAt: row?.peak_mc_at ?? null,
        mcRange: this.measureMcRange(p, now),
        baseLowMc: this.store.minMcSince(p.pairAddress, now - this.cfg.revivalBaseWindowMin * MINUTE_MS),
      },
      this.cfg,
    );
    if (rv) candidates.push(rv);

    // 作られた出来高で釣る銘柄を落とす。検知そのものは残し、通知だけを止める
    // （履歴に残しておかないと、フィルタが効きすぎていても利用者が気づけない）。
    const scam = assessScam(p, this.cfg, now);
    const blocked = this.cfg.scamFilterEnabled && scam.score >= this.cfg.scamScoreThreshold;

    // 同時に立った場合は復活を優先する。
    // 「ヨコヨコから動き出した」ほうが、出来高が段階を超えたことより読み手に有用。
    const chosen = candidates.some((c) => c.kind === "revival") ? candidates.filter((c) => c.kind === "revival") : candidates;

    for (const d of chosen) {
      // 反省に使う属性も一緒に残す。あとから「どういう通知が当たったか」を集計するため
      this.store.insertAlert({
        kind: d.kind,
        token_address: token,
        pair_address: p.pairAddress,
        ts: now,
        level: d.level,
        price_usd: priceUsd(p),
        symbol: p.baseToken.symbol ?? "",
        summary: d.reason,
        scam_score: scam.score,
        scam_reasons: scam.signals.map((sig) => sig.label).join("\n"),
        suppressed: blocked ? 1 : 0,
        mc_usd: p.marketCap && p.marketCap > 0 ? p.marketCap : (p.fdv ?? 0),
        trigger: d.display.trigger ?? (d.kind === "new_launch" ? "new" : "dormant"),
        vol_h1: d.metrics.volH1,
        buys_h1: d.metrics.buysH1,
        sells_h1: d.metrics.sellsH1,
        age_hours: age === null ? null : age / HOUR_MS,
      });
      out.push(d);

      if (blocked) {
        this.stats.alertsSuppressed++;
        log.info(`FILTERED ${d.kind} $${p.baseToken.symbol} — スキャム判定 ${scam.score}/100`);
        continue;
      }
      if (this.isMuted()) {
        log.info(`[muted] ${d.kind} $${p.baseToken.symbol}: ${d.reason}`);
        continue;
      }
      const html = formatAlert(d, p, age, scam, this.view);
      try {
        await this.sink.broadcast(html);
        this.stats.alertsSent++;
        log.info(`ALERT ${d.kind} L${d.level} $${p.baseToken.symbol} — ${d.reason}`);
      } catch (err) {
        log.error("Telegram 送信失敗", err);
      }
    }
    return out;
  }

  /* ---------------- 反省: 結果追跡と日次レポート ---------------- */

  /** 通知の「その後」を埋める。スナップショットから計算するので API 呼び出しは無い */
  runOutcomes(): number {
    return computeOutcomes(this.store, this.cfg, this.now());
  }

  /** 日次レポート本文（/report とスケジュール送信の両方で使う） */
  buildReport(): string {
    return buildDailyReport(this.store, this.cfg, this.now()).text;
  }

  /**
   * 1 日 1 回、決めた時刻（JST）を過ぎていたらレポートを送る。
   * 送った日付を kv に残し、再起動しても二重送信しない。
   */
  async maybeSendDailyReport(): Promise<boolean> {
    if (!this.cfg.reportEnabled) return false;
    const now = this.now();
    const { date, hour } = jst(now);
    if (hour < this.cfg.reportHourJst) return false;
    if (this.store.getKv("daily_report_date") === date) return false;
    const { text, stats } = buildDailyReport(this.store, this.cfg, now);
    this.store.saveDailyReport({ date, ts: now, alerts: stats.judged, hits: stats.hits, hit_rate: stats.hitRate, text });
    this.store.setKv("daily_report_date", date);
    try {
      await this.sink.broadcast(text);
      log.info(`日次レポート送信 (${date}): 通知 ${stats.judged} 件 / 的中 ${stats.hits}`);
    } catch (err) {
      log.error("日次レポートの送信に失敗", err);
    }
    return true;
  }

  /* ---------------- スマートウォレット ---------------- */

  /**
   * 勝ちと確定した復活銘柄について、急騰前に買っていたウォレットを集める。
   * 1 回の実行で処理する件数を絞り、公開 RPC に負荷を掛けすぎないようにする。
   */
  async runHarvests(maxPerRun = 2): Promise<number> {
    if (!this.harvester) return 0;
    const now = this.now();
    const targets = this.store.listAlertsToHarvest(maxPerRun);
    let done = 0;
    for (const a of targets) {
      const pair = this.store.getPair(a.pair_address);
      if (!pair) {
        this.store.markHarvest(a.id, now, "error", 0, 0, "pair not found");
        continue;
      }
      try {
        const r = await this.harvester.harvest(a, pair);
        this.store.markHarvest(a.id, now, r.status, r.swaps, r.buyers, r.note ?? "");
        done++;
      } catch (err) {
        this.store.markHarvest(a.id, now, "error", 0, 0, err instanceof Error ? err.message.slice(0, 200) : String(err));
        log.warn(`harvest 失敗 $${a.symbol}`, err);
      }
    }
    return done;
  }

  /**
   * 指定トークンの急騰前の買い手を、いま集める（/harvest）。
   *
   * 自動収穫は「的中が確定した復活通知」を待つが、利用者が「これは本物だった」と
   * 分かった時点で待つ理由はない。窓も広めに取れるようにする。
   * フェニックスの仕込みは静穏期に散らばるので、6 時間では取りこぼす。
   */
  async harvestToken(address: string, windowHours?: number): Promise<HarvestTokenResult> {
    if (!this.harvester) return { ok: false, reason: "RPC_URL が設定されていないため、チェーンの取引を読めません（.env を確認）" };

    // ペアアドレスでもトークンアドレスでも受ける。未知なら DexScreener から取り込む
    let pairs = this.store.listPairsByToken(address);
    if (pairs.length === 0) {
      const one = this.store.getPair(address);
      if (one) pairs = [one];
    }
    if (pairs.length === 0) {
      await this.watch(address);
      pairs = this.store.listPairsByToken(address);
      if (pairs.length === 0) {
        const one = this.store.getPair(address);
        if (one) pairs = [one];
      }
    }
    const pair = pairs.sort((a, b) => b.last_liquidity_usd - a.last_liquidity_usd)[0];
    if (!pair) return { ok: false, reason: `DexScreener に ${address} のペアが見つかりませんでした` };

    const alert = this.store.anchorAlertForToken(pair.base_address);
    if (!alert) {
      return {
        ok: false,
        reason: `$${pair.base_symbol} には通知の記録が無く、「急騰前」の時点を決められません。通知が出た銘柄で使ってください`,
      };
    }

    const hours = windowHours ?? this.cfg.smartHarvestWindowHours;
    const now = this.now();
    const result = await this.harvester.harvest(alert, pair, hours);
    this.store.markHarvest(alert.id, now, result.status, result.swaps, result.buyers, `manual ${hours}h`);
    const tagged = result.status === "ok" ? this.store.tagWalletsForToken(pair.base_address, pair.base_symbol) : 0;
    const buyers = this.store.earlyBuyersForToken(pair.base_address, 15);
    return { ok: true, pair, alert, hours, result, tagged, buyers };
  }

  /**
   * 「この銘柄はヨコヨコ監視に入っていたか。入っていないなら何が足りないか」に答える（/ranges <address>）。
   *
   * 急変で拾えた銘柄について「先にレンジで待てていたか」を利用者が確かめられないと、
   * 門の高さが合っているかを判断できない。$MOO はこれで全盛期の門（$800K）が高すぎると分かった。
   */
  rangeDiagnosis(address: string, now = this.now()): RangeDiagnosis | null {
    let rows = this.store.listPairsByToken(address);
    if (rows.length === 0) {
      const one = this.store.getPair(address);
      if (one) rows = [one];
    }
    const row = rows.sort((a, b) => b.last_liquidity_usd - a.last_liquidity_usd)[0];
    if (!row) return null;

    const peakOk = row.peak_mc >= this.cfg.reigniteMinPeakMcUsd;
    const inCandidates = peakOk || row.manual === 1;
    const currentMc = this.store.latestMc(row.pair_address);
    const cooledRatio = currentMc !== null && row.peak_mc > 0 ? currentMc / row.peak_mc : null;
    const cooled = cooledRatio !== null && cooledRatio <= this.cfg.reigniteCooledRatio;

    // 窓ごとに「なぜ帯にならないか」を残す。成立した最初の窓で止める
    const to = now - this.cfg.revivalRangeExcludeMin * MINUTE_MS;
    const windows: RangeWindowCheck[] = [];
    let range: RangeInfo | null = null;
    for (const hours of candidateWindows(this.cfg)) {
      const raw = this.store.mcRangeBetween(row.pair_address, to - hours * HOUR_MS, to);
      const r = toRange(raw, this.cfg);
      let why = "";
      if (!raw) why = "観測なし";
      else if (raw.samples < this.cfg.rangeMinSamples) why = `観測 ${raw.samples} 点 < ${this.cfg.rangeMinSamples} 点`;
      else if (raw.lastTs - raw.firstTs < this.cfg.rangeMinHours * HOUR_MS) why = `期間 ${((raw.lastTs - raw.firstTs) / HOUR_MS).toFixed(1)}h < ${this.cfg.rangeMinHours}h`;
      else if ((raw.high / raw.low - 1) * 100 > this.cfg.rangeMaxWidthPct) why = `幅 ${((raw.high / raw.low - 1) * 100).toFixed(0)}% > ${this.cfg.rangeMaxWidthPct}%（スパイクを含む）`;
      windows.push({ hours, ok: r !== null, why });
      if (r) {
        range = r;
        break;
      }
    }

    const triggerMc = range ? range.high * (1 + this.cfg.reigniteBreakoutPct / 100) : null;
    return {
      row,
      peakOk,
      inCandidates,
      currentMc,
      cooledRatio,
      cooled,
      range,
      windows,
      triggerMc,
      toBreakoutPct: triggerMc !== null && currentMc !== null && currentMc > 0 ? (triggerMc / currentMc - 1) * 100 : null,
      primed: inCandidates && peakOk && cooled && range !== null,
    };
  }

  /* ---------------- メンテナンス ---------------- */

  maintain(): void {
    const now = this.now();
    const pruned = this.store.pruneSnapshots(now - this.cfg.snapshotRetentionHours * HOUR_MS);
    const dead = this.store.listDeadOlderThan(now - this.cfg.deadDropDays * 24 * HOUR_MS);
    for (const r of dead) this.store.deletePair(r.pair_address);
    // DexScreener が 20 回連続で返さないペアは削除（デリスト等）
    const missed = this.store.listStaleMissed(20);
    for (const r of missed) this.store.deletePair(r.pair_address);
    log.info(`maintain: snapshots ${pruned} 削除, dead ${dead.length} 削除, missing ${missed.length} 削除`);
  }

  /**
   * 通知の見た目と配信経路をいつでも確かめられるようにする。
   * 監視中のペアがあれば、その実データに合成の検知結果を載せて送る。
   */
  async sendSampleAlert(): Promise<string> {
    const now = this.now();
    const top = this.store.listTopByVolH1(1)[0];
    let pair: DexPair | null = null;
    if (top) {
      const found = await this.dex.getPairs(this.cfg.chainId, [top.pair_address]);
      pair = found[0] ?? null;
    }
    if (!pair) {
      await this.sink.broadcast(
        [
          "🧪 <b>テスト送信</b>",
          "",
          "配信経路は正常です。",
          "まだ監視中のペアが無いため、実データ入りの見本は表示できません。",
          "数分待ってから <code>/status</code> で監視ペア数を確認してください。",
        ].join("\n"),
      );
      return "テストメッセージを送信しました（監視ペアがまだ 0 件です）";
    }
    const m = baseMetrics(pair);
    m.volSpikeRatio = m.volH24 > m.volH1 ? m.volH1 / (Math.max(0, m.volH24 - m.volH1) / 23) : Number.POSITIVE_INFINITY;
    const detection: Detection = {
      kind: "revival",
      level: 1,
      levelCount: 0,
      reason: "これはテスト送信です。実際の検知条件は満たしていません",
      metrics: m,
      display: { baseRisePct: null, quietMs: null, viaFastLane: false },
    };
    await this.sink.broadcast(
      "🧪 <b>テスト送信</b> — 以下は通知の見本です\n\n" +
        formatAlert(detection, pair, pairAgeMs(pair, now), assessScam(pair, this.cfg, now), this.view),
    );
    return `テスト通知を送信しました（$${pair.baseToken.symbol} の実データを使用）`;
  }

  /** 指定アドレスを現在値で採点する（/why 用） */
  async explain(address: string): Promise<{ pair: DexPair; scam: ScamAssessment } | null> {
    let pairs = await this.dex.getPairs(this.cfg.chainId, [address]);
    if (pairs.length === 0) pairs = await this.dex.getTokenPools(this.cfg.chainId, address);
    pairs = pairs.filter((x) => x.chainId === this.cfg.chainId);
    // 同じトークンに複数プールがあるときは、いちばん流動性の厚いものを代表にする
    const pair = pairs.sort((a, b) => liquidityUsd(b) - liquidityUsd(a))[0];
    if (!pair) return null;
    return { pair, scam: assessScam(pair, this.cfg, this.now()) };
  }

  /** 手動監視追加（ペアアドレス or トークンアドレス） */
  async watch(address: string): Promise<DexPair[]> {
    const now = this.now();
    let pairs = await this.dex.getPairs(this.cfg.chainId, [address]);
    if (pairs.length === 0) pairs = await this.dex.getTokenPools(this.cfg.chainId, address);
    pairs = pairs.filter((p) => p.chainId === this.cfg.chainId);
    for (const p of pairs) {
      this.store.upsertPair(p, "manual", now, { manual: true });
      this.store.insertSnapshot(p, now);
      this.classify(p, now);
    }
    return pairs;
  }

  unwatch(address: string): number {
    const addr = address.toLowerCase();
    let n = 0;
    if (this.store.hasPair(addr)) {
      this.store.deletePair(addr);
      n++;
    }
    for (const r of this.store.listPairsByToken(addr)) {
      this.store.deletePair(r.pair_address);
      n++;
    }
    return n;
  }
}
