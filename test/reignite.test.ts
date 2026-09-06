import { describe, expect, it } from "vitest";
import { detectRevival } from "../src/detectors/revival.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();
const H = 3_600_000;

/**
 * 利用者が最も掴みたい型:
 *   初動で MC $5M → 下がる → $1.0〜1.5M でレンジを組む → 上抜ける
 */
function pastGlory(mc: number, volH1 = 180_000) {
  const p = makePair({
    symbol: "PHNX",
    ageHours: 60,
    price: mc / 1_000_000_000, // 供給 10 億枚として時価総額から逆算
    volH1,
    volH24: volH1 * 12,
    liq: 260_000,
    changeH1: 8,
    changeM5: 2,
    buysH1: 90,
    sellsH1: 70,
  });
  p.marketCap = mc;
  p.fdv = mc;
  return p;
}

/** レンジ上限 $1.5M、底 $1.0M、全盛期 $5M */
const ctx = (mc: number, rangeHighMc: number | null, peakMc: number, volH1 = 180_000) => ({
  now: NOW,
  pair: pastGlory(mc, volH1),
  ageMs: 60 * H,
  lastAlert: null,
  lookbackMinPrice: 0.0000009,
  baseLowPrice: 0.0000008,
  rangeHighPrice: null,
  rangeHighMc,
  baseLowMc: 1_000_000,
  quietMs: 20 * H,
  peakMc,
  peakMcAt: NOW - 40 * H,
});

describe("再点火（元大物のレンジ抜け）", () => {
  it("MC $5M をつけた銘柄が $1.5M のレンジを抜けたら検知する", () => {
    const d = detectRevival(ctx(1_600_000, 1_500_000, 5_000_000), cfg);
    expect(d).not.toBeNull();
    expect(d?.display.trigger).toBe("reignite");
    expect(d?.reason).toContain("全盛期 MC");
    expect(d?.display.peakMc).toBe(5_000_000);
    expect(d?.display.currentMc).toBe(1_600_000);
    // 全盛期の 32% まで冷えている
    expect(d?.display.cooledRatio).toBeCloseTo(0.32, 2);
  });

  it("汎用のレンジ抜けより早く成立する", () => {
    // レンジ上限 +7%: 全盛期のある銘柄は成立、無い銘柄はまだ
    const withPeak = detectRevival(ctx(1_605_000, 1_500_000, 5_000_000), cfg);
    const noPeak = detectRevival(ctx(1_605_000, 1_500_000, 0), cfg);
    expect(withPeak?.display.trigger).toBe("reignite");
    expect(noPeak).toBeNull();
  });

  it("全盛期の時価総額が小さい銘柄には適用しない（確度の担保が無いため）", () => {
    expect(detectRevival(ctx(1_600_000, 1_500_000, 200_000), cfg)).toBeNull();
  });

  it("まだ冷えていない（全盛期に近い）銘柄は再点火ではない", () => {
    // いま MC $4.5M = 全盛期の 90%
    const d = detectRevival(ctx(4_500_000, 4_200_000, 5_000_000), cfg);
    expect(d?.display.trigger).not.toBe("reignite");
  });

  it("レンジ内に留まっているうちは通知しない", () => {
    expect(detectRevival(ctx(1_520_000, 1_500_000, 5_000_000), cfg)).toBeNull();
  });

  it("底値からの上昇率も時価総額で示す", () => {
    const d = detectRevival(ctx(1_600_000, 1_500_000, 5_000_000), cfg);
    // 底 $1.0M → いま $1.6M = +60%
    expect(d?.display.baseRisePct).toBeCloseTo(60, 0);
  });

  it("しきい値は設定で変えられる", () => {
    const strict = makeConfig({ REIGNITE_MIN_PEAK_MC_USD: "20000000" });
    expect(detectRevival(ctx(1_600_000, 1_500_000, 5_000_000), strict)?.display.trigger).not.toBe("reignite");
  });
});

describe("全盛期の記録", () => {
  it("時価総額が落ちても全盛期は残り続ける", () => {
    const store = new Store(":memory:");
    const hot = pastGlory(5_000_000);
    store.upsertPair(hot, "test", NOW - 40 * H);
    // 40時間後、$1.2M まで冷え込む
    store.upsertPair(pastGlory(1_200_000), "test", NOW);
    const row = store.getPair(hot.pairAddress)!;
    expect(row.peak_mc).toBe(5_000_000);
    expect(row.peak_mc_at).toBe(NOW - 40 * H);
    store.close();
  });

  it("全盛期の時価総額が大きい銘柄は、静かでも優先監視の対象になる", () => {
    const store = new Store(":memory:");
    store.upsertPair(pastGlory(5_000_000), "test", NOW - 40 * H);
    const small = makePair({ address: "0xsmall", token: "0xsmalltoken", volH1: 900 });
    small.marketCap = 80_000;
    small.fdv = 80_000;
    store.upsertPair(small, "test", NOW - 40 * H);
    const rows = store.listPriorityForRefresh(1_000_000, NOW, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peak_mc).toBe(5_000_000);
    expect(store.countPriority(1_000_000)).toBe(1);
    store.close();
  });

  it("スナップショットから時価総額のレンジを測れる", () => {
    const store = new Store(":memory:");
    const p = pastGlory(1_200_000);
    // $1.0M〜$1.5M を往復するヨコヨコを記録する
    for (const [i, mc] of [1_000_000, 1_500_000, 1_100_000, 1_450_000, 1_200_000].entries()) {
      store.insertSnapshot(pastGlory(mc), NOW - (10 - i) * H);
    }
    expect(store.maxMcBetween(p.pairAddress, NOW - 12 * H, NOW)).toBe(1_500_000);
    expect(store.minMcSince(p.pairAddress, NOW - 12 * H)).toBe(1_000_000);
    expect(store.countMcSnapshotsBetween(p.pairAddress, NOW - 12 * H, NOW)).toBe(5);
    store.close();
  });
});
