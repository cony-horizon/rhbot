import type { Config } from "../config.js";
import { baseMetrics, HOUR_MS, passesCommonFilters } from "./common.js";
import type { Detection, DetectorContext } from "./types.js";

/**
 * ① 新規ローンチ検知
 * ペア作成から NEW_MAX_AGE_HOURS 以内で、時価総額が NEW_MIN_MC_USD 以上あり、
 * 1h 出来高が段階しきい値を超えるたびに 1 回通知する。
 */
export function detectNewLaunch(ctx: DetectorContext, cfg: Config): Detection | null {
  if (!cfg.newLaunchEnabled) return null;
  const { pair, ageMs, lastAlert } = ctx;
  if (ageMs === null || ageMs < 0) return null;
  if (ageMs >= cfg.newMaxAgeHours * HOUR_MS) return null;
  if (!passesCommonFilters(pair, cfg)) return null;

  const m = baseMetrics(pair);
  if (m.buysH1 < cfg.newMinBuysH1) return null;

  // 時価総額の下限。開発の重心は再点火に置いているので、新規は規模のあるものだけに絞る。
  // 時価総額が取れない銘柄は規模を判断できないため、ここでは通さない。
  const mc = pair.marketCap && pair.marketCap > 0 ? pair.marketCap : (pair.fdv ?? 0);
  if (mc < cfg.newMinMcUsd) return null;

  const tiers = cfg.newVolH1TiersUsd;
  if (tiers.length === 0) return null;
  let reached = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t !== undefined && m.volH1 >= t) reached = i + 1;
  }
  if (reached === 0) return null;

  const prevLevel = lastAlert?.level ?? 0;
  if (reached <= prevLevel) return null;

  const threshold = tiers[reached - 1] ?? 0;
  return {
    kind: "new_launch",
    level: reached,
    levelCount: tiers.length,
    reason: `1h 出来高が $${threshold.toLocaleString("en-US")} を突破`,
    metrics: m,
    display: {},
  };
}
