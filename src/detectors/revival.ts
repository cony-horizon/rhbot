import type { Config } from "../config.js";
import { baseMetrics, HOUR_MS, MINUTE_MS, passesCommonFilters } from "./common.js";
import type { Detection, DetectorContext } from "./types.js";

/**
 * ② 復活スパイク検知（最重要）
 * ローンチから REVIVAL_MIN_AGE_HOURS 以上経過したペアで、
 *   - 1h 出来高が直前 23h の平均 1h 出来高の REVIVAL_VOL_SPIKE_RATIO 倍以上（＝突発的な出来高）
 *   - 価格が REVIVAL_PRICE_CHANGE_PCT % 以上上昇（DexScreener の 1h 変化率 or 自前 lookback 最安値比）
 * を同時に満たしたときに通知。クールダウン中は「前回通知価格から更に REVIVAL_ESCALATION_PCT % 上」なら再通知。
 */
export function detectRevival(ctx: DetectorContext, cfg: Config): Detection | null {
  if (!cfg.revivalEnabled) return null;
  const { pair, ageMs, lastAlert, now } = ctx;
  if (ageMs === null || ageMs < cfg.revivalMinAgeHours * HOUR_MS) return null;
  if (!passesCommonFilters(pair, cfg)) return null;

  const m = baseMetrics(pair);
  if (m.volH1 < cfg.revivalMinVolH1Usd) return null;
  if (m.buysH1 < cfg.revivalMinBuysH1) return null;

  // 出来高の突発性: 直前 23 時間の平均 1h 出来高と比較
  const prevAvgH1 = Math.max(0, m.volH24 - m.volH1) / 23;
  const ratio = prevAvgH1 > 0 ? m.volH1 / prevAvgH1 : Number.POSITIVE_INFINITY;
  m.volSpikeRatio = ratio;
  if (ratio < cfg.revivalVolSpikeRatio) return null;

  // 価格上昇: DexScreener の 1h 変化率 と 自前 lookback 最安値比 の大きい方
  const dsH1 = m.priceChangeH1 ?? Number.NEGATIVE_INFINITY;
  let lookbackPct: number | null = null;
  if (ctx.lookbackMinPrice !== null && ctx.lookbackMinPrice > 0) {
    lookbackPct = (m.priceUsd / ctx.lookbackMinPrice - 1) * 100;
    m.lookbackChangePct = lookbackPct;
  }
  const change = Math.max(dsH1, lookbackPct ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(change) || change < cfg.revivalPriceChangePct) return null;

  // クールダウン / エスカレーション
  let level = 1;
  if (lastAlert) {
    const sinceLast = now - lastAlert.ts;
    if (sinceLast < cfg.revivalCooldownMin * MINUTE_MS) {
      const lastPrice = lastAlert.price_usd ?? 0;
      const escalate =
        cfg.revivalEscalationPct > 0 && lastPrice > 0 && m.priceUsd >= lastPrice * (1 + cfg.revivalEscalationPct / 100);
      if (!escalate) return null;
      level = lastAlert.level + 1;
    }
  }

  const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "∞ (直前 23h 出来高ゼロ)";
  const src = lookbackPct !== null && lookbackPct >= dsH1 ? `${cfg.revivalLookbackMin}分安値比` : "1h";
  return {
    kind: "revival",
    level,
    levelCount: 0,
    reason: `価格 +${change.toFixed(0)}% (${src}) / 1h 出来高 $${Math.round(m.volH1).toLocaleString("en-US")} は直前平均の ${ratioText}`,
    metrics: m,
  };
}
