import type { Config } from "../config.js";
import { buys, liquidityUsd, priceChange, sells, vol, type DexPair } from "../dexscreener.js";
import { MINUTE_MS } from "./common.js";

export interface ScamSignal {
  /** 設定で個別に調整できるようにするための識別子 */
  id: string;
  points: number;
  /** 通知に出す日本語の説明 */
  label: string;
}

export interface ScamAssessment {
  score: number;
  signals: ScamSignal[];
}

/**
 * バンドル・洗浄取引で作られた見せかけの出来高を、DexScreener API で取れる値だけで見分ける。
 *
 * 画面には平均売買金額やトレーダー数も出ているが API には無いため、
 * 「プールの深さに対して出来高が過大か」を軸に組み立てている。
 * 出来高は人為的に膨らませられるが、流動性と時価総額は同じようには膨らませられないので、
 * その比が乖離しているほど、取引が実需でない可能性が高い。
 */
export function assessScam(pair: DexPair, cfg: Config, now: number): ScamAssessment {
  const signals: ScamSignal[] = [];
  const liq = liquidityUsd(pair);
  const volH1 = vol(pair, "h1");
  const mc = pair.marketCap && pair.marketCap > 0 ? pair.marketCap : (pair.fdv ?? 0);
  const txns = buys(pair, "h1") + sells(pair, "h1");
  const ageMs = typeof pair.pairCreatedAt === "number" ? now - pair.pairCreatedAt : null;

  const add = (id: string, points: number, label: string) => signals.push({ id, points, label });

  // ① 出来高 ÷ 流動性。もっとも強い指標。
  // 実需なら 1 時間でプールの数倍を超えることは稀で、超えるほど自己取引で回している疑いが濃い。
  if (liq > 0) {
    const churn = volH1 / liq;
    if (churn >= cfg.scamChurnHigh) {
      add("churn", 35, `1h 出来高が流動性の ${churn.toFixed(1)} 倍（洗浄取引の疑い）`);
    } else if (churn >= cfg.scamChurnMid) {
      add("churn", 18, `1h 出来高が流動性の ${churn.toFixed(1)} 倍`);
    }
  }

  // ② 出来高 ÷ 時価総額。時価総額に匹敵する額が 1 時間で動くのは通常ありえない。
  if (mc > 0) {
    const turnover = volH1 / mc;
    if (turnover >= 0.8) {
      add("turnover", 20, `1h で時価総額の ${(turnover * 100).toFixed(0)}% が取引された`);
    } else if (turnover >= 0.4) {
      add("turnover", 10, `1h で時価総額の ${(turnover * 100).toFixed(0)}% が取引された`);
    }
  }

  // ③ 流動性 ÷ FDV。低いほど「値札だけ高く、実際には抜けられない」状態。
  if (mc > 0 && liq > 0) {
    const depth = liq / mc;
    if (depth < cfg.scamMinDepthPct / 100) {
      add("depth", 25, `流動性が時価総額の ${(depth * 100).toFixed(1)}% しかない（売り抜けられない）`);
    } else if (depth < (cfg.scamMinDepthPct * 2.5) / 100) {
      add("depth", 12, `流動性が時価総額の ${(depth * 100).toFixed(1)}% と薄い`);
    }
  }

  // ④ 薄いプールでの極端な急騰。
  // プールが浅いほど少額で価格を吊り上げられるので、上昇率の大きさ自体が操作の容易さを示す。
  const pcH1 = priceChange(pair, "h1");
  if (pcH1 !== null && pcH1 >= cfg.scamPumpPct && liq < cfg.scamPumpLiquidityUsd) {
    add("thin_pump", 25, `流動性 $${Math.round(liq).toLocaleString("en-US")} で +${pcH1.toFixed(0)}% の急騰（少額で値を動かせる）`);
  }

  // ⑤ 流動性の絶対値が小さすぎる。
  if (liq > 0 && liq < cfg.scamMinLiquidityUsd) {
    add("tiny_liq", 20, `流動性が $${Math.round(liq).toLocaleString("en-US")} と極端に少ない`);
  }

  // ⑥ 極端に小口の取引が大量にある＝件数を稼ぐための塵取引。
  if (txns >= 100 && volH1 > 0) {
    const avg = volH1 / txns;
    if (avg < cfg.scamMinAvgTradeUsd) {
      add("dust", 12, `平均取引額が $${avg.toFixed(0)} と極小（件数稼ぎの疑い）`);
    }
  }

  // ⑦ ローンチ直後に出来高が湧いている＝同一ブロックで買いを固めるバンドルの典型。
  if (ageMs !== null && ageMs < 60 * MINUTE_MS && liq > 0 && volH1 >= liq * 3) {
    add("instant_volume", 15, `ローンチ ${Math.round(ageMs / MINUTE_MS)} 分で流動性の ${(volH1 / liq).toFixed(1)} 倍の出来高（バンドルの疑い）`);
  }

  const score = Math.min(100, signals.reduce((n, s) => n + s.points, 0));
  return { score, signals };
}

/** 通知に添える短い要約 */
export function formatScamSummary(a: ScamAssessment): string {
  if (a.signals.length === 0) return "";
  return a.signals.map((s) => `・${s.label}`).join("\n");
}
