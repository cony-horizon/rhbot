import { describe, expect, it } from "vitest";
import { assessBreadth, assessScam } from "../src/detectors/scam.js";
import { detectNewLaunch } from "../src/detectors/newLaunch.js";
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

/**
 * 利用者が報告した実物: $SNOWBALL (0xb19f5a6E…) — 本物の初動ランナー
 *
 * 出来高比では $PUMPS より「悪く」見える（流動性の 18.1 倍 対 9.1 倍）のに本物。
 * 倍率は熱さの指標であって真偽の指標ではない、という反例そのもの。
 */
function snowballLegit() {
  const p = makePair({
    symbol: "SNOWBALL",
    ageHours: 22 / 60,
    price: 0.001031,
    volH1: 1_700_000,
    volH24: 1_700_000,
    liq: 94_000,
    buysH1: 6033,
    sellsH1: 5778,
    changeH1: 1900,
  });
  p.fdv = 1_000_000;
  p.marketCap = 1_000_000;
  return p;
}

describe("assessBreadth — 参加者の厚みで本物とバンドルを分ける", () => {
  it("$SNOWBALL は厚みが揃う（小口・大量・売り買い拮抗）", () => {
    const b = assessBreadth(snowballLegit(), cfg);
    expect(b.txns).toBe(11_811);
    expect(b.avgTradeUsd).toBeCloseTo(144, 0);
    expect(b.buyShare).toBeCloseTo(0.51, 2);
    expect(b.points).toBe(3);
    expect(b.organic).toBe(true);
  });

  it("$PUMPS は必須条件（小口）を満たさないので厚みと認めない", () => {
    const b = assessBreadth(pumpsScam(), cfg);
    expect(b.txns).toBe(1_204);
    expect(b.avgTradeUsd).toBeGreaterThan(cfg.scamBreadthMaxAvgUsd);
    expect(b.buyShare).toBeGreaterThan(1 - cfg.scamBreadthBalance);
    // 時価総額 $855K は小型側なので件数の下限は下がり、件数だけは満たす。
    // それでも大口中心である以上、厚みとは認めない
    expect(b.smallLots).toBe(false);
    expect(b.organic).toBe(false);
    expect(assessScam(pumpsScam(), cfg, NOW).score).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
  });

  it("出来高が流動性の何倍かでは両者を分けられない（厚みが必要な理由）", () => {
    const snowChurn = 1_700_000 / 94_000;
    const pumpsChurn = 798_000 / 88_000;
    // 本物のほうが倍率は高い。倍率だけを見ると判定が逆になる
    expect(snowChurn).toBeGreaterThan(pumpsChurn);
  });

  it("取引が 0 件でも落ちず、厚みは成立しない", () => {
    const p = makePair({ ageHours: 50, volH1: 0, buysH1: 0, sellsH1: 0 });
    const b = assessBreadth(p, cfg);
    expect(b.points).toBe(0);
    expect(b.organic).toBe(false);
  });

  it("必要な条件数は設定で変えられる", () => {
    const strict = makeConfig({ SCAM_BREADTH_NEEDED: "4" });
    expect(assessBreadth(snowballLegit(), strict).organic).toBe(false);
  });
});

describe("assessScam — 厚みのある銘柄では出来高比を根拠にしない", () => {
  it("$SNOWBALL を通知する（誤検知の修正）", () => {
    const a = assessScam(snowballLegit(), cfg, NOW);
    expect(a.breadth.organic).toBe(true);
    const ids = a.signals.map((s) => s.id);
    expect(ids).not.toContain("churn");
    expect(ids).not.toContain("turnover");
    expect(ids).not.toContain("instant_volume");
    expect(a.score).toBeLessThan(cfg.scamScoreThreshold);
  });

  it("薄いプールでの急騰は厚みがあっても消さない（注意喚起は残す）", () => {
    const a = assessScam(snowballLegit(), cfg, NOW);
    expect(a.signals.map((s) => s.id)).toContain("thin_pump");
  });

  it("厚みが無ければ $PUMPS は従来どおり止まる", () => {
    const a = assessScam(pumpsScam(), cfg, NOW);
    expect(a.breadth.organic).toBe(false);
    expect(a.score).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
  });

  it("厚みは出来高比の免罪符であって、抜け道にはならない", () => {
    // 件数と均衡を装っても、平均取引額が大口のままなら厚みは揃わない
    const p = snowballLegit();
    p.volume.h1 = 12_000_000; // 平均 $1,016
    const a = assessScam(p, cfg, NOW);
    expect(a.breadth.organic).toBe(false);
    expect(a.score).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
  });
});

describe("assessBreadth — 必須条件", () => {
  it("買い偏重でも、小口が大量なら厚みは認める（初動ランナーを落とさない）", () => {
    const p = snowballLegit();
    p.txns.h1 = { buys: 8_500, sells: 3_311 }; // 買い 72%
    const b = assessBreadth(p, cfg);
    expect(b.buyShare).toBeGreaterThan(1 - cfg.scamBreadthBalance);
    expect(b.points).toBe(2);
    expect(b.organic).toBe(true);
  });

  it("件数が足りなければ、他が揃っても厚みは認めない", () => {
    const p = snowballLegit();
    p.txns.h1 = { buys: 300, sells: 290 };
    p.volume.h1 = 85_000; // 平均 $144 は維持
    expect(assessBreadth(p, cfg).organic).toBe(false);
  });

  it("大口中心なら、他が揃っても厚みは認めない", () => {
    const p = snowballLegit();
    p.volume.h1 = 12_000_000; // 平均 $1,016
    expect(assessBreadth(p, cfg).organic).toBe(false);
  });
});

/**
 * 利用者が報告した実物: $QC (Quantum Cats, 0xF2E122a4…)
 * MC $175.8K でコールされ、その後 $2M まで伸びた。
 *
 * 通知時点の実測値。時価総額の下限を $200K に置いていたら取り逃がしていたので、
 * この数字をそのまま固定して、下限をいじったときに気づけるようにしておく。
 */
function quantumCats() {
  const p = makePair({
    symbol: "QC",
    ageHours: 34 / 60,
    price: 0.0001768,
    volH1: 653_448,
    volH24: 653_448,
    liq: 38_200,
    buysH1: 3201,
    sellsH1: 2691,
    changeH1: 239,
    changeM5: -21.5,
  });
  p.fdv = 175_800;
  p.marketCap = 175_800;
  return p;
}

describe("$QC — 実物の勝ちコールを取り逃がさない", () => {
  it("低MC レーンで検知できる", () => {
    const d = detectNewLaunch(
      { now: NOW, pair: quantumCats(), ageMs: 34 * 60_000, lastAlert: null, lookbackMinPrice: null },
      cfg,
    );
    expect(d).not.toBeNull();
    expect(d!.display.trigger).toBe("new_lowmc");
  });

  it("スキャム判定に一切引っかからない（厚みが 3/3 で揃う）", () => {
    const a = assessScam(quantumCats(), cfg, NOW);
    expect(a.breadth.organic).toBe(true);
    expect(a.breadth.points).toBe(3);
    expect(a.signals).toHaveLength(0);
    expect(a.score).toBe(0);
  });

  it("通知の条件それぞれに余裕がある（どれか 1 つの微調整で落ちない）", () => {
    const p = quantumCats();
    const mc = 175_800;
    expect(mc).toBeGreaterThan(cfg.newLowMcFloorUsd);
    // 3.72 倍。しきい値 3.0 に対して 2 割強の余裕がある
    expect(653_448 / mc).toBeGreaterThan(cfg.newLowMcVolToMcRatio);
    expect(38_200).toBeGreaterThan(cfg.newLowMcMinLiquidityUsd);
    expect(assessBreadth(p, cfg).txns).toBeGreaterThan(cfg.scamBreadthSmallMinTxns);
  });

  it("時価総額の下限を $200K に戻すと取り逃がす（下限を上げるときの警告）", () => {
    const strict = makeConfig({ NEW_LOW_MC_FLOOR_USD: "200000" });
    expect(
      detectNewLaunch({ now: NOW, pair: quantumCats(), ageMs: 34 * 60_000, lastAlert: null, lookbackMinPrice: null }, strict),
    ).toBeNull();
  });
});

describe("低時価総額レーン — 出来高が伴う小型を通す", () => {
  /**
   * 利用者が報告した型: $150K〜$200K でコールされ、$2M まで伸びた銘柄。
   * 規模は小さいが、その規模に見合う出来高が実際に伴っていた。
   */
  function smallButBusy(over: Partial<{ mc: number; volH1: number; buys: number; sells: number }> = {}) {
    const mc = over.mc ?? 220_000;
    // 出来高比は $QC の実測 (3.72 倍) と同じ水準にしてある。
    // しきい値を上げたときにここが追随していないと、テストが現実と乖離する
    const p = makePair({
      symbol: "SPROUT",
      ageHours: 2,
      price: 0.00022,
      volH1: over.volH1 ?? 800_000,
      volH24: 900_000,
      liq: 60_000,
      buysH1: over.buys ?? 2_100,
      sellsH1: over.sells ?? 1_800,
      changeH1: 140,
    });
    p.fdv = mc;
    p.marketCap = mc;
    return p;
  }

  it("時価総額が下限未満でも、出来高と厚みが揃えば新規として拾う", () => {
    const d = detectNewLaunch(
      { now: NOW, pair: smallButBusy(), ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null },
      cfg,
    )!;
    expect(d).not.toBeNull();
    expect(d.display.trigger).toBe("new_lowmc");
    expect(d.display.lowMcVolToMc).toBeCloseTo(800_000 / 220_000, 2);
    expect(d.reason).toContain("時価総額");
  });

  it("出来高が規模に見合わなければ通さない", () => {
    // 時価総額 $220K に対し 1h $180K = 0.82 倍。$QC の 3.72 倍とは別物
    const p = smallButBusy({ volH1: 180_000 });
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("出来高があっても厚みが無ければ通さない（作られた出来高の抜け道にしない）", () => {
    // 同じ出来高比を、少数の大口で作った場合
    const p = smallButBusy({ buys: 40, sells: 12 });
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("下限より小さい銘柄は通さない", () => {
    const p = smallButBusy({ mc: 80_000 });
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("設定で切れる（成績が悪ければ止められる）", () => {
    const off = makeConfig({ NEW_LOW_MC_ENABLED: "false" });
    expect(detectNewLaunch({ now: NOW, pair: smallButBusy(), ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, off)).toBeNull();
  });

  it("時価総額が下限以上の銘柄は従来どおり new 扱い", () => {
    const p = smallButBusy({ mc: 3_000_000 });
    // 出来高比は低MC の条件を満たすが、規模が十分なのでレーンを通る必要がない
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, cfg)!;
    expect(d.display.trigger).toBe("new");
  });

  it("プールが薄すぎる銘柄は通さない（出来高があっても出られない）", () => {
    // 出来高比と厚みは満たすが、$220K の銘柄に $8K のプール。
    // 全体の下限 MIN_LIQUIDITY_USD($5K) はこれを通してしまうので、レーン側で止める
    const p = smallButBusy();
    p.liquidity = { usd: 8_000, base: 0, quote: 0 };
    expect(assessScam(p, cfg, NOW).score).toBeLessThan(cfg.scamScoreThreshold); // スキャム判定は止めてくれない
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("流動性の下限は設定で変えられる", () => {
    const loose = makeConfig({ NEW_LOW_MC_MIN_LIQUIDITY_USD: "5000" });
    const p = smallButBusy();
    p.liquidity = { usd: 8_000, base: 0, quote: 0 };
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * 3_600_000, lastAlert: null, lookbackMinPrice: null }, loose)).not.toBeNull();
  });
});


/**
 * 利用者が報告した実物: $CUPCAKE — ラグ後の枯れたプールに値札だけ付いた「はしご」。
 * 流動性 $864 に時価総額 $59.6M。$3 の買いで階段状に上がり、レポートでは +7370% の最良コールに見えた。
 * 通知時点の値は残っていないので、通知が通るために必要だった最低限（流動性 $5K 以上）から推定する。
 */
describe("$CUPCAKE — 枯れたプールの値札を通さない", () => {
  function cupcake(mc: number, liq: number, volH1: number) {
    const p = makePair({ symbol: "CUPCAKE", ageHours: 80, price: 0.06, volH1, volH24: 358_000, liq, buysH1: 60, sellsH1: 5, changeH1: 120 });
    p.marketCap = mc;
    p.fdv = mc;
    return p;
  }

  it("いまの値（0.0014%）は深さの減点だけでしきい値を超える", () => {
    const a = assessScam(cupcake(59_600_000, 864, 5_000), cfg, NOW);
    const depth = a.signals.find((s) => s.id === "depth")!;
    expect(depth.points).toBe(55);
    expect(depth.points).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
  });

  it("通知時点の推定（流動性 $8K / 時価総額 $1.6M = 0.5%）でも止まる", () => {
    const a = assessScam(cupcake(1_600_000, 8_000, 20_000), cfg, NOW);
    expect(a.signals.find((s) => s.id === "depth")!.points).toBe(40);
    expect(a.score).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
  });

  it("修正前の一律 +25 では 5 点足りずに通っていた（回帰の記録）", () => {
    const a = assessScam(cupcake(1_600_000, 8_000, 20_000), cfg, NOW);
    const withoutGrading = a.score - 40 + 25;
    expect(withoutGrading).toBeLessThan(cfg.scamScoreThreshold);
  });

  it("段階はしきい値で動かせる", () => {
    const loose = makeConfig({ SCAM_DEPTH_SEVERE_PCT: "0.3" });
    expect(assessScam(cupcake(1_600_000, 8_000, 20_000), loose, NOW).signals.find((s) => s.id === "depth")!.points).toBe(25);
  });

  it("本物の初動（$SNOWBALL 9.4% / $QC 21.7%）には深さの減点が付かない", () => {
    expect(assessScam(snowballLegit(), cfg, NOW).signals.some((s) => s.id === "depth")).toBe(false);
    expect(assessScam(quantumCats(), cfg, NOW).signals.some((s) => s.id === "depth")).toBe(false);
  });
});

describe("steady_wash — 出来高が何時間もほぼ一定", () => {
  const busy = () => makePair({ ageHours: 60, volH1: 30_000, volH24: 600_000, liq: 20_000, buysH1: 40, sellsH1: 12 });

  it("流動性に対して十分な出来高が、時間ごとにほぼ同じなら立つ", () => {
    const a = assessScam(busy(), cfg, NOW, { volCv: { hours: 12, mean: 30_000, cv: 0.05 } });
    const sig = a.signals.find((s) => s.id === "steady_wash")!;
    expect(sig).toBeDefined();
    // 毎時 $30K は流動性 $20K を超える＝プールが毎時間入れ替わる。単独でしきい値に届く
    expect(sig.points).toBe(50);
    expect(sig.points).toBeGreaterThanOrEqual(cfg.scamScoreThreshold);
    expect(sig.label).toContain("12 時間ほぼ一定");
  });

  it("流動性の半分〜同額なら +30（他の指標と合わせて判断）", () => {
    const a = assessScam(busy(), cfg, NOW, { volCv: { hours: 12, mean: 14_000, cv: 0.05 } });
    expect(a.signals.find((s) => s.id === "steady_wash")!.points).toBe(30);
  });

  it("出来高が波打っていれば立たない", () => {
    const a = assessScam(busy(), cfg, NOW, { volCv: { hours: 12, mean: 30_000, cv: 0.7 } });
    expect(a.signals.some((s) => s.id === "steady_wash")).toBe(false);
  });

  it("一定でも出来高が流動性に対して小さければ、静かなだけ", () => {
    const quiet = makePair({ ageHours: 60, volH1: 800, volH24: 15_000, liq: 20_000, buysH1: 5, sellsH1: 4 });
    const a = assessScam(quiet, cfg, NOW, { volCv: { hours: 12, mean: 800, cv: 0.05 } });
    expect(a.signals.some((s) => s.id === "steady_wash")).toBe(false);
  });

  it("観測時間が足りなければ判断しない", () => {
    const a = assessScam(busy(), cfg, NOW, { volCv: { hours: 3, mean: 30_000, cv: 0.05 } });
    expect(a.signals.some((s) => s.id === "steady_wash")).toBe(false);
  });

  it("履歴を渡さなければ従来どおり", () => {
    expect(assessScam(busy(), cfg, NOW).signals.some((s) => s.id === "steady_wash")).toBe(false);
  });
});
