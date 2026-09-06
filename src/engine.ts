import type { Config } from "./config.js";
import { DexScreenerClient, liquidityUsd, pairAgeMs, priceUsd, vol, type DexPair } from "./dexscreener.js";
import { detectNewLaunch } from "./detectors/newLaunch.js";
import { detectRevival } from "./detectors/revival.js";
import { assessScam, formatScamSummary, type ScamAssessment } from "./detectors/scam.js";
import type { Detection } from "./detectors/types.js";
import { baseMetrics, HOUR_MS, MINUTE_MS } from "./detectors/common.js";
import { formatAlert } from "./format.js";
import { log } from "./logger.js";
import { PoolScanner, RpcClient } from "./rpc.js";
import type { Store, Tier } from "./store.js";

/** discovery が何回続けて空振りしたら利用者に知らせるか */
const HEALTH_EMPTY_THRESHOLD = 5;
/** 同じ警告を繰り返さない間隔 */
const HEALTH_WARN_COOLDOWN_MS = 6 * 3_600_000;

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
  private readonly scanner: PoolScanner | null;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly dex: DexScreenerClient,
    private readonly sink: AlertSink,
    rpc: RpcClient | null,
    private readonly now: () => number = Date.now,
  ) {
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
      },
      this.cfg,
    );
    if (rv) candidates.push(rv);

    // 作られた出来高で釣る銘柄を落とす。検知そのものは残し、通知だけを止める
    // （履歴に残しておかないと、フィルタが効きすぎていても利用者が気づけない）。
    const scam = assessScam(p, this.cfg, now);
    const blocked = this.cfg.scamFilterEnabled && scam.score >= this.cfg.scamScoreThreshold;

    for (const d of candidates) {
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
      const html = formatAlert(d, p, age, scam, this.cfg.scamShowScoreFrom);
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
    };
    await this.sink.broadcast(
      "🧪 <b>テスト送信</b> — 以下は通知の見本です\n\n" +
        formatAlert(detection, pair, pairAgeMs(pair, now), assessScam(pair, this.cfg, now), this.cfg.scamShowScoreFrom),
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
