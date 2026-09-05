import type { DexPair } from "../dexscreener.js";
import type { AlertKind, AlertRow } from "../store.js";

export interface DetectorContext {
  now: number;
  pair: DexPair;
  /** ペア作成からの経過ミリ秒。pairCreatedAt が無い場合 null */
  ageMs: number | null;
  /** 同一 base トークンに対する同種の直近アラート */
  lastAlert: AlertRow | null;
  /** 自前スナップショットの lookback 期間中の最安値（無ければ null） */
  lookbackMinPrice: number | null;
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
}
