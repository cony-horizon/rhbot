import type { Config } from "../config.js";
import { HOUR_MS, MINUTE_MS } from "./common.js";

/** 観測されたヨコヨコの帯 */
export interface RangeInfo {
  high: number;
  low: number;
  /** 帯の幅。(high / low - 1) * 100 */
  widthPct: number;
  /** 帯を観測できていた長さ */
  durationMs: number;
  samples: number;
}

export interface RawRange {
  high: number;
  low: number;
  samples: number;
  firstTs: number;
  lastTs: number;
}

/**
 * 観測値の集まりが「レンジを組んでいる」と言えるかを判定する。
 *
 * 単に窓内の最大値を取るだけでは、下落の途中の一点を天井と誤認してしまう。
 * ヨコヨコとは値が一定の幅に収まったまま時間が経っている状態なので、
 *   ・帯の幅が狭いこと（＝トレンドではない）
 *   ・十分な長さ観測できていること
 *   ・観測点が足りていること
 * の 3 つを満たして初めてレンジと呼ぶ。
 *
 * この判定は倍率と時間だけで書かれているため、時価総額が $2M でも $50M でも
 * 同じ基準で機能する。銘柄ごとに例を積み増す必要はない。
 */
export function toRange(raw: RawRange | null, cfg: Config): RangeInfo | null {
  if (raw === null) return null;
  if (raw.low <= 0 || raw.high <= 0) return null;
  if (raw.samples < cfg.rangeMinSamples) return null;

  const durationMs = raw.lastTs - raw.firstTs;
  if (durationMs < cfg.rangeMinHours * HOUR_MS) return null;

  const widthPct = (raw.high / raw.low - 1) * 100;
  if (widthPct > cfg.rangeMaxWidthPct) return null;

  return { high: raw.high, low: raw.low, widthPct, durationMs, samples: raw.samples };
}

/**
 * 「直近でいちばん長く続いたレンジ」を探す。
 *
 * 窓を 1 つに固定すると、その中に初動スパイクが入っただけで幅の条件に落ち、
 * その後どれだけきれいにレンジを組んでいても認識できない。
 * （$1.15M まで飛んだあと $280K〜$620K で 12 時間ヨコヨコした銘柄が、まさにこれで漏れた）
 *
 * そこで長い窓から順に試し、最初に成立したものを採る。
 * スパイクを含む窓は落ちて、落ち着いた区間だけが残る。
 */
export function findLongestRange(
  measure: (fromTs: number, toTs: number) => RawRange | null,
  now: number,
  cfg: Config,
): RangeInfo | null {
  const to = now - cfg.revivalRangeExcludeMin * MINUTE_MS;
  for (const hours of candidateWindows(cfg)) {
    const r = toRange(measure(to - hours * HOUR_MS, to), cfg);
    if (r) return r;
  }
  return null;
}

/** 試す窓の長さ（時間）。長い順 */
export function candidateWindows(cfg: Config): number[] {
  const max = Math.max(cfg.rangeMinHours, cfg.rangeWindowHours);
  const out: number[] = [];
  for (let h = max; h > cfg.rangeMinHours; h = Math.floor(h / 1.5)) out.push(h);
  out.push(cfg.rangeMinHours);
  return out;
}
