import { describe, expect, it } from "vitest";
import { toRange } from "../src/detectors/range.js";
import { detectRevival } from "../src/detectors/revival.js";
import { Store } from "../src/store.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();
const H = 3_600_000;

function pair(mc: number) {
  const p = makePair({ symbol: "TKN", ageHours: 80, price: mc / 1e9, volH1: 150_000, volH24: 1_800_000, liq: 300_000, changeH1: 6, changeM5: 2, buysH1: 80, sellsH1: 60 });
  p.marketCap = mc;
  p.fdv = mc;
  return p;
}

const raw = (high: number, low: number, samples = 40, hours = 30) => ({
  high, low, samples, firstTs: NOW - hours * H, lastTs: NOW,
});

describe("toRange — レンジと呼べるかの判定", () => {
  it("狭い帯を十分な期間・件数で観測できていればレンジ", () => {
    const r = toRange(raw(1_500_000, 1_000_000), cfg);
    expect(r).not.toBeNull();
    expect(r?.widthPct).toBeCloseTo(50, 0);
  });

  it("帯が広すぎるものはレンジではない（下落途中を天井と誤認しない）", () => {
    // $5M → $1M と落ち続けている最中。幅 400%
    expect(toRange(raw(5_000_000, 1_000_000), cfg)).toBeNull();
  });

  it("観測期間が短すぎるものはレンジではない", () => {
    expect(toRange(raw(1_500_000, 1_000_000, 40, 3), cfg)).toBeNull();
  });

  it("観測点が足りないものはレンジではない", () => {
    expect(toRange(raw(1_500_000, 1_000_000, 5, 30), cfg)).toBeNull();
  });

  it("判定は倍率と時間だけなので、規模が変わっても同じように効く", () => {
    for (const scale of [1, 10, 100, 1000]) {
      const r = toRange(raw(1_500_000 * scale, 1_000_000 * scale), cfg);
      expect(r?.widthPct).toBeCloseTo(50, 0);
    }
  });

  it("しきい値は設定で変えられる", () => {
    const loose = makeConfig({ RANGE_MAX_WIDTH_PCT: "500" });
    expect(toRange(raw(5_000_000, 1_000_000), loose)).not.toBeNull();
  });
});

describe("再点火 — 規模を問わず同じ基準で成立する", () => {
  const ctx = (mc: number, peakMc: number, range: ReturnType<typeof toRange>) => ({
    now: NOW, pair: pair(mc), ageMs: 80 * H, lastAlert: null,
    lookbackMinPrice: null, baseLowPrice: null, rangeHighPrice: null,
    mcRange: range, baseLowMc: range?.low ?? null, quietMs: 20 * H,
    peakMc, peakMcAt: NOW - 50 * H,
  });

  // 全盛期 / レンジ下限 / レンジ上限 / 上抜け後
  const cases: [string, number, number, number, number][] = [
    ["$5M → $1.0〜1.5M", 5_000_000, 1_000_000, 1_500_000, 1_600_000],
    ["$10M → $4〜6M", 10_000_000, 4_000_000, 6_000_000, 6_400_000],
    ["$50M → $20〜28M", 50_000_000, 20_000_000, 28_000_000, 29_800_000],
    ["$2.2M → $0.9〜1.2M", 2_200_000, 900_000, 1_200_000, 1_280_000],
  ];

  for (const [label, peak, low, high, broke] of cases) {
    it(`${label} のレンジ上抜けを検知する`, () => {
      const r = toRange(raw(high, low), cfg)!;
      expect(r).not.toBeNull();
      const d = detectRevival(ctx(broke, peak, r), cfg);
      expect(d?.display.trigger).toBe("reignite");
      expect(d?.display.mcRange?.high).toBe(high);
    });

    it(`${label} でレンジ内に留まっていれば通知しない`, () => {
      const r = toRange(raw(high, low), cfg)!;
      expect(detectRevival(ctx(high * 1.01, peak, r), cfg)).toBeNull();
    });
  }

  it("レンジが組めていなければ再点火にはならない", () => {
    expect(detectRevival(ctx(1_600_000, 5_000_000, null), cfg)?.display.trigger).not.toBe("reignite");
  });
});

describe("スナップショットからレンジを組み立てる", () => {
  it("ヨコヨコの帯と観測期間を取り出せる", () => {
    const store = new Store(":memory:");
    const p = pair(1_200_000);
    // 30 時間かけて $1.0M〜$1.5M を往復させる
    for (let i = 0; i < 40; i++) {
      const mc = 1_000_000 + (i % 6) * 100_000;
      store.insertSnapshot(pair(mc), NOW - (40 - i) * 45 * 60_000);
    }
    const r = toRange(store.mcRangeBetween(p.pairAddress, NOW - 48 * H, NOW), cfg);
    expect(r).not.toBeNull();
    expect(r?.high).toBe(1_500_000);
    expect(r?.low).toBe(1_000_000);
    expect(r?.samples).toBe(40);
    store.close();
  });

  it("下落し続けている銘柄はレンジとして扱わない", () => {
    const store = new Store(":memory:");
    const p = pair(1_000_000);
    // $5M から $1M へ単調に下落
    for (let i = 0; i < 40; i++) {
      store.insertSnapshot(pair(5_000_000 - i * 100_000), NOW - (40 - i) * 45 * 60_000);
    }
    expect(toRange(store.mcRangeBetween(p.pairAddress, NOW - 48 * H, NOW), cfg)).toBeNull();
    store.close();
  });
});
