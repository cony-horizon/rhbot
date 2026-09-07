import type { DexPair } from "../dexscreener.js";
import type { AlertKind, AlertRow } from "../store.js";
import type { RangeInfo } from "./range.js";
import type { Breadth } from "./scam.js";

export interface DetectorContext {
  now: number;
  pair: DexPair;
  /** ペア作成からの経過ミリ秒。pairCreatedAt が無い場合 null */
  ageMs: number | null;
  /** 同一 base トークンに対する同種の直近アラート */
  lastAlert: AlertRow | null;
  /** 自前スナップショットの lookback 期間中の最安値（無ければ null） */
  lookbackMinPrice: number | null;
  /** ヨコヨコの底。より長い窓での最安値（無ければ null） */
  baseLowPrice?: number | null;
  /** 直近で今と同等に活発だった時点からの経過時間＝静穏だった長さ */
  quietMs?: number | null;
  /** 直近の値動きを除いた、ヨコヨコ期間の高値＝レンジ上限（無ければ null） */
  rangeHighPrice?: number | null;
  /** この銘柄が記録した最高時価総額＝全盛期の評価額 */
  peakMc?: number;
  /** 全盛期を記録した時刻 */
  peakMcAt?: number | null;
  /** 成立が確認できたヨコヨコの帯（時価総額）。組めていなければ null */
  mcRange?: RangeInfo | null;
  /** ヨコヨコ期間の時価総額の底 */
  baseLowMc?: number | null;
}

export interface DetectionMetrics {
  priceUsd: number;
  volH1: number;
  volH24: number;
  liquidityUsd: number;
  buysH1: number;
  sellsH1: number;
  priceChangeH1: number | null;
  priceChangeM5: number | null;
  /** 復活検知のみ: lookback 最安値からの上昇率 */
  lookbackChangePct: number | null;
  /** 復活検知のみ: 1h 出来高 ÷ 直前 23h 平均 1h 出来高 */
  volSpikeRatio: number | null;
}

export interface Detection {
  kind: AlertKind;
  level: number;
  /** 段階通知の総数（new_launch のみ意味を持つ） */
  levelCount: number;
  reason: string;
  metrics: DetectionMetrics;
  /** 通知の見せ方に使う情報。検知ロジックとは分けて持つ */
  display: DetectionDisplay;
}

export interface DetectionDisplay {
  /** 復活: ヨコヨコの底からの上昇率 */
  baseRisePct?: number | null;
  /** 復活: 静穏だった長さ */
  quietMs?: number | null;
  /** 復活: m5 の急騰で早期に拾ったか */
  viaFastLane?: boolean;
  /** 復活: 価格のレンジ上限をどれだけ上抜けたか */
  breakoutPct?: number | null;
  /** 再点火: 時価総額のレンジ上限をどれだけ上抜けたか */
  mcBreakoutPct?: number | null;
  /** どの経路で拾ったか */
  trigger?: "reignite" | "dormant" | "breakout" | "fast" | "new" | "new_lowmc";
  /** 再点火: 全盛期の時価総額 */
  peakMc?: number | null;
  /** 再点火: 全盛期からの経過 */
  peakAgoMs?: number | null;
  /** 再点火: いまの時価総額が全盛期の何割か */
  cooledRatio?: number | null;
  /** 再点火: 抜けたレンジ（時価総額） */
  mcRange?: RangeInfo | null;
  /** 現在の時価総額 */
  currentMc?: number | null;
  /** 低時価総額レーン: 1h 出来高が時価総額の何倍か */
  lowMcVolToMc?: number | null;
  /** 低時価総額レーン: 通す根拠になった参加者の厚み */
  breadth?: Breadth | null;
}
