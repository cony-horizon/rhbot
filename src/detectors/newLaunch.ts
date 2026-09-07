import type { Config } from "../config.js";
import { liquidityUsd, vol, type DexPair } from "../dexscreener.js";
import { baseMetrics, HOUR_MS, passesCommonFilters } from "./common.js";
import { assessBreadth, type Breadth } from "./scam.js";
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
  const lowMc = mc < cfg.newMinMcUsd ? assessLowMc(pair, mc, cfg) : null;
  if (mc < cfg.newMinMcUsd && lowMc === null) return null;

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
    reason:
      lowMc !== null
        ? `時価総額 $${Math.round(mc).toLocaleString("en-US")} に対し 1h 出来高 ${lowMc.volToMc.toFixed(1)} 倍`
        : `1h 出来高が $${threshold.toLocaleString("en-US")} を突破`,
    metrics: m,
    display: {
      trigger: lowMc !== null ? "new_lowmc" : "new",
      currentMc: mc > 0 ? mc : null,
      lowMcVolToMc: lowMc?.volToMc ?? null,
      breadth: lowMc?.breadth ?? null,
    },
  };
}

/**
 * 低時価総額レーン（試験運用）。
 *
 * 時価総額の下限だけで切ると、$150K で回り始めて $2M まで行くような銘柄を最初から捨ててしまう。
 * かといって下限を下げるだけでは、小さくて静かなだけの銘柄が大量に流れ込む。
 *
 * 分かれ目は「その規模に見合う出来高が実際に伴っているか」。
 * ただし出来高比が高いことは、作られた出来高の特徴でもある（スキャム判定の turnover はまさにそれを咎める）。
 * そこで出来高比に加えて参加者の厚みを必須にする。
 * 多数の小口が売り買いしているなら実需、少数の大口が回しているならバンドル、という切り分けはここでも同じ。
 *
 * 件数の下限は breadthTxnBar が規模に応じて決める。スキャム判定も同じ関数を読むので、
 * 「出来高が伴うから通す」と「出来高が過大だから危険」が食い違うことはない。
 */
function assessLowMc(pair: DexPair, mc: number, cfg: Config): { volToMc: number; breadth: Breadth } | null {
  if (!cfg.newLowMcEnabled) return null;
  if (mc < cfg.newLowMcFloorUsd) return null;

  // このレーン専用の流動性の下限。
  // 全体の下限 (MIN_LIQUIDITY_USD) は時価総額 $1M 以上を前提に置いた値で、
  // $200K の銘柄には緩すぎる。$8K のプールに $180K/h が流れていても、
  // それは「出来高が伴っている」ではなく、単に出られないだけ。
  if (liquidityUsd(pair) < cfg.newLowMcMinLiquidityUsd) return null;

  const volToMc = vol(pair, "h1") / mc;
  if (volToMc < cfg.newLowMcVolToMcRatio) return null;

  const breadth = assessBreadth(pair, cfg);
  if (!breadth.organic) return null;

  return { volToMc, breadth };
}
