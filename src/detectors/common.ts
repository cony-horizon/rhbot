import type { Config } from "../config.js";
import { buys, liquidityUsd, priceChange, priceUsd, sells, vol, type DexPair } from "../dexscreener.js";
import type { DetectionMetrics } from "./types.js";

export function passesCommonFilters(pair: DexPair, cfg: Config): boolean {
  if (priceUsd(pair) === null) return false;
  if (liquidityUsd(pair) < cfg.minLiquidityUsd) return false;
  if (cfg.quoteSymbols.length > 0) {
    const q = (pair.quoteToken?.symbol ?? "").toUpperCase();
    if (!cfg.quoteSymbols.includes(q)) return false;
  }
  return true;
}

export function baseMetrics(pair: DexPair): DetectionMetrics {
  return {
    priceUsd: priceUsd(pair) ?? 0,
    volH1: vol(pair, "h1"),
    volH24: vol(pair, "h24"),
    liquidityUsd: liquidityUsd(pair),
    buysH1: buys(pair, "h1"),
    sellsH1: sells(pair, "h1"),
    priceChangeH1: priceChange(pair, "h1"),
    priceChangeM5: priceChange(pair, "m5"),
    lookbackChangePct: null,
    volSpikeRatio: null,
  };
}

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
