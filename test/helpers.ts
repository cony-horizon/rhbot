import { buildConfig, type Config } from "../src/config.js";
import type { DexPair } from "../src/dexscreener.js";

export const NOW = Date.parse("2026-09-04T12:00:00Z");
export const H = 3_600_000;

export function makeConfig(overrides: Record<string, string> = {}): Config {
  return buildConfig(
    {
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
      RPC_URL: "",
      ...overrides,
    },
    true,
  );
}

export interface PairOpts {
  address?: string;
  token?: string;
  symbol?: string;
  ageHours?: number;
  price?: number;
  volM5?: number;
  volH1?: number;
  volH6?: number;
  volH24?: number;
  liq?: number;
  buysH1?: number;
  sellsH1?: number;
  changeH1?: number;
  changeM5?: number;
  quote?: string;
  chainId?: string;
}

export function makePair(o: PairOpts = {}): DexPair {
  const volH1 = o.volH1 ?? 0;
  const volH24 = o.volH24 ?? volH1;
  return {
    chainId: o.chainId ?? "robinhood",
    dexId: "uniswap",
    url: `https://dexscreener.com/robinhood/${o.address ?? "0xpair"}`,
    pairAddress: o.address ?? "0xPAIR000000000000000000000000000000000001",
    labels: ["v3"],
    baseToken: { address: o.token ?? "0xTOKEN0000000000000000000000000000000001", name: "Test Cat", symbol: o.symbol ?? "TCAT" },
    quoteToken: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", name: "Wrapped Ether", symbol: o.quote ?? "WETH" },
    priceNative: "0.0000001",
    priceUsd: String(o.price ?? 0.001),
    txns: { m5: { buys: 3, sells: 1 }, h1: { buys: o.buysH1 ?? 30, sells: o.sellsH1 ?? 10 }, h6: { buys: 50, sells: 20 }, h24: { buys: 100, sells: 40 } },
    volume: { m5: o.volM5 ?? 0, h1: volH1, h6: o.volH6 ?? volH1, h24: volH24 },
    priceChange: { m5: o.changeM5 ?? 0, h1: o.changeH1 ?? 0, h6: 0, h24: 0 },
    liquidity: { usd: o.liq ?? 20_000, base: 0, quote: 0 },
    // 新規ローンチの時価総額下限($1M)より上を既定にする。
    // 各テストの主題は時価総額ではないので、ここで引っかからないようにしておく
    fdv: 2_000_000,
    marketCap: 2_000_000,
    pairCreatedAt: NOW - (o.ageHours ?? 1) * H,
  };
}
