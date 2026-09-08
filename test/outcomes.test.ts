import { describe, expect, it } from "vitest";
import { buildDailyReport, computeOutcomes, formatRecentOutcomes, jst } from "../src/outcomes.js";
import { Store } from "../src/store.js";
import { NOW, makeConfig, makePair } from "./helpers.js";

const cfg = makeConfig();
const H = 3_600_000;
const M = 60_000;

/** 通知を 1 件入れて、その後の価格をスナップショットとして書き込む */
function seed(store: Store, opts: { symbol: string; trigger: string; kind?: "new_launch" | "revival"; suppressed?: number; path: [minutesAfter: number, price: number][]; base?: number; buys?: number; sells?: number; score?: number; ts?: number }) {
  const ts = opts.ts ?? NOW - 6 * H;
  const base = opts.base ?? 1;
  const addr = `0xpair_${opts.symbol.toLowerCase()}`;
  const p = makePair({ address: addr, token: `0xtok_${opts.symbol.toLowerCase()}`, symbol: opts.symbol, price: base });
  store.upsertPair(p, "test", ts);
  const id = store.insertAlert({
    kind: opts.kind ?? "revival",
    token_address: p.baseToken.address,
    pair_address: addr,
    ts,
    level: 1,
    price_usd: base,
    symbol: opts.symbol,
    summary: "test",
    scam_score: opts.score ?? 5,
    scam_reasons: "",
    suppressed: opts.suppressed ?? 0,
    mc_usd: 2_000_000,
    trigger: opts.trigger,
    vol_h1: 120_000,
    buys_h1: opts.buys ?? 60,
    sells_h1: opts.sells ?? 40,
    age_hours: 40,
  });
  for (const [min, price] of opts.path) {
    const snap = makePair({ address: addr, token: p.baseToken.address, symbol: opts.symbol, price });
    store.insertSnapshot(snap, ts + min * M);
  }
  return { id, ts, addr };
}

describe("computeOutcomes — 通知のその後を埋める", () => {
  it("15m / 1h / 4h の変化率と、猶予内の最大上昇で的中を判定する", () => {
    const store = new Store(":memory:");
    const { id } = seed(store, {
      symbol: "WIN",
      trigger: "reignite",
      path: [[0, 1.0], [15, 1.1], [60, 1.25], [120, 1.6], [240, 1.4], [300, 1.3]],
    });
    computeOutcomes(store, cfg, NOW);
    const o = store.getOutcome(id)!;
    expect(o.p15m).toBeCloseTo(10, 0);
    expect(o.p1h).toBeCloseTo(25, 0);
    expect(o.p4h).toBeCloseTo(40, 0);
    expect(o.max_gain_pct).toBeCloseTo(60, 0);
    expect(o.hit).toBe(1);
    expect(o.bust).toBe(0);
    store.close();
  });

  it("猶予内に届かなければ外れ、半値以下なら失敗と記録する", () => {
    const store = new Store(":memory:");
    const { id } = seed(store, { symbol: "RUG", trigger: "new", kind: "new_launch", path: [[0, 1], [30, 0.8], [90, 0.4], [240, 0.3]] });
    computeOutcomes(store, cfg, NOW);
    const o = store.getOutcome(id)!;
    expect(o.hit).toBe(0);
    expect(o.bust).toBe(1);
    expect(o.max_dd_pct).toBeLessThan(-60);
    store.close();
  });

  it("猶予が終わる前は未確定のまま、地平が伸びるたびに更新される", () => {
    const store = new Store(":memory:");
    const ts = NOW - 2 * H;
    const { id } = seed(store, { symbol: "MID", trigger: "breakout", ts, path: [[0, 1], [15, 1.05], [60, 1.1], [110, 1.15]] });
    computeOutcomes(store, cfg, NOW);
    const o = store.getOutcome(id)!;
    expect(o.p1h).toBeCloseTo(10, 0);
    expect(o.p4h).toBeNull();
    expect(o.hit).toBeNull();
    expect(o.done_until).toBe(1 * H);
    store.close();
  });

  it("枯れたプールの張り付き価格を利益に数えない（+39741% の正体）", () => {
    const store = new Store(":memory:");
    const addr = "0xpair_dead";
    const p = makePair({ address: addr, token: "0xtok_dead", symbol: "DEAD", price: 1, liq: 50_000 });
    const ts = NOW - 6 * H;
    store.upsertPair(p, "test", ts);
    const id = store.insertAlert({
      kind: "new_launch", token_address: p.baseToken.address, pair_address: addr, ts, level: 1, price_usd: 1, symbol: "DEAD",
      summary: "t", scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 1_000_000, trigger: "new", vol_h1: 0, buys_h1: 0, sells_h1: 0, age_hours: 1,
    });
    // 正常な区間: 流動性 $50K で +20% まで
    store.insertSnapshot(makePair({ address: addr, token: p.baseToken.address, price: 1.0, liq: 50_000 }), ts);
    store.insertSnapshot(makePair({ address: addr, token: p.baseToken.address, price: 1.2, liq: 50_000 }), ts + 30 * M);
    // 流動性が抜かれ、最後の約定価格 $400 が張り付いたまま 4 時間
    for (let m = 68; m <= 300; m += 30) {
      store.insertSnapshot(makePair({ address: addr, token: p.baseToken.address, price: 400, liq: 300 }), ts + m * M);
    }
    computeOutcomes(store, cfg, NOW);
    const o = store.getOutcome(id)!;
    expect(o.max_gain_pct).toBeCloseTo(20, 0); // 39900% ではない
    expect(o.hit).toBe(0);
    expect(o.p4h).toBeNull(); // 売れない価格しか無い時点は「不明」
    store.close();
  });

  it("流動性が抜かれた損失はそのまま数える（ラグを無かったことにしない）", () => {
    const store = new Store(":memory:");
    const addr = "0xpair_rug";
    const p = makePair({ address: addr, token: "0xtok_rug", symbol: "RUG", price: 1, liq: 50_000 });
    const ts = NOW - 6 * H;
    store.upsertPair(p, "test", ts);
    const id = store.insertAlert({
      kind: "new_launch", token_address: p.baseToken.address, pair_address: addr, ts, level: 1, price_usd: 1, symbol: "RUG",
      summary: "t", scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 1_000_000, trigger: "new", vol_h1: 0, buys_h1: 0, sells_h1: 0, age_hours: 1,
    });
    store.insertSnapshot(makePair({ address: addr, token: p.baseToken.address, price: 1.0, liq: 50_000 }), ts);
    store.insertSnapshot(makePair({ address: addr, token: p.baseToken.address, price: 0.001, liq: 100 }), ts + 30 * M);
    computeOutcomes(store, cfg, NOW);
    expect(store.getOutcome(id)!.max_dd_pct).toBeLessThan(-99);
    store.close();
  });

  it("止めた通知も追跡する（フィルタが厳しすぎないかを知るため）", () => {
    const store = new Store(":memory:");
    const { id } = seed(store, { symbol: "GEM", trigger: "dormant", suppressed: 1, score: 55, path: [[0, 1], [60, 1.5], [240, 1.8]] });
    computeOutcomes(store, cfg, NOW);
    expect(store.getOutcome(id)!.hit).toBe(1);
    store.close();
  });
});

describe("buildDailyReport — 反省の材料", () => {
  function fullDay(): Store {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    // 再点火 3 件（2 勝）
    seed(store, { symbol: "R1", trigger: "reignite", ts: base, path: [[0, 1], [60, 1.4], [240, 1.5]] });
    seed(store, { symbol: "R2", trigger: "reignite", ts: base + 20 * M, path: [[0, 1], [60, 1.2], [120, 1.35], [240, 1.3]] });
    seed(store, { symbol: "R3", trigger: "reignite", ts: base + 40 * M, path: [[0, 1], [60, 1.05], [240, 0.95]] });
    // 新規 4 件（1 勝、買い偏重が 3 件で全敗）
    seed(store, { symbol: "N1", trigger: "new", kind: "new_launch", ts: base + H, buys: 90, sells: 10, path: [[0, 1], [60, 0.9], [240, 0.6]] });
    seed(store, { symbol: "N2", trigger: "new", kind: "new_launch", ts: base + H + 10 * M, buys: 85, sells: 15, path: [[0, 1], [60, 0.7], [240, 0.4]] });
    seed(store, { symbol: "N3", trigger: "new", kind: "new_launch", ts: base + H + 20 * M, buys: 80, sells: 20, path: [[0, 1], [60, 1.1], [240, 0.9]] });
    seed(store, { symbol: "N4", trigger: "new", kind: "new_launch", ts: base + H + 30 * M, buys: 50, sells: 50, path: [[0, 1], [60, 1.5], [240, 1.7]] });
    // 止めたが伸びた 1 件、止めて正解 1 件
    seed(store, { symbol: "GEM", trigger: "dormant", suppressed: 1, score: 55, ts: base + 2 * H, path: [[0, 1], [60, 1.6], [240, 2.0]] });
    seed(store, { symbol: "TRASH", trigger: "dormant", suppressed: 1, score: 80, ts: base + 2 * H + 10 * M, path: [[0, 1], [60, 0.5], [240, 0.1]] });
    computeOutcomes(store, cfg, NOW);
    return store;
  }

  it("種別別の成績、良かった／悪かったコール、止めた中の逸材を出す", () => {
    const store = fullDay();
    const { text, stats } = buildDailyReport(store, cfg, NOW);
    expect(stats.judged).toBe(7);
    expect(stats.hits).toBe(3);
    expect(text).toContain("日次レポート");
    expect(text).toContain("♻️ 再点火");
    expect(text).toContain("🚀 新規");
    expect(text).toContain("良かったコール");
    expect(text).toContain("$R1");
    expect(text).toContain("悪かったコール");
    expect(text).toContain("$N2");
    expect(text).toContain("止めたが伸びた銘柄");
    expect(text).toContain("$GEM");
    // 60 で GEM(55) が通り、TRASH(80) は通らない。70/80 は同じ集合なので並べない
    expect(text).toContain("60 → +1件 通る、うち的中 1件（100%）");
    expect(text).not.toContain("70 →");
    expect(text).toContain("SCAM_SCORE_THRESHOLD=60 まで上げる余地あり");
    store.close();
  });

  it("止めた中の勝ちより負けが多ければ、しきい値は据え置きと判断する", () => {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    seed(store, { symbol: "S1", trigger: "reignite", ts: base, path: [[0, 1], [60, 1.5], [240, 1.6]] });
    seed(store, { symbol: "S2", trigger: "reignite", ts: base + M, path: [[0, 1], [60, 1.4], [240, 1.5]] });
    // 止めた 4 件: 勝ち 1、負け 3。全部リスク 55 なので 60 に上げると全部通る
    seed(store, { symbol: "W", trigger: "dormant", suppressed: 1, score: 55, ts: base + 2 * M, path: [[0, 1], [60, 1.6], [240, 2]] });
    seed(store, { symbol: "L1", trigger: "dormant", suppressed: 1, score: 55, ts: base + 3 * M, path: [[0, 1], [60, 0.7], [240, 0.5]] });
    seed(store, { symbol: "L2", trigger: "dormant", suppressed: 1, score: 55, ts: base + 4 * M, path: [[0, 1], [60, 0.8], [240, 0.6]] });
    seed(store, { symbol: "L3", trigger: "dormant", suppressed: 1, score: 55, ts: base + 5 * M, path: [[0, 1], [60, 0.9], [240, 0.7]] });
    computeOutcomes(store, cfg, NOW);
    const { text } = buildDailyReport(store, cfg, NOW);
    expect(text).toContain("止めたが伸びた銘柄");
    expect(text).toContain("60 → +4件 通る、うち的中 1件（25%） ← 全体の的中率が下がる");
    expect(text).toContain("据え置きが妥当");
    expect(text).not.toContain("上げる余地あり");
    store.close();
  });

  it("同じトークンの段階通知を、良かった／止めた一覧で 1 件にまとめる", () => {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    // 同じトークン $DUP に 3 段階の通知（同じ token_address）
    for (let i = 0; i < 3; i++) {
      seed(store, { symbol: "DUP", trigger: "new", kind: "new_launch", ts: base + i * M, path: [[0, 1], [60, 3], [240, 3.5]] });
    }
    seed(store, { symbol: "ONE", trigger: "new", kind: "new_launch", ts: base + 10 * M, path: [[0, 1], [60, 1.5], [240, 1.6]] });
    computeOutcomes(store, cfg, NOW);
    const { text } = buildDailyReport(store, cfg, NOW);
    const good = text.split("良かったコール")[1]!.split("\n\n")[0]!;
    expect((good.match(/\$DUP/g) ?? []).length).toBe(1);
    expect(good).toContain("$ONE");
    store.close();
  });

  it("種別の成績は平均ではなく中央値（1 件の異常値に引きずられない）", () => {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    seed(store, { symbol: "X1", trigger: "reignite", ts: base, path: [[0, 1], [60, 400], [240, 400]] }); // +39900%
    seed(store, { symbol: "X2", trigger: "reignite", ts: base + M, path: [[0, 1], [60, 1.1], [240, 1.05]] });
    seed(store, { symbol: "X3", trigger: "reignite", ts: base + 2 * M, path: [[0, 1], [60, 1.2], [240, 1.1]] });
    computeOutcomes(store, cfg, NOW);
    const { text } = buildDailyReport(store, cfg, NOW);
    const line = text.split("\n").find((l) => l.includes("♻️ 再点火") && l.includes("件"))!;
    expect(line).toContain("中央値: 最大 +20");
    expect(line).not.toContain("+13");
    store.close();
  });

  it("傾向の分析は通知したものだけで行う（止めたものを混ぜると、フィルタの結果を原因と取り違える）", () => {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    // 通知: 1h 未満の新規 4 件、全勝
    for (let i = 0; i < 4; i++) {
      const { id } = seed(store, { symbol: `Y${i}`, trigger: "new", kind: "new_launch", ts: base + i * M, path: [[0, 1], [60, 1.5], [240, 1.6]] });
      void id;
    }
    // 止めた: 1h 未満 6 件、全敗（instant_volume で止めた側はローンチ直後に偏る）
    for (let i = 0; i < 6; i++) {
      seed(store, { symbol: `Z${i}`, trigger: "new", kind: "new_launch", suppressed: 1, score: 70, ts: base + (10 + i) * M, path: [[0, 1], [60, 0.5], [240, 0.3]] });
    }
    // age_hours は seed で 40h 固定なので、通知側だけ 0.5h に書き換える
    const db = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("UPDATE alerts SET age_hours = 0.5").run();
    computeOutcomes(store, cfg, NOW);
    const { text } = buildDailyReport(store, makeConfig({ REPORT_MIN_SAMPLES: "3" }), NOW);
    // 混ぜていたら「1h未満 40%」で絞る候補が出る。通知だけなら 100% なので出ない
    expect(text).not.toContain("1h未満」の的中 40%");
    expect(text).not.toContain("絞る方向で見直す候補: NEW_MAX_AGE_HOURS");
    store.close();
  });

  it("♻️ 再点火が一度も鳴っていなければ、それを明記する", () => {
    const store = new Store(":memory:");
    seed(store, { symbol: "A", trigger: "new", kind: "new_launch", ts: NOW - 10 * H, path: [[0, 1], [60, 1.5], [240, 1.6]] });
    computeOutcomes(store, cfg, NOW);
    const { text } = buildDailyReport(store, cfg, NOW);
    expect(text).toContain("♻️ 再点火");
    expect(text).toContain("0件");
    expect(text).toContain("/ranges");
    store.close();
  });

  it("属性ごとの差から改善案を導く（買い偏重の新規が全敗 → NEW_MIN_BUYS_H1 が候補に）", () => {
    const store = fullDay();
    const { text } = buildDailyReport(store, makeConfig({ REPORT_MIN_SAMPLES: "3" }), NOW);
    expect(text).toContain("傾向と改善案");
    expect(text).toContain("買い偏重");
    expect(text).toContain("NEW_MIN_BUYS_H1");
    store.close();
  });

  it("判定前の通知は集計に混ぜない", () => {
    const store = new Store(":memory:");
    seed(store, { symbol: "FRESH", trigger: "reignite", ts: NOW - 30 * M, path: [[0, 1], [15, 1.5]] });
    computeOutcomes(store, cfg, NOW);
    const { stats, text } = buildDailyReport(store, cfg, NOW);
    expect(stats.judged).toBe(0);
    expect(text).toContain("判定できる通知がまだありません");
    store.close();
  });

  it("前日のレポートがあれば的中率の推移を示す", () => {
    const store = fullDay();
    store.saveDailyReport({ date: jst(NOW - 24 * H).date, ts: NOW - 24 * H, alerts: 5, hits: 1, hit_rate: 0.2, text: "" });
    const { text } = buildDailyReport(store, cfg, NOW);
    expect(text).toContain("前日比: 20% → 43%");
    store.close();
  });
});

describe("formatRecentOutcomes / jst", () => {
  it("直近の通知を結果マーク付きで並べる", () => {
    const store = new Store(":memory:");
    seed(store, { symbol: "A", trigger: "reignite", path: [[0, 1], [60, 1.5], [240, 1.6]] });
    computeOutcomes(store, cfg, NOW);
    const txt = formatRecentOutcomes(store, NOW, 10);
    expect(txt).toContain("✅");
    expect(txt).toContain("$A");
    store.close();
  });

  it("JST の日付と時刻を出す", () => {
    // NOW = 2026-09-04T12:00Z → JST 21:00 同日
    const j = jst(NOW);
    expect(j.date).toBe("2026-09-04");
    expect(j.hour).toBe(21);
    // 15:30Z → JST 翌日 0:30
    const next = jst(Date.parse("2026-09-04T15:30:00Z"));
    expect(next.date).toBe("2026-09-05");
    expect(next.hour).toBe(0);
  });
});

describe("低MC レーンの成績を切り分ける", () => {
  it("新規を一括りにせず、低MC だけの的中率を出す（試験運用の可否を判断するため）", () => {
    const store = new Store(":memory:");
    const base = NOW - 10 * H;
    // 通常の新規 3 件（1 勝）
    seed(store, { symbol: "N1", trigger: "new", kind: "new_launch", ts: base, path: [[0, 1], [60, 1.4], [240, 1.5]] });
    seed(store, { symbol: "N2", trigger: "new", kind: "new_launch", ts: base + 10 * M, path: [[0, 1], [60, 0.9], [240, 0.7]] });
    seed(store, { symbol: "N3", trigger: "new", kind: "new_launch", ts: base + 20 * M, path: [[0, 1], [60, 1.1], [240, 0.95]] });
    // 低MC 3 件（3 勝）
    seed(store, { symbol: "L1", trigger: "new_lowmc", kind: "new_launch", ts: base + 30 * M, path: [[0, 1], [60, 1.8], [240, 2.4]] });
    seed(store, { symbol: "L2", trigger: "new_lowmc", kind: "new_launch", ts: base + 40 * M, path: [[0, 1], [60, 1.5], [240, 1.9]] });
    seed(store, { symbol: "L3", trigger: "new_lowmc", kind: "new_launch", ts: base + 50 * M, path: [[0, 1], [60, 1.4], [240, 1.6]] });
    computeOutcomes(store, cfg, NOW);

    const { text } = buildDailyReport(store, cfg, NOW);
    expect(text).toContain("🚀 新規");
    expect(text).toContain("🌱 新規(低MC)");
    // 別々の行として集計されている
    const lowLine = text.split("\n").find((l) => l.includes("🌱 新規(低MC)"))!;
    expect(lowLine).toContain("3件");
    expect(lowLine).toContain("100%");
    const newLine = text.split("\n").find((l) => l.includes("🚀 新規") && l.includes("件"))!;
    expect(newLine).toContain("33%");
    store.close();
  });
});
