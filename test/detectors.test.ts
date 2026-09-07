import { describe, expect, it } from "vitest";
import { detectNewLaunch } from "../src/detectors/newLaunch.js";
import { detectRevival } from "../src/detectors/revival.js";
import type { AlertRow } from "../src/store.js";
import { H, NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();

function alert(partial: Partial<AlertRow>): AlertRow {
  return {
    id: 1,
    kind: "revival",
    token_address: "0xtoken",
    pair_address: "0xpair",
    ts: NOW - 10 * 60_000,
    level: 1,
    price_usd: 0.001,
    symbol: "TCAT",
    summary: "",
    ...partial,
  };
}

describe("detectNewLaunch", () => {
  it("1h 出来高が最初の段階を超えたら level 1 で通知", () => {
    const p = makePair({ ageHours: 1, volH1: 30_000 });
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, cfg);
    expect(d?.kind).toBe("new_launch");
    expect(d?.level).toBe(1);
    expect(d?.levelCount).toBe(3);
  });

  it("しきい値未満なら通知しない", () => {
    const p = makePair({ ageHours: 1, volH1: 5_000 });
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("同じ段階は 1 回だけ、上の段階に達したら再通知", () => {
    const p1 = makePair({ ageHours: 2, volH1: 40_000 });
    const last = alert({ kind: "new_launch", level: 1 });
    expect(detectNewLaunch({ now: NOW, pair: p1, ageMs: 2 * H, lastAlert: last, lookbackMinPrice: null }, cfg)).toBeNull();
    const p2 = makePair({ ageHours: 2, volH1: 120_000 });
    const d = detectNewLaunch({ now: NOW, pair: p2, ageMs: 2 * H, lastAlert: last, lookbackMinPrice: null }, cfg);
    expect(d?.level).toBe(2);
  });

  it("一気に最上位段階を超えたら最上位 level で通知", () => {
    const p = makePair({ ageHours: 1, volH1: 900_000 });
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, cfg);
    expect(d?.level).toBe(3);
  });

  it("古いペア / 流動性不足 / 買い件数不足は対象外", () => {
    const old = makePair({ ageHours: 30, volH1: 100_000 });
    expect(detectNewLaunch({ now: NOW, pair: old, ageMs: 30 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    const lowLiq = makePair({ ageHours: 1, volH1: 100_000, liq: 1_000 });
    expect(detectNewLaunch({ now: NOW, pair: lowLiq, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    const fewBuys = makePair({ ageHours: 1, volH1: 100_000, buysH1: 3 });
    expect(detectNewLaunch({ now: NOW, pair: fewBuys, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    const noAge = makePair({ ageHours: 1, volH1: 100_000 });
    expect(detectNewLaunch({ now: NOW, pair: noAge, ageMs: null, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("QUOTE_SYMBOLS 指定時は quote が一致するペアのみ", () => {
    const c = makeConfig({ QUOTE_SYMBOLS: "USDC" });
    const p = makePair({ ageHours: 1, volH1: 100_000, quote: "WETH" });
    expect(detectNewLaunch({ now: NOW, pair: p, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, c)).toBeNull();
    const p2 = makePair({ ageHours: 1, volH1: 100_000, quote: "USDC" });
    expect(detectNewLaunch({ now: NOW, pair: p2, ageMs: 1 * H, lastAlert: null, lookbackMinPrice: null }, c)).not.toBeNull();
  });
});

describe("detectRevival", () => {
  // 直前 23h の平均 1h 出来高 = (h24 - h1)/23。h24=23_000, h1=20_000 → 平均 130 → ratio 153x
  const base = { ageHours: 40, volH1: 20_000, volH24: 23_000, changeH1: 45, price: 0.002 };

  it("低迷後の突発出来高 + 1h +45% を検知", () => {
    const p = makePair(base);
    const d = detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg);
    expect(d?.kind).toBe("revival");
    expect(d?.level).toBe(1);
    expect(d?.metrics.volSpikeRatio).toBeGreaterThan(100);
  });

  it("直前 23h 出来高ゼロでも検知（ratio 無限大）", () => {
    const p = makePair({ ...base, volH24: 20_000 });
    const d = detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg);
    expect(d).not.toBeNull();
    expect(d?.metrics.volSpikeRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it("出来高が継続的に高い（突発でない）場合は通知しない", () => {
    // 平均 1h = (460_000-20_000)/23 ≈ 19_130 → ratio ≈ 1.05
    const p = makePair({ ...base, volH24: 460_000 });
    expect(detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("価格上昇が不足なら通知しない。lookback 安値比で条件を満たせば通知", () => {
    const p = makePair({ ...base, changeH1: 10 });
    expect(detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    // 2h 前の安値 0.0012 → 現在 0.002 は +66%
    const d = detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: null, lookbackMinPrice: 0.0012 }, cfg);
    expect(d).not.toBeNull();
    expect(d?.metrics.lookbackChangePct).toBeCloseTo(66.7, 0);
    // 1h 変化率(+10%)では足りず、安値比(+67%)で成立していることを確認する
    expect(d?.display.trigger).toBe("dormant");
  });

  it("新しすぎるペアは対象外（新規ローンチ側で扱う）", () => {
    const p = makePair({ ...base, ageHours: 5 });
    expect(detectRevival({ now: NOW, pair: p, ageMs: 5 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });

  it("クールダウン中は再通知しない。エスカレーション条件を満たせば level+1", () => {
    const p = makePair(base);
    const recent = alert({ ts: NOW - 30 * 60_000, level: 1, price_usd: 0.0019 });
    expect(detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: recent, lookbackMinPrice: null }, cfg)).toBeNull();
    // 前回 0.001 → 現在 0.002 は +100% ≥ 50% → 再通知
    const escalated = alert({ ts: NOW - 30 * 60_000, level: 1, price_usd: 0.001 });
    const d = detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: escalated, lookbackMinPrice: null }, cfg);
    expect(d?.level).toBe(2);
  });

  it("クールダウン経過後は level 1 で再通知", () => {
    const p = makePair(base);
    const old = alert({ ts: NOW - 5 * H, level: 3, price_usd: 0.05 });
    const d = detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: old, lookbackMinPrice: null }, cfg);
    expect(d?.level).toBe(1);
  });

  it("エスカレーション無効 (0) ならクールダウン中は常に抑制", () => {
    const c = makeConfig({ REVIVAL_ESCALATION_PCT: "0" });
    const p = makePair(base);
    const escalated = alert({ ts: NOW - 30 * 60_000, level: 1, price_usd: 0.0001 });
    expect(detectRevival({ now: NOW, pair: p, ageMs: 40 * H, lastAlert: escalated, lookbackMinPrice: null }, c)).toBeNull();
  });

  it("出来高・買い件数・流動性の下限", () => {
    expect(detectRevival({ now: NOW, pair: makePair({ ...base, volH1: 5_000, volH24: 6_000 }), ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    expect(detectRevival({ now: NOW, pair: makePair({ ...base, buysH1: 2 }), ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
    expect(detectRevival({ now: NOW, pair: makePair({ ...base, liq: 100 }), ageMs: 40 * H, lastAlert: null, lookbackMinPrice: null }, cfg)).toBeNull();
  });
});

describe("detectRevival — レンジ上抜け（報告された $UNIPCS の型）", () => {
  /** 24h $8.78M を捌いていた活発な銘柄。出来高では静穏と判定できない */
  function unipcs(price: number) {
    const p = makePair({
      symbol: "UNIPCS",
      ageHours: 16.78,
      price,
      volH1: 102_000,
      volH24: 8_780_000,
      liq: 204_700,
      changeH1: 40,
      changeM5: -5.4,
      buysH1: 150,
      sellsH1: 126,
    });
    p.marketCap = 4_900_000;
    p.fdv = 4_900_000;
    return p;
  }
  const ctx = (price: number, rangeHigh: number | null) => ({
    now: NOW,
    pair: unipcs(price),
    ageMs: 16.78 * H,
    lastAlert: null,
    lookbackMinPrice: 0.0027,
    baseLowPrice: 0.0027,
    rangeHighPrice: rangeHigh,
    quietMs: null,
  });

  it("出来高が平常以下でも、レンジを上抜ければ検知する", () => {
    const d = detectRevival(ctx(0.0041, 0.0035), cfg);
    expect(d).not.toBeNull();
    expect(d?.display.trigger).toBe("breakout");
    expect(d?.reason).toContain("レンジ上限");
  });

  it("出来高だけでは検知できないことを確認する（この型を取りこぼしていた原因）", () => {
    const p = unipcs(0.0041);
    // 突発率は 1 倍を大きく下回る＝出来高からは「静穏からの復活」に見えない
    const d = detectRevival(ctx(0.0041, null), cfg);
    expect(d).toBeNull();
    void p;
  });

  it("レンジ内に留まっているうちは検知しない", () => {
    expect(detectRevival(ctx(0.0036, 0.0035), cfg)).toBeNull();
  });

  it("通知が来た価格より手前で検知できている", () => {
    // 実際の通知は $0.004906。それより安い時点で既に成立する
    expect(detectRevival(ctx(0.0040, 0.0035), cfg)).not.toBeNull();
  });

  it("レンジの観測が無ければこの経路は使わない", () => {
    expect(detectRevival(ctx(0.0041, null), cfg)).toBeNull();
  });
});

describe("detectRevival — 平常値の見積もり", () => {
  it("若い銘柄の平常値を、存在しなかった時間で薄めない", () => {
    // 7h 前に作られ、6h 分で $60K を捌いた銘柄の直近 1h が $20K
    // 常に 23 で割ると平常値 $1.7K → 12倍 と誤判定する。実在時間(6h)で割れば $6.7K → 3倍
    const p = makePair({ ageHours: 7, volH1: 20_000, volH24: 60_000, liq: 50_000, changeH1: 40, buysH1: 50 });
    p.marketCap = 800_000;
    const d = detectRevival(
      { now: NOW, pair: p, ageMs: 7 * H, lastAlert: null, lookbackMinPrice: null, baseLowPrice: null, rangeHighPrice: null, quietMs: null },
      cfg,
    );
    expect(d?.metrics.volSpikeRatio).toBeCloseTo(20_000 / ((60_000 - 20_000) / 6), 1);
  });
});

describe("detectNewLaunch — 時価総額の下限", () => {
  function launch(mc: number | undefined, fdv?: number) {
    const p = makePair({ ageHours: 2, volH1: 60_000, volH24: 150_000, liq: 45_000, buysH1: 90, sellsH1: 40 });
    p.marketCap = mc as number;
    p.fdv = fdv as number;
    return p;
  }
  const run = (p: ReturnType<typeof launch>, c = cfg) =>
    detectNewLaunch({ now: NOW, pair: p, ageMs: 2 * H, lastAlert: null, lookbackMinPrice: null }, c);

  it("$1M 以上なら通知する", () => {
    expect(run(launch(1_200_000, 1_200_000))).not.toBeNull();
  });

  it("$1M 未満は通知しない（出来高の条件を満たしていても）", () => {
    expect(run(launch(400_000, 400_000))).toBeNull();
  });

  it("ちょうど $1M は通知する", () => {
    expect(run(launch(1_000_000, 1_000_000))).not.toBeNull();
  });

  it("marketCap が無ければ fdv で判定する", () => {
    expect(run(launch(undefined, 1_500_000))).not.toBeNull();
    expect(run(launch(undefined, 300_000))).toBeNull();
  });

  it("どちらも取れない銘柄は規模を判断できないので通さない", () => {
    expect(run(launch(undefined, undefined))).toBeNull();
  });

  it("下限は設定で変えられる", () => {
    expect(run(launch(400_000, 400_000), makeConfig({ NEW_MIN_MC_USD: "100000" }))).not.toBeNull();
    expect(run(launch(3_000_000, 3_000_000), makeConfig({ NEW_MIN_MC_USD: "5000000" }))).toBeNull();
  });

  it("再点火（時価総額ベース）はこの下限の影響を受けない", () => {
    // 新規ローンチの下限は新規側だけの条件で、復活系の判定には関わらない。
    // 既定値そのものを書くと調整のたびに壊れるので、独立していることを確かめる
    const base = makeConfig();
    const raised = makeConfig({ NEW_MIN_MC_USD: "50000000" });
    expect(raised.newMinMcUsd).toBe(50_000_000);
    expect(raised.reigniteMinPeakMcUsd).toBe(base.reigniteMinPeakMcUsd);
    expect(raised.priorityPeakMcUsd).toBe(base.priorityPeakMcUsd);
  });
});
