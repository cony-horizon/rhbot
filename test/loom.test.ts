import { describe, expect, it } from "vitest";
import { candidateWindows, findLongestRange, toRange } from "../src/detectors/range.js";
import { detectRevival } from "../src/detectors/revival.js";
import { Store } from "../src/store.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const H = 3_600_000;
const M = 60_000;
const cfg = makeConfig();

/**
 * 報告された $LOOM の形（26日経過）:
 *   初動で MC $1.15M → 崩れて $280K〜$620K で 12 時間ヨコヨコ → 上抜け
 * スパイクを含む長い窓は幅の条件で落ち、落ち着いた区間だけがレンジとして残るのが要件。
 */
function loomPair(mc: number) {
  const p = makePair({
    symbol: "LOOM",
    address: "0xloom",
    token: "0xloomtoken",
    ageHours: 26 * 24,
    price: mc / 1e9,
    volH1: 90_000,
    volH24: 700_000,
    liq: 150_000,
    changeH1: 15,
    changeM5: 4,
    buysH1: 120,
    sellsH1: 80,
  });
  p.marketCap = mc;
  p.fdv = mc;
  return p;
}

/** スパイク → レンジ の履歴をスナップショットとして書き込む */
function seedHistory(store: Store): void {
  // 20〜14 時間前: 初動スパイク（$400K → $1.15M → $500K）
  const spike = [400_000, 700_000, 1_150_000, 900_000, 620_000, 500_000];
  spike.forEach((mc, k) => store.insertSnapshot(loomPair(mc), NOW - (20 - k) * H));
  // 13 時間前〜現在: $280K〜$620K を往復（15 分刻み）
  const band = [420_000, 560_000, 340_000, 620_000, 300_000, 480_000, 280_000, 520_000];
  for (let k = 0; k < 52; k++) {
    store.insertSnapshot(loomPair(band[k % band.length]!), NOW - 13 * H + k * 15 * M);
  }
}

describe("$LOOM — スパイク後のレンジ抜け", () => {
  it("長い窓はスパイクを含んで落ち、落ち着いた区間だけがレンジになる", () => {
    const store = new Store(":memory:");
    seedHistory(store);
    // 20 時間の窓はスパイクを含むので成立しない
    const wide = toRange(store.mcRangeBetween("0xloom", NOW - 20 * H, NOW), cfg);
    expect(wide).toBeNull();
    // 走査させれば、レンジ部分だけが見つかる
    const found = findLongestRange((f, t) => store.mcRangeBetween("0xloom", f, t), NOW, cfg);
    expect(found).not.toBeNull();
    expect(found!.high).toBe(620_000);
    expect(found!.low).toBe(280_000);
    expect(found!.widthPct).toBeCloseTo(121, 0);
    store.close();
  });

  it("レンジ上限 $620K を抜けた時点で再点火として検知する", () => {
    const store = new Store(":memory:");
    seedHistory(store);
    const range = findLongestRange((f, t) => store.mcRangeBetween("0xloom", f, t), NOW, cfg);
    const d = detectRevival(
      {
        now: NOW,
        pair: loomPair(670_000), // レンジ上限の +8%
        ageMs: 26 * 24 * H,
        lastAlert: null,
        lookbackMinPrice: 280_000 / 1e9,
        baseLowPrice: 280_000 / 1e9,
        rangeHighPrice: null,
        mcRange: range,
        baseLowMc: 280_000,
        quietMs: 13 * H,
        peakMc: 1_150_000,
        peakMcAt: NOW - 18 * H,
      },
      cfg,
    );
    expect(d).not.toBeNull();
    expect(d!.display.trigger).toBe("reignite");
    expect(d!.display.mcRange!.high).toBe(620_000);
    // 実際の高値 $1.67M よりはるか手前で鳴る
    expect(670_000).toBeLessThan(1_670_000 * 0.45);
    store.close();
  });

  it("レンジ内に留まっているうちは鳴らない", () => {
    const store = new Store(":memory:");
    seedHistory(store);
    const range = findLongestRange((f, t) => store.mcRangeBetween("0xloom", f, t), NOW, cfg);
    const ctx = (mc: number) => ({
      now: NOW, pair: loomPair(mc), ageMs: 26 * 24 * H, lastAlert: null,
      lookbackMinPrice: null, baseLowPrice: null, rangeHighPrice: null,
      mcRange: range, baseLowMc: 280_000, quietMs: 13 * H, peakMc: 1_150_000, peakMcAt: NOW - 18 * H,
    });
    expect(detectRevival(ctx(600_000), cfg)?.display.trigger).not.toBe("reignite");
    expect(detectRevival(ctx(640_000), cfg)?.display.trigger).not.toBe("reignite"); // +3%、まだ足りない
  });

  it("初動ピークが下限を下回る銘柄は再点火にしない", () => {
    const store = new Store(":memory:");
    seedHistory(store);
    const range = findLongestRange((f, t) => store.mcRangeBetween("0xloom", f, t), NOW, cfg);
    const d = detectRevival(
      { now: NOW, pair: loomPair(670_000), ageMs: 26 * 24 * H, lastAlert: null, lookbackMinPrice: null, baseLowPrice: null,
        rangeHighPrice: null, mcRange: range, baseLowMc: 280_000, quietMs: 13 * H, peakMc: 300_000, peakMcAt: NOW - 18 * H },
      cfg,
    );
    expect(d?.display.trigger).not.toBe("reignite");
    store.close();
  });

  it("価格側のレンジも同じ走査を使い、スパイクを抵抗線にしない", () => {
    const store = new Store(":memory:");
    seedHistory(store);
    const r = findLongestRange((f, t) => store.priceRangeBetween("0xloom", f, t), NOW, cfg);
    expect(r).not.toBeNull();
    // スパイク $1.15M ではなくレンジ上限 $620K が天井になる
    expect(r!.high).toBeCloseTo(620_000 / 1e9, 12);
    store.close();
  });
});

describe("candidateWindows", () => {
  it("長い順に並び、最短は下限に一致する", () => {
    const w = candidateWindows(makeConfig({ RANGE_WINDOW_HOURS: "48", RANGE_MIN_HOURS: "12" }));
    expect(w[0]).toBe(48);
    expect(w.at(-1)).toBe(12);
    expect([...w]).toEqual([...w].sort((a, b) => b - a));
  });

  it("窓と下限が同じなら 1 つだけ", () => {
    expect(candidateWindows(makeConfig({ RANGE_WINDOW_HOURS: "12", RANGE_MIN_HOURS: "12" }))).toEqual([12]);
  });
});
