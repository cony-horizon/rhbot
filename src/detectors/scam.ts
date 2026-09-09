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
  breadth: Breadth;
}

/**
 * 参加者の厚み。
 *
 * 出来高がプールに対して過大なだけでは、本物の初動ランナーとバンドルを区別できない。
 * 実際 $SNOWBALL（本物）は流動性の 18.1 倍、$PUMPS（バンドル）は 9.1 倍で、
 * 本物のほうが高い。倍率は「熱いかどうか」を測っているだけで、真偽は測っていない。
 *
 * 分かれるのはこちら:
 *   件数     11,811 対 1,204
 *   平均取引額  $144 対 $663
 *   買いの比率   51% 対 73%
 *
 * 小口が大量に、売り買い拮抗で流れているのは、多数の独立した参加者がいる証拠になる。
 * 少数のウォレットが大きな玉を一方向に回すのとは形が違う。
 *
 * このうち「件数の多さ」と「小口であること」は必須にしている。
 * 件数と均衡だけを装って大口を往復させる洗浄取引が、厚みを抜け道にできてしまうため。
 * 売り買いの均衡は加点扱い。初動ランナーは買い偏重になることがあり、必須にすると本物を落とす。
 */
export interface Breadth {
  txns: number;
  avgTradeUsd: number;
  buyShare: number;
  /** 満たした条件の数 (0-3) */
  points: number;
  /** 件数が十分か（必須条件） */
  manyTxns: boolean;
  /** 小口中心か（必須条件） */
  smallLots: boolean;
  /** 厚みが確認できたか。true なら出来高比の指標は真偽の証拠にならない */
  organic: boolean;
  reasons: string[];
}

/**
 * 厚みを認める取引件数の下限。規模で変える。
 *
 * $200K の銘柄に $1M クラスと同じ件数を求めると、実需があっても永遠に届かない。
 * 逆にこの下限を一律で下げると、大型でバンドルされたものまで通ってしまう。
 *
 * この関数を検知と判定の両方から呼ぶことが重要で、片方だけ緩めると
 * 「出来高が伴っているから通知する」と「出来高が過大だから危険」を
 * 同じ銘柄について同時に言うことになる。
 */
export function breadthTxnBar(mc: number, cfg: Config): number {
  return mc > 0 && mc < cfg.scamBreadthSmallMcUsd ? cfg.scamBreadthSmallMinTxns : cfg.scamBreadthMinTxns;
}

export function assessBreadth(pair: DexPair, cfg: Config, minTxns?: number): Breadth {
  const b = buys(pair, "h1");
  const sl = sells(pair, "h1");
  const txns = b + sl;
  const volH1 = vol(pair, "h1");
  const avgTradeUsd = txns > 0 ? volH1 / txns : 0;
  const buyShare = txns > 0 ? b / txns : 0;
  const reasons: string[] = [];
  let points = 0;

  const mc = pair.marketCap && pair.marketCap > 0 ? pair.marketCap : (pair.fdv ?? 0);
  const bar = minTxns ?? breadthTxnBar(mc, cfg);
  const manyTxns = txns >= bar;
  if (manyTxns) {
    points++;
    reasons.push(`取引 ${txns.toLocaleString("en-US")} 件`);
  }
  const smallLots = avgTradeUsd >= cfg.scamMinAvgTradeUsd && avgTradeUsd <= cfg.scamBreadthMaxAvgUsd;
  if (smallLots) {
    points++;
    reasons.push(`平均 $${avgTradeUsd.toFixed(0)} の小口中心`);
  }
  if (txns > 0 && buyShare >= cfg.scamBreadthBalance && buyShare <= 1 - cfg.scamBreadthBalance) {
    points++;
    reasons.push(`売り買い拮抗（買い ${Math.round(buyShare * 100)}%）`);
  }

  // 必須 2 条件に加えて、設定した点数を満たしたときだけ厚みを認める。
  // SCAM_BREADTH_NEEDED=3 にすると売り買いの均衡も必須になる。
  const organic = manyTxns && smallLots && points >= cfg.scamBreadthNeeded;
  return { txns, avgTradeUsd, buyShare, points, manyTxns, smallLots, organic, reasons };
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

  // 厚みが確認できた銘柄では、出来高の多さを作り物の根拠にしない。
  // 本物の初動ランナーはプールを何倍も回すので、そこを咎めると熱い銘柄ほど弾いてしまう。
  const breadth = assessBreadth(pair, cfg);

  // ① 出来高 ÷ 流動性。もっとも強い指標。
  // 実需なら 1 時間でプールの数倍を超えることは稀で、超えるほど自己取引で回している疑いが濃い。
  if (liq > 0 && !breadth.organic) {
    const churn = volH1 / liq;
    if (churn >= cfg.scamChurnHigh) {
      add("churn", 35, `1h 出来高が流動性の ${churn.toFixed(1)} 倍（洗浄取引の疑い）`);
    } else if (churn >= cfg.scamChurnMid) {
      add("churn", 18, `1h 出来高が流動性の ${churn.toFixed(1)} 倍`);
    }
  }

  // ② 出来高 ÷ 時価総額。時価総額に匹敵する額が 1 時間で動くのは通常ありえない。
  if (mc > 0 && !breadth.organic) {
    const turnover = volH1 / mc;
    if (turnover >= 0.8) {
      add("turnover", 20, `1h で時価総額の ${(turnover * 100).toFixed(0)}% が取引された`);
    } else if (turnover >= 0.4) {
      add("turnover", 10, `1h で時価総額の ${(turnover * 100).toFixed(0)}% が取引された`);
    }
  }

  // ③ 流動性 ÷ FDV。低いほど「値札だけ高く、実際には抜けられない」状態。
  //
  // 段階を付けている。$CUPCAKE は流動性 $864 に時価総額 $59.6M（0.0014%）で、
  // $3 の買いが入るたびに値札だけ階段状に上がっていた。通知時点でも 0.5% 前後だったはずで、
  // 1.9% と同じ +25 しか付かず、しきい値を 5 点下回って通ってしまった。
  // 1% を切ればプール全部を売っても値が付かない。0.2% を切れば、それ単独で作り物と断じてよい。
  if (mc > 0 && liq > 0) {
    const depth = liq / mc;
    const pct = depth * 100;
    if (pct < cfg.scamDepthDeadPct) {
      add("depth", 55, `流動性が時価総額の ${pct < 0.01 ? pct.toFixed(4) : pct.toFixed(2)}% しかない（枯れたプールに値札だけ）`);
    } else if (pct < cfg.scamDepthSeverePct) {
      add("depth", 40, `流動性が時価総額の ${pct.toFixed(2)}% しかない（プール全部を売っても値が付かない）`);
    } else if (depth < cfg.scamMinDepthPct / 100) {
      add("depth", 25, `流動性が時価総額の ${pct.toFixed(1)}% しかない（売り抜けられない）`);
    } else if (depth < (cfg.scamMinDepthPct * 2.5) / 100) {
      add("depth", 12, `流動性が時価総額の ${pct.toFixed(1)}% と薄い`);
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
  if (!breadth.organic && ageMs !== null && ageMs < 60 * MINUTE_MS && liq > 0 && volH1 >= liq * 3) {
    add("instant_volume", 15, `ローンチ ${Math.round(ageMs / MINUTE_MS)} 分で流動性の ${(volH1 / liq).toFixed(1)} 倍の出来高（バンドルの疑い）`);
  }

  const score = Math.min(100, signals.reduce((n, s) => n + s.points, 0));
  return { score, signals, breadth };
}

/** 通知に添える短い要約 */
export function formatScamSummary(a: ScamAssessment): string {
  if (a.signals.length === 0) return "";
  return a.signals.map((s) => `・${s.label}`).join("\n");
}
