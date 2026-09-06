import { describe, expect, it } from "vitest";
import { assessScam } from "../src/detectors/scam.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();

/** 利用者が報告した実物: $PUMPS (OnlyPumps) — バンドルで出来高を作られたスキャム */
function pumpsScam() {
  const p = makePair({
    symbol: "PUMPS",
    ageHours: 41 / 60,
    price: 0.0007393,
    volH1: 798_000,
    volH24: 798_000,
    liq: 88_000,
    buysH1: 878,
    sellsH1: 326,
    changeH1: 33_753,
  });
  p.fdv = 855_000;
  p.marketCap = 855_000;
  return p;
}

describe("assessScam — 報告された実物で検証", () => {
  it("$PUMPS を高スコアで危険と判定する", () => {
    const a = assessScam(pumpsScam(), cfg, NOW);
    expect(a.score).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
    const ids = a.signals.map((s) => s.id);
    expect(ids).toContain("churn");
    expect(ids).toContain("turnover");
    expect(ids).toContain("thin_pump");
    expect(ids).toContain("instant_volume");
  });

  it("判定理由が日本語で読める形になっている", () => {
    const a = assessScam(pumpsScam(), cfg, NOW);
    expect(a.signals.some((s) => s.label.includes("洗浄取引"))).toBe(true);
    expect(a.signals.some((s) => s.label.includes("バンドル"))).toBe(true);
  });
});

describe("assessScam — 正常な銘柄を誤って弾かない", () => {
  it("健全な復活スパイクは低スコア", () => {
    // 40h 経過、流動性 $220K、1h 出来高 $85K、+42%
    const p = makePair({ ageHours: 40, volH1: 85_000, volH24: 110_000, liq: 220_000, price: 0.00045, changeH1: 42, buysH1: 142, sellsH1: 38 });
    p.fdv = 4_520_000;
    p.marketCap = 4_520_000;
    const a = assessScam(p, cfg, NOW);
    expect(a.score).toBeLessThan(cfg.scamScoreThreshold);
  });

  it("健全な新規ローンチは低スコア", () => {
    const p = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 45_000, changeH1: 120, buysH1: 90, sellsH1: 60 });
    p.fdv = 600_000;
    p.marketCap = 600_000;
    const a = assessScam(p, cfg, NOW);
    expect(a.score).toBeLessThan(cfg.scamScoreThreshold);
  });

  it("大型で活発な銘柄を出来高の多さだけで弾かない", () => {
    const p = makePair({ ageHours: 200, volH1: 900_000, volH24: 12_000_000, liq: 2_000_000, changeH1: 15, buysH1: 800, sellsH1: 700 });
    p.fdv = 40_000_000;
    p.marketCap = 40_000_000;
    const a = assessScam(p, cfg, NOW);
    expect(a.score).toBeLessThan(cfg.scamScoreThreshold);
  });
});

describe("assessScam — 個別の指標", () => {
  it("流動性に対して出来高が過大なら churn が立つ", () => {
    const p = makePair({ ageHours: 50, volH1: 500_000, volH24: 600_000, liq: 50_000 });
    p.marketCap = 5_000_000;
    expect(assessScam(p, cfg, NOW).signals.map((s) => s.id)).toContain("churn");
  });

  it("流動性が時価総額に対して薄すぎると depth が立つ", () => {
    const p = makePair({ ageHours: 50, volH1: 1_000, volH24: 5_000, liq: 10_000 });
    p.marketCap = 10_000_000; // 0.1%
    expect(assessScam(p, cfg, NOW).signals.map((s) => s.id)).toContain("depth");
  });

  it("塵のような小口取引が大量にあると dust が立つ", () => {
    const p = makePair({ ageHours: 50, volH1: 3_000, volH24: 10_000, liq: 100_000, buysH1: 200, sellsH1: 100 });
    p.marketCap = 1_000_000;
    expect(assessScam(p, cfg, NOW).signals.map((s) => s.id)).toContain("dust");
  });

  it("データが欠けていても落ちない", () => {
    const p = makePair({ ageHours: 50 });
    p.liquidity = undefined;
    p.fdv = undefined;
    p.marketCap = undefined;
    p.pairCreatedAt = undefined;
    expect(() => assessScam(p, cfg, NOW)).not.toThrow();
  });

  it("フィルタのしきい値は設定で変えられる", () => {
    const loose = makeConfig({ SCAM_CHURN_HIGH: "50", SCAM_CHURN_MID: "40" });
    const a = assessScam(pumpsScam(), loose, NOW);
    expect(a.signals.map((s) => s.id)).not.toContain("churn");
  });
});
