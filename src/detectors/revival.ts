import type { Config } from "../config.js";
import { baseMetrics, HOUR_MS, MINUTE_MS, passesCommonFilters } from "./common.js";
import type { Detection, DetectorContext } from "./types.js";

/**
 * ② 復活スパイク検知（ヨコヨコ → 急騰）
 *
 * 「ヨコヨコから急に上がった」には、実は性質の違う 2 つの型がある。
 *
 *   A. 静穏型  … 取引がほぼ止まっていた銘柄に、突然出来高が湧いて価格が上がる
 *   B. レンジ抜け型 … 出来高は元から多いが、価格が一定の幅を往復していて、そこを上抜ける
 *
 * 出来高の突発率だけを見ると B を取りこぼす。実際 24h で $8.78M を捌いていた銘柄は、
 * 価格が 90% 飛んでも「平常より静か」と評価されてしまう。
 * そこで、出来高の突発とレンジ上抜けのどちらでも成立するようにしている。
 *
 * レンジ抜けは +90% になるのを待たずレンジを超えた時点で判定できるので、通知も早くなる。
 */
export function detectRevival(ctx: DetectorContext, cfg: Config): Detection | null {
  if (!cfg.revivalEnabled) return null;
  const { pair, ageMs, lastAlert, now } = ctx;
  if (ageMs === null || ageMs < cfg.revivalMinAgeHours * HOUR_MS) return null;
  if (!passesCommonFilters(pair, cfg)) return null;

  const m = baseMetrics(pair);
  if (m.volH1 < cfg.revivalMinVolH1Usd) return null;
  if (m.buysH1 < cfg.revivalMinBuysH1) return null;

  // 出来高の突発性。
  // 24h の集計には「まだ存在していなかった時間」も含まれるので、常に 23 で割ると
  // 若い銘柄ほど平常値を小さく見積もり、何でもスパイク扱いしてしまう。実在した時間で割る。
  const historyHours = Math.min(23, Math.max(1, ageMs / HOUR_MS - 1));
  const prevAvgH1 = Math.max(0, m.volH24 - m.volH1) / historyHours;
  const ratio = prevAvgH1 > 0 ? m.volH1 / prevAvgH1 : Number.POSITIVE_INFINITY;
  m.volSpikeRatio = ratio;

  // 価格の上昇幅
  const dsH1 = m.priceChangeH1 ?? Number.NEGATIVE_INFINITY;
  let lookbackPct: number | null = null;
  if (ctx.lookbackMinPrice !== null && ctx.lookbackMinPrice > 0) {
    lookbackPct = (m.priceUsd / ctx.lookbackMinPrice - 1) * 100;
    m.lookbackChangePct = lookbackPct;
  }
  const rise = Math.max(dsH1, lookbackPct ?? Number.NEGATIVE_INFINITY);

  // レンジ上限をどれだけ超えたか
  const rangeHigh = ctx.rangeHighPrice ?? null;
  const breakoutPct = rangeHigh !== null && rangeHigh > 0 ? (m.priceUsd / rangeHigh - 1) * 100 : null;

  // 再点火の下地。
  // かつて大きな時価総額をつけた銘柄は、それだけの評価を実際に得た証拠がある。
  // その履歴が確度を担保してくれるので、レンジ抜けのしきい値を下げて早く拾える。
  const currentMc = pair.marketCap && pair.marketCap > 0 ? pair.marketCap : (pair.fdv ?? 0);
  const peakMc = ctx.peakMc ?? 0;
  const cooledRatio = peakMc > 0 && currentMc > 0 ? currentMc / peakMc : null;
  const hasPedigree = cfg.reigniteEnabled && peakMc >= cfg.reigniteMinPeakMcUsd;
  const cooled = cooledRatio !== null && cooledRatio <= cfg.reigniteCooledRatio;
  // いまの時価総額が小さすぎる銘柄は再点火の対象にしない（/ranges と同じ下限）。
  // 死んだ銘柄が $8K → $8.5K と動いたのは「レンジ上抜け」ではない。動きがあれば急変レーンが拾う
  const alive = currentMc >= cfg.rangeMinMcUsd;

  // 成立したヨコヨコの帯を、どれだけ上抜けたか。
  // 「窓内の最大値」ではなく「帯として成立しているか」を確かめてから使うので、
  // 下落途中の一点を天井と取り違えることがない。
  const mcRange = ctx.mcRange ?? null;
  const mcBreakoutPct = mcRange !== null && currentMc > 0 ? (currentMc / mcRange.high - 1) * 100 : null;

  // 成立経路を判定する。確度の高い順に見る
  const m5 = m.priceChangeM5;
  let trigger: "reignite" | "dormant" | "breakout" | "fast" | null = null;
  if (hasPedigree && cooled && alive && mcBreakoutPct !== null && mcBreakoutPct >= cfg.reigniteBreakoutPct) {
    trigger = "reignite";
  } else if (ratio >= cfg.revivalVolSpikeRatio && Number.isFinite(rise) && rise >= cfg.revivalPriceChangePct) {
    trigger = "dormant";
  } else if (breakoutPct !== null && breakoutPct >= cfg.revivalBreakoutPct) {
    trigger = "breakout";
  } else if (cfg.revivalFastM5Pct > 0 && m5 !== null && m5 >= cfg.revivalFastM5Pct) {
    trigger = "fast";
  }
  if (trigger === null) return null;

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

  // ヨコヨコの底からどれだけ上がったか。
  // 再点火では時価総額の底を基準にする（利用者が見ている単位に合わせる）。
  const baseMc = ctx.baseLowMc ?? null;
  const base = ctx.baseLowPrice ?? null;
  const baseRisePct =
    trigger === "reignite" && baseMc !== null && baseMc > 0 && currentMc > 0
      ? (currentMc / baseMc - 1) * 100
      : base !== null && base > 0
        ? (m.priceUsd / base - 1) * 100
        : null;

  const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "∞";
  const reason =
    trigger === "reignite"
      ? `全盛期 MC $${Math.round(peakMc).toLocaleString("en-US")} の銘柄がレンジを +${mcBreakoutPct!.toFixed(0)}% 上抜け`
      : trigger === "breakout"
      ? `レンジ上限を +${breakoutPct!.toFixed(0)}% 上抜け`
      : trigger === "fast"
        ? `5 分で +${(m5 ?? 0).toFixed(0)}% の急変`
        : `価格 +${rise.toFixed(0)}% / 出来高が平常の ${ratioText}`;

  return {
    kind: "revival",
    level,
    levelCount: 0,
    reason,
    metrics: m,
    display: {
      baseRisePct,
      quietMs: ctx.quietMs ?? null,
      viaFastLane: trigger === "fast",
      breakoutPct,
      mcBreakoutPct,
      trigger,
      peakMc: peakMc > 0 ? peakMc : null,
      peakAgoMs: ctx.peakMcAt ? now - ctx.peakMcAt : null,
      cooledRatio,
      mcRange,
      currentMc: currentMc > 0 ? currentMc : null,
    },
  };
}
