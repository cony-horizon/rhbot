import { describe, expect, it } from "vitest";
import type { DexPair, DexScreenerClient } from "../src/dexscreener.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { H, NOW, makeConfig, makePair } from "./helpers.js";

/** DexScreener をメモリ上の「現在値」で置き換えるフェイク */
class FakeDex {
  pairs = new Map<string, DexPair>();
  searchResults: DexPair[] = [];
  requestCount = 0;
  set(p: DexPair) {
    this.pairs.set(p.pairAddress.toLowerCase(), p);
  }
  async search() {
    this.requestCount++;
    for (const p of this.searchResults) this.set(p);
    return this.searchResults;
  }
  async getPairs(_chain: string, addrs: string[]) {
    this.requestCount++;
    return addrs.map((a) => this.pairs.get(a.toLowerCase())).filter((p): p is DexPair => p !== undefined);
  }
  async getTokenPools(_chain: string, token: string) {
    this.requestCount++;
    return [...this.pairs.values()].filter((p) => p.baseToken.address.toLowerCase() === token.toLowerCase());
  }
  async getTokens(_chain: string, tokens: string[]) {
    this.requestCount++;
    const set = new Set(tokens.map((t) => t.toLowerCase()));
    return [...this.pairs.values()].filter((p) => set.has(p.baseToken.address.toLowerCase()));
  }
  async latestTokenProfiles() {
    return [];
  }
  async latestBoosts() {
    return [];
  }
  async topBoosts() {
    return [];
  }
}

function setup(envOverrides: Record<string, string> = {}) {
  const cfg = makeConfig({ DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_TOKEN_ADDRESSES: "", DISCOVERY_USE_PROFILES: "false", ...envOverrides });
  const store = new Store(":memory:");
  const dex = new FakeDex();
  const sent: string[] = [];
  let now = NOW;
  const engine = new Engine(cfg, store, dex as unknown as DexScreenerClient, { broadcast: async (h) => void sent.push(h) }, null, () => now);
  return { cfg, store, dex, sent, engine, setNow: (t: number) => (now = t) };
}

describe("Engine", () => {
  it("discovery で新規ペアを取り込み、新規ローンチ条件を満たせば即通知", async () => {
    const { dex, sent, engine, store } = setup();
    const p = makePair({ ageHours: 1, volH1: 60_000 });
    dex.searchResults = [p, makePair({ address: "0xother", token: "0xt2", chainId: "base", volH1: 999_999 })];
    const added = await engine.discover();
    expect(added).toBe(1); // 他チェーンは除外
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("新規ローンチ検知");
    expect(sent[0]).toContain("$TCAT");
    expect(store.countByTier().hot).toBe(1);
  });

  it("復活シナリオ: 低迷 → 突発出来高 + 価格上昇 で 1 回だけ通知、クールダウン中は抑制", async () => {
    const { dex, sent, engine, store, setNow } = setup();
    // 40h 前に作られ、いまは低迷中のペア
    const dormant = makePair({ ageHours: 40, volH1: 50, volH24: 1_500, price: 0.001, liq: 15_000, changeH1: -2 });
    dex.searchResults = [dormant];
    await engine.discover();
    expect(sent).toHaveLength(0);
    expect(store.countByTier().dormant).toBe(1);

    // 5 分ごとにスナップショット（低迷継続）
    for (let i = 1; i <= 6; i++) {
      setNow(NOW + i * 5 * 60_000);
      await engine.refreshTier("dormant", 1);
    }
    expect(sent).toHaveLength(0);

    // 突発: 1h 出来高 $25K, 価格 +40%
    const t1 = NOW + 60 * 60_000;
    setNow(t1);
    const spiked = dex.pairs.get(dormant.pairAddress.toLowerCase())!;
    spiked.volume = { m5: 3_000, h1: 25_000, h6: 25_000, h24: 26_500 };
    spiked.priceUsd = "0.0014";
    spiked.liquidity = { usd: 30_000 };
    spiked.priceChange.h1 = 40;
    await engine.refreshTier("dormant", 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("復活スパイク検知");
    expect(sent[0]).toContain("+40");

    // 10 分後、まだ同じ状態 → クールダウン中なので再通知なし
    setNow(t1 + 10 * 60_000);
    await engine.refreshTier("hot", 1);
    expect(sent).toHaveLength(1);

    // さらに +60% (0.0014 → 0.00224) → エスカレーション通知
    setNow(t1 + 20 * 60_000);
    spiked.priceUsd = "0.00224";
    spiked.priceChange.h1 = 120;
    await engine.refreshTier("hot", 1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("追加上昇 #2");
  });

  it("lookback 最安値比でも復活を検知できる（1h 変化率が小さい場合）", async () => {
    const { dex, sent, engine, setNow } = setup();
    const p = makePair({ ageHours: 40, volH1: 50, volH24: 1_000, price: 0.001, liq: 15_000 });
    dex.searchResults = [p];
    await engine.discover();
    // 90 分かけてじわじわ +50%、DexScreener の 1h 変化率は +12% しか出ていない想定
    setNow(NOW + 90 * 60_000);
    const cur = dex.pairs.get(p.pairAddress.toLowerCase())!;
    cur.priceUsd = "0.0015";
    cur.priceChange.h1 = 12;
    cur.volume.h1 = 15_000;
    cur.volume.h24 = 16_000;
    await engine.refreshTier("dormant", 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("安値比");
  });

  it("mute 中は通知せず履歴だけ残す", async () => {
    const { dex, sent, engine, store } = setup();
    engine.mute(30);
    dex.searchResults = [makePair({ ageHours: 1, volH1: 60_000 })];
    await engine.discover();
    expect(sent).toHaveLength(0);
    expect(store.recentAlerts(10)).toHaveLength(1);
  });

  it("同一トークンの複数ペアでも通知は 1 回", async () => {
    const { dex, sent, engine } = setup();
    dex.searchResults = [
      makePair({ address: "0xpairA", token: "0xtok", ageHours: 1, volH1: 60_000 }),
      makePair({ address: "0xpairB", token: "0xtok", ageHours: 1, volH1: 60_000, quote: "USDC" }),
    ];
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("流動性が消えたペアは dead になり、一定期間後に削除される", async () => {
    const { dex, engine, store, setNow } = setup();
    const p = makePair({ ageHours: 40, volH1: 0, volH24: 0, liq: 10_000 });
    dex.searchResults = [p];
    await engine.discover();
    const cur = dex.pairs.get(p.pairAddress.toLowerCase())!;
    cur.liquidity = { usd: 10 };
    setNow(NOW + H);
    await engine.refreshTier("dormant", 1);
    expect(store.countByTier().dead).toBe(1);
    setNow(NOW + 10 * 24 * H);
    engine.maintain();
    expect(store.countPairs()).toBe(0);
  });

  it("watch / unwatch", async () => {
    const { dex, engine, store } = setup();
    dex.set(makePair({ address: "0xpairW", token: "0xtokW", ageHours: 3 }));
    const pairs = await engine.watch("0xtokW");
    expect(pairs).toHaveLength(1);
    expect(store.listManual()).toHaveLength(1);
    expect(engine.unwatch("0xtokW")).toBe(1);
    expect(store.countPairs()).toBe(0);
  });

  it("DexScreener に無くなったペアは miss を数えて最終的に削除", async () => {
    const { dex, engine, store, setNow } = setup();
    const p = makePair({ ageHours: 1, volH1: 10 });
    dex.searchResults = [p];
    await engine.discover();
    dex.pairs.delete(p.pairAddress.toLowerCase());
    for (let i = 1; i <= 20; i++) {
      setNow(NOW + i * 60_000);
      await engine.refreshTier("hot", 1);
    }
    engine.maintain();
    expect(store.countPairs()).toBe(0);
  });
});

describe("Engine — discovery が検知を飢えさせない", () => {
  it("discovery に現れ続けるペアでもスパイクを検知する", async () => {
    // discovery(120s ごと) が dormant(240s ごと) より短い間隔で走る、実際の既定構成
    const { dex, sent, engine, setNow } = setup();
    const p = makePair({ ageHours: 40, volH1: 50, volH24: 1_500, price: 0.001, liq: 15_000, changeH1: -2 });
    dex.searchResults = [p];
    await engine.discover();
    expect(sent).toHaveLength(0);

    const live = dex.pairs.get(p.pairAddress.toLowerCase())!;
    let t = NOW;
    // 10 分間、discovery だけが 120 秒ごとに回る（検索上位に居座るペアを想定）
    for (let i = 1; i <= 5; i++) {
      t = NOW + i * 120_000;
      setNow(t);
      await engine.discover();
    }
    expect(sent).toHaveLength(0);

    // ここでスパイク。次の discovery で必ず検知されなければならない
    t += 120_000;
    setNow(t);
    live.volume = { m5: 4_000, h1: 30_000, h6: 30_000, h24: 31_000 };
    live.priceUsd = "0.0015";
    live.priceChange.h1 = 50;
    live.liquidity = { usd: 40_000 };
    await engine.discover();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("復活スパイク検知");
  });

  it("discovery は既存ペアのスナップショットも残す（安値比の計算に必要）", async () => {
    const { dex, engine, store, setNow } = setup();
    const p = makePair({ ageHours: 40, volH1: 50, volH24: 1_000, price: 0.001, liq: 15_000 });
    dex.searchResults = [p];
    await engine.discover();
    setNow(NOW + 120_000);
    await engine.discover();
    setNow(NOW + 240_000);
    await engine.discover();
    expect(store.listSnapshots(p.pairAddress, 0)).toHaveLength(3);
  });
});

describe("Engine — 自己診断", () => {
  it("対象チェーンのペアが取れない状態が続いたら Telegram に警告する", async () => {
    const { sent, engine } = setup();
    // 対象チェーンのペアが 1 件も返らない = CHAIN_ID の設定ミスを想定
    for (let i = 0; i < 4; i++) await engine.discover();
    expect(sent).toHaveLength(0);
    await engine.discover();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("監視対象が 1 件も見つかりません");
    expect(sent[0]).toContain("CHAIN_ID");
  });

  it("同じ警告を何度も送らない", async () => {
    const { sent, engine, setNow } = setup();
    for (let i = 0; i < 6; i++) await engine.discover();
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 6; i++) await engine.discover();
    expect(sent).toHaveLength(1);
    // クールダウン（6時間）経過後は再度警告する
    setNow(NOW + 7 * H);
    await engine.discover();
    expect(sent).toHaveLength(2);
  });

  it("ペアが取れるようになったら警告は止まり、カウンタが戻る", async () => {
    const { dex, sent, engine } = setup();
    for (let i = 0; i < 5; i++) await engine.discover();
    expect(sent).toHaveLength(1);
    dex.searchResults = [makePair({ ageHours: 40, volH1: 10, volH24: 100, liq: 20_000 })];
    await engine.discover();
    expect(engine.stats.emptyDiscoveries).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("/test は監視ペアの実データで見本を送る", async () => {
    const { dex, sent, engine } = setup();
    dex.searchResults = [makePair({ symbol: "MIKE", ageHours: 40, volH1: 8_000, volH24: 90_000, liq: 50_000 })];
    await engine.discover();
    sent.length = 0;
    const reply = await engine.sendSampleAlert();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("テスト送信");
    expect(sent[0]).toContain("$MIKE");
    expect(reply).toContain("MIKE");
  });

  it("/test は監視ペアが無くても配信経路だけ確認できる", async () => {
    const { sent, engine } = setup();
    const reply = await engine.sendSampleAlert();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("配信経路は正常です");
    expect(reply).toContain("0 件");
  });
});

describe("Engine — スキャム除外", () => {
  /** 利用者が報告した $PUMPS 相当の、作られた出来高の銘柄 */
  function bundled() {
    const p = makePair({
      symbol: "PUMPS",
      address: "0xscampair",
      token: "0xscamtoken",
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

  it("バンドル銘柄は通知せず、履歴には理由付きで残る", async () => {
    const { dex, sent, store, engine } = setup();
    dex.searchResults = [bundled()];
    await engine.discover();

    expect(sent).toHaveLength(0);
    const blocked = store.recentSuppressed(10);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.symbol).toBe("PUMPS");
    expect(blocked[0]!.scam_score).toBeGreaterThanOrEqual(50);
    expect(blocked[0]!.scam_reasons).toContain("洗浄取引");
    // 通知した扱いにはしない
    expect(store.recentAlerts(10)).toHaveLength(0);
    expect(engine.stats.alertsSuppressed).toBe(1);
  });

  it("フィルタを切れば通知される", async () => {
    const { dex, sent, engine } = setup({ SCAM_FILTER_ENABLED: "false" });
    dex.searchResults = [bundled()];
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("しきい値を上げれば通知される", async () => {
    const { dex, sent, engine } = setup({ SCAM_SCORE_THRESHOLD: "99" });
    dex.searchResults = [bundled()];
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("健全な銘柄はこれまで通り通知される", async () => {
    const { dex, sent, engine } = setup();
    const good = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 45_000, buysH1: 90, sellsH1: 60 });
    good.fdv = 600_000;
    good.marketCap = 600_000;
    dex.searchResults = [good];
    await engine.discover();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("新規ローンチ検知");
  });

  it("止めた銘柄はクールダウン判定に影響しない（後で健全になれば通知できる）", async () => {
    const { dex, sent, engine, setNow } = setup();
    dex.searchResults = [bundled()];
    await engine.discover();
    expect(sent).toHaveLength(0);

    // 流動性が厚くなり、出来高が落ち着いた＝健全化した状態
    const live = dex.pairs.get("0xscampair")!;
    setNow(NOW + 30 * 60_000);
    live.liquidity = { usd: 900_000 };
    live.volume = { m5: 5_000, h1: 120_000, h24: 900_000 };
    live.priceChange.h1 = 45;
    live.fdv = 9_000_000;
    live.marketCap = 9_000_000;
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("通知はするが気になる点があるものは、理由が本文に載る", async () => {
    const { dex, sent, engine } = setup();
    // リスク 12（薄めの流動性）だけ立つ銘柄。表示しきい値を 10 に下げて確認する
    const p = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 30_000, buysH1: 90, sellsH1: 60 });
    p.fdv = 1_000_000;
    p.marketCap = 1_000_000;
    const { dex: d2, sent: s2, engine: e2 } = setup({ SCAM_SHOW_SCORE_FROM: "10" });
    d2.searchResults = [p];
    await e2.discover();
    expect(s2[0]).toContain("注意点");
    void dex;
    void sent;
    void engine;
  });
});

describe("Store — 既存 DB の移行", () => {
  it("スキャム列が無い古い alerts テーブルでも起動できる", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhbot-migrate-"));
    const file = path.join(dir, "old.sqlite");
    // 旧スキーマの DB を用意する
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, token_address TEXT NOT NULL,
      pair_address TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 1,
      price_usd REAL, symbol TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '')`);
    old.prepare("INSERT INTO alerts(kind, token_address, pair_address, ts, level, price_usd, symbol, summary) VALUES(?,?,?,?,?,?,?,?)")
      .run("revival", "0xa", "0xb", NOW, 1, 0.5, "OLD", "以前の通知");
    old.close();

    // 新しいコードで開く
    const store = new Store(file);
    expect(store.recentAlerts(10)).toHaveLength(1);
    expect(store.recentAlerts(10)[0]!.symbol).toBe("OLD");
    expect(store.recentAlerts(10)[0]!.scam_score).toBe(0);
    expect(store.recentSuppressed(10)).toHaveLength(0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
