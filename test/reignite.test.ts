import { describe, expect, it } from "vitest";
import { detectRevival } from "../src/detectors/revival.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();
const H = 3_600_000;

/**
 * 利用者が最も掴みたい型:
 *   ローンチで $2〜3M/h → $1M/h → 落ちる → レンジを組む → 上抜ける
 */
function pastGlory(price: number, volH1: number) {
  const p = makePair({
    symbol: "PHNX",
    ageHours: 60,
    price,
    volH1,
    volH24: volH1 * 12,
    liq: 260_000,
    changeH1: 8,
    changeM5: 2,
    buysH1: 90,
    sellsH1: 70,
  });
  p.marketCap = 3_100_000;
  p.fdv = 3_100_000;
  return p;
}

const ctx = (price: number, volH1: number, rangeHigh: number | null, peakVol: number) => ({
  now: NOW,
  pair: pastGlory(price, volH1),
  ageMs: 60 * H,
  lastAlert: null,
  lookbackMinPrice: 0.0009,
  baseLowPrice: 0.0008,
  rangeHighPrice: rangeHigh,
  quietMs: 20 * H,
  peakVolH1: peakVol,
  peakVolAt: NOW - 40 * H,
});

describe("再点火（元大物のレンジ抜け）", () => {
  it("全盛期 $2.8M/h の銘柄が冷えたあとレンジを抜けたら検知する", () => {
    const d = detectRevival(ctx(0.00126, 180_000, 0.00118, 2_800_000), cfg);
    expect(d).not.toBeNull();
    expect(d?.display.trigger).toBe("reignite");
    expect(d?.reason).toContain("全盛期");
    expect(d?.display.peakVolH1).toBe(2_800_000);
  });

  it("汎用のレンジ抜けより早く成立する", () => {
    // レンジ上限 +7%: 再点火は成立、汎用(12%)はまだ
    const withPeak = detectRevival(ctx(0.001263, 180_000, 0.00118, 2_800_000), cfg);
    const noPeak = detectRevival(ctx(0.001263, 180_000, 0.00118, 0), cfg);
    expect(withPeak?.display.trigger).toBe("reignite");
    expect(noPeak).toBeNull();
  });

  it("全盛期が無い銘柄には適用しない（確度の担保が無いため）", () => {
    const d = detectRevival(ctx(0.00126, 180_000, 0.00118, 50_000), cfg);
    expect(d).toBeNull();
  });

  it("まだ冷えていない（全盛期並みに動いている）銘柄は再点火ではない", () => {
    // いま $2.5M/h = 全盛期の 89%。レンジも組んでいないので該当しない
    const d = detectRevival(ctx(0.00126, 2_500_000, 0.00118, 2_800_000), cfg);
    expect(d?.display.trigger).not.toBe("reignite");
  });

  it("レンジ内に留まっているうちは通知しない", () => {
    expect(detectRevival(ctx(0.00119, 180_000, 0.00118, 2_800_000), cfg)).toBeNull();
  });

  it("しきい値は設定で変えられる", () => {
    const strict = makeConfig({ REIGNITE_MIN_PEAK_VOL_USD: "5000000" });
    expect(detectRevival(ctx(0.00126, 180_000, 0.00118, 2_800_000), strict)?.display.trigger).not.toBe("reignite");
  });
});

describe("全盛期の記録", () => {
  it("出来高が落ちても全盛期は残り続ける", () => {
    const store = new Store(":memory:");
    const hot = pastGlory(0.0025, 2_800_000);
    store.upsertPair(hot, "test", NOW - 40 * H);
    // 40時間後、出来高は 1/15 に冷え込む
    const cold = pastGlory(0.0011, 180_000);
    store.upsertPair(cold, "test", NOW);
    const row = store.getPair(hot.pairAddress)!;
    expect(row.peak_vol_h1).toBe(2_800_000);
    expect(row.peak_vol_at).toBe(NOW - 40 * H);
    expect(row.last_vol_h1).toBe(180_000);
    store.close();
  });

  it("全盛期の大きい銘柄は、静かでも優先監視の対象になる", () => {
    const store = new Store(":memory:");
    store.upsertPair(pastGlory(0.0025, 2_800_000), "test", NOW - 40 * H);
    const small = makePair({ address: "0xsmall", token: "0xsmalltoken", volH1: 900 });
    store.upsertPair(small, "test", NOW - 40 * H);
    const rows = store.listPriorityForRefresh(300_000, NOW, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peak_vol_h1).toBe(2_800_000);
    expect(store.countPriority(300_000)).toBe(1);
    store.close();
  });

  it("古い DB でも移行して全盛期を記録できる", () => {
    const store = new Store(":memory:");
    const p = pastGlory(0.002, 1_500_000);
    store.upsertPair(p, "test", NOW);
    expect(store.getPair(p.pairAddress)!.peak_vol_h1).toBe(1_500_000);
    store.close();
  });
});
