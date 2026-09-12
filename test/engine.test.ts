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
    expect(sent[0]).toContain("新規ローンチ");
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
    expect(sent[0]).toMatch(/静穏から復活|レンジ上抜け|急変/);
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
    expect(sent[1]).toContain("＋2 段目");
  });

  it("lookback 最安値比でも復活を検知できる（1h 変化率が小さい場合）", async () => {
    const { dex, sent, engine, setNow } = setup();
    const p = makePair({ ageHours: 40, volH1: 50, volH24: 1_000, price: 0.001, liq: 15_000 });
    // helpers の既定 MC $2M に流動性 $15K だと深さ 0.75%＝ラグ後の形になってしまう。この試験の主題ではない
    p.marketCap = 300_000;
    p.fdv = 300_000;
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
    // 1h 変化率(+12%)ではしきい値に届かず、自前スナップショットの安値比で拾えている
    expect(sent[0]).toMatch(/静穏から復活|レンジ上抜け/);
    expect(sent[0]).toContain("底値から");
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
    expect(sent[0]).toMatch(/静穏から復活|レンジ上抜け|急変/);
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

  // 報告された $PUMPS は MC $855K で、新規ローンチの下限($1M)にも掛かる。
  // ここで見たいのはスキャム除外そのものなので、下限を外して切り分ける
  it("バンドル銘柄は通知せず、履歴には理由付きで残る", async () => {
    const { dex, sent, store, engine } = setup({ NEW_MIN_MC_USD: "0" });
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
    const { dex, sent, engine } = setup({ SCAM_FILTER_ENABLED: "false", NEW_MIN_MC_USD: "0" });
    dex.searchResults = [bundled()];
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("しきい値を上げれば通知される", async () => {
    const { dex, sent, engine } = setup({ SCAM_SCORE_THRESHOLD: "99", NEW_MIN_MC_USD: "0" });
    dex.searchResults = [bundled()];
    await engine.discover();
    expect(sent).toHaveLength(1);
  });

  it("健全な銘柄はこれまで通り通知される", async () => {
    const { dex, sent, engine } = setup();
    const good = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 45_000, buysH1: 90, sellsH1: 60 });
    good.fdv = 2_400_000;
    good.marketCap = 2_400_000;
    dex.searchResults = [good];
    await engine.discover();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("新規ローンチ");
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
    p.fdv = 1_200_000;
    p.marketCap = 1_200_000;
    const { dex: d2, sent: s2, engine: e2 } = setup({ SCAM_SHOW_SCORE_FROM: "10" });
    d2.searchResults = [p];
    await e2.discover();
    expect(s2[0]).toContain("注意");
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

describe("Engine — 反省の材料と収穫", () => {
  it("通知に反省用の属性（時価総額・経路・出来高・売買件数・年齢）を残す", async () => {
    const { dex, engine, store } = setup();
    const p = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 45_000, buysH1: 90, sellsH1: 60 });
    p.marketCap = 2_400_000;
    p.fdv = 2_400_000;
    dex.searchResults = [p];
    await engine.discover();
    const a = store.recentAlerts(1)[0]!;
    expect(a.trigger).toBe("new");
    expect(a.mc_usd).toBe(2_400_000);
    expect(a.vol_h1).toBe(60_000);
    expect(a.buys_h1).toBe(90);
    expect(a.sells_h1).toBe(60);
    expect(a.age_hours).toBeCloseTo(3, 1);
  });

  it("結果追跡 → 日次レポート送信。同じ日に二度は送らない", async () => {
    const { dex, sent, engine, store, setNow } = setup({ REPORT_HOUR_JST: "0" });
    const p = makePair({ ageHours: 3, volH1: 60_000, volH24: 150_000, liq: 45_000, buysH1: 90, sellsH1: 60 });
    p.marketCap = 2_400_000;
    p.fdv = 2_400_000;
    dex.searchResults = [p];
    await engine.discover(); // 通知 1 件
    // 5 時間分の値動きを記録する（+50% → 的中）
    const live = dex.pairs.get(p.pairAddress.toLowerCase())!;
    for (let m = 15; m <= 300; m += 15) {
      setNow(NOW + m * 60_000);
      live.priceUsd = String(0.001 * (1 + Math.min(0.5, m / 200)));
      await engine.refreshTier("hot", 1);
    }
    expect(engine.runOutcomes()).toBeGreaterThan(0);
    expect(store.getOutcome(1)!.hit).toBe(1);

    sent.length = 0;
    expect(await engine.maybeSendDailyReport()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("日次レポート");
    expect(sent[0]).toContain("的中");
    expect(await engine.maybeSendDailyReport()).toBe(false); // 同日は送らない
    expect(store.recentDailyReports(1)).toHaveLength(1);
  });

  it("/report は判定前でも文章を返す", async () => {
    const { engine } = setup();
    expect(engine.buildReport()).toContain("日次レポート");
  });

  it("RPC が無ければ収穫はスキップ、あっても対象が無ければ 0", async () => {
    const { engine } = setup();
    expect(await engine.runHarvests()).toBe(0);
  });
});

describe("Store — 旧バージョンの DB を引き継いで起動する", () => {
  /** peak_* も market_cap も無かった頃の pairs / snapshots / alerts を作る */
  function legacyDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhbot-legacy-"));
    const file = path.join(dir, "bot.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE pairs (
      pair_address TEXT PRIMARY KEY, chain_id TEXT NOT NULL, dex_id TEXT NOT NULL DEFAULT '',
      labels TEXT NOT NULL DEFAULT '', base_address TEXT NOT NULL, base_symbol TEXT NOT NULL DEFAULT '',
      base_name TEXT NOT NULL DEFAULT '', quote_address TEXT NOT NULL DEFAULT '', quote_symbol TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '', pair_created_at INTEGER, first_seen_at INTEGER NOT NULL,
      last_refreshed_at INTEGER NOT NULL DEFAULT 0, last_price_usd REAL, last_liquidity_usd REAL NOT NULL DEFAULT 0,
      last_vol_h1 REAL NOT NULL DEFAULT 0, last_vol_h24 REAL NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'hot',
      dead_since INTEGER, source TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0,
      miss_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pair_address TEXT NOT NULL, ts INTEGER NOT NULL, price_usd REAL,
      vol_h1 REAL NOT NULL DEFAULT 0, vol_h24 REAL NOT NULL DEFAULT 0, liquidity_usd REAL NOT NULL DEFAULT 0,
      buys_h1 INTEGER NOT NULL DEFAULT 0, sells_h1 INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, token_address TEXT NOT NULL,
      pair_address TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 1, price_usd REAL,
      symbol TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '')`);
    db.prepare(
      `INSERT INTO pairs(pair_address, chain_id, base_address, base_symbol, first_seen_at, last_refreshed_at, tier)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run("0xold", "robinhood", "0xoldtoken", "OLD", NOW - 5 * H, NOW - H, "dormant");
    db.prepare("INSERT INTO snapshots(pair_address, ts, price_usd, vol_h1) VALUES(?, ?, ?, ?)").run("0xold", NOW - 2 * H, 0.5, 1000);
    db.prepare("INSERT INTO alerts(kind, token_address, pair_address, ts, level, price_usd, symbol, summary) VALUES(?,?,?,?,?,?,?,?)")
      .run("revival", "0xoldtoken", "0xold", NOW - 3 * H, 1, 0.4, "OLD", "以前の通知");
    // tag 列が無い頃の wallets 表（自動収穫が既に動いていた DB）
    db.exec(`CREATE TABLE wallets (
      address TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, buys INTEGER NOT NULL DEFAULT 0,
      quote_volume REAL NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    db.prepare("INSERT INTO wallets(address, hits, buys, quote_volume, first_seen, last_seen) VALUES(?,?,?,?,?,?)").run("0xoldwallet", 1, 2, 0.5, NOW - 4 * H, NOW - 3 * H);
    db.close();
    return file;
  }

  it("tag 列の無い wallets 表を持つ DB でも、印を付けられる", () => {
    const store = new Store(legacyDb());
    const w = store.getWallet("0xoldwallet")!;
    expect(w.hits).toBe(1);
    expect(w.tag).toBe("");
    store.recordWalletBuys([{ wallet: "0xoldwallet", token_address: "0xoldtoken", pair_address: "0xold", alert_id: 1, symbol: "OLD", ts: NOW - 3 * H, block: 1, quote_amount: 1, tx_hash: "0xh1" }]);
    expect(store.tagWalletsForToken("0xoldtoken", "OLD")).toBe(1);
    expect(store.getWallet("0xoldwallet")!.tag).toBe("OLD");
    expect(store.topWallets(5, 1)[0]!.tag).toBe("OLD");
    store.close();
  });

  it("列も索引も足りない DB を開いて起動できる（peak_mc への索引で落ちない）", () => {
    const file = legacyDb();
    const store = new Store(file); // ここで例外が出ないことが要件
    const row = store.getPair("0xold")!;
    expect(row.base_symbol).toBe("OLD");
    expect(row.peak_mc).toBe(0);
    expect(row.peak_vol_h1).toBe(0);
    expect(store.recentAlerts(5)[0]!.symbol).toBe("OLD");
    expect(store.recentAlerts(5)[0]!.mc_usd).toBe(0);
    store.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("引き継いだ DB でも、更新後は新機能がそのまま動く", () => {
    const file = legacyDb();
    const store = new Store(file);
    const p = makePair({ address: "0xold", token: "0xoldtoken", symbol: "OLD", volH1: 50_000 });
    p.marketCap = 4_000_000;
    p.fdv = 4_000_000;
    store.upsertPair(p, "test", NOW);
    store.insertSnapshot(p, NOW);
    expect(store.getPair("0xold")!.peak_mc).toBe(4_000_000);
    expect(store.listPriorityForRefresh(1_000_000, NOW + 1, 10)).toHaveLength(1);
    expect(store.maxMcBetween("0xold", NOW - H, NOW + H)).toBe(4_000_000);
    store.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("二度目の起動でも壊れない（索引が既にある状態）", () => {
    const file = legacyDb();
    new Store(file).close();
    const again = new Store(file);
    expect(again.getPair("0xold")).not.toBeNull();
    again.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe("Engine — /ranges: いま何を待っているか", () => {
  /**
   * 全盛期 MC $5M → 冷え込み → $1.0M〜$1.5M で 30 時間ヨコヨコ、という銘柄を
   * スナップショットから組み立てる。実際の履歴と同じ形で入れないと、
   * 一覧に出る条件と通知が鳴る条件がずれていても気づけない。
   */
  function seedConsolidation(store: Store, opts: { symbol: string; peakMc: number; low: number; high: number; nowMc: number }) {
    const addr = `0xpair_${opts.symbol.toLowerCase()}`;
    const mk = (mc: number) => {
      const p = makePair({ address: addr, token: `0xtok_${opts.symbol.toLowerCase()}`, symbol: opts.symbol, ageHours: 60, price: mc / 1e9 });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    // 全盛期を先に通す（peak_mc は upsert で記録される）
    store.upsertPair(mk(opts.peakMc), "test", NOW - 50 * H);
    // 30 時間ぶん、帯の中を往復させる
    for (let i = 0; i < 40; i++) {
      const mc = i % 2 === 0 ? opts.low : opts.high;
      store.insertSnapshot(mk(mc), NOW - (31 - i * 0.75) * H);
    }
    store.insertSnapshot(mk(opts.nowMc), NOW - 60_000);
    return addr;
  }

  it("ヨコヨコ中の銘柄を、上抜けまでの距離が近い順に出す", () => {
    const { store, engine } = setup();
    seedConsolidation(store, { symbol: "FAR", peakMc: 5_000_000, low: 1_000_000, high: 1_500_000, nowMc: 1_050_000 });
    seedConsolidation(store, { symbol: "NEAR", peakMc: 5_000_000, low: 1_000_000, high: 1_500_000, nowMc: 1_480_000 });

    const list = engine.rangeWatchlist(NOW);
    expect(list.map((w) => w.row.base_symbol)).toEqual(["NEAR", "FAR"]);

    const near = list[0];
    expect(near.range.low).toBe(1_000_000);
    expect(near.range.high).toBe(1_500_000);
    expect(near.currentMc).toBe(1_480_000);
    expect(near.primed).toBe(true);
    // 上抜けは帯の上限 +REIGNITE_BREAKOUT_PCT
    expect(near.triggerMc).toBeCloseTo(1_500_000 * (1 + cfgFor().reigniteBreakoutPct / 100), -2);
    expect(near.toBreakoutPct).toBeGreaterThan(0);
    expect(near.posInRangePct).toBeCloseTo(96, 0);
  });

  it("一覧が『あと少し』と言った銘柄は、そこまで上げると実際に通知が出る", async () => {
    const { store, engine, dex, sent } = setup();
    const addr = seedConsolidation(store, { symbol: "GO", peakMc: 5_000_000, low: 1_000_000, high: 1_500_000, nowMc: 1_480_000 });
    const w = engine.rangeWatchlist(NOW)[0];
    expect(w.toBreakoutPct).toBeGreaterThan(0);
    expect(w.primed).toBe(true);

    // 一覧が示した上抜け価格まで実際に上げてみる。
    // ここで鳴らないなら、一覧の「あと +X%」は嘘をついていることになる
    const broke = makePair({
      address: addr,
      token: "0xtok_go",
      symbol: "GO",
      ageHours: 60,
      price: (w.triggerMc * 1.01) / 1e9,
      volH1: 180_000,
      volH24: 2_100_000,
      liq: 260_000,
      buysH1: 90,
      sellsH1: 70,
    });
    broke.marketCap = w.triggerMc * 1.01;
    broke.fdv = broke.marketCap;
    dex.set(broke);
    store.setTier(addr, "dormant", NOW - 10 * H);
    await engine.refreshTier("dormant", 5);

    expect(sent.join("\n")).toContain("$GO");
    const alert = store.recentAlerts(5).find((a) => a.symbol === "GO");
    expect(alert?.trigger).toBe("reignite");
  });

  it("全盛期が小さい銘柄は帯を組んでいても『条件未達』として区別する", () => {
    const { store, engine } = setup();
    seedConsolidation(store, { symbol: "SMALL", peakMc: 200_000, low: 100_000, high: 150_000, nowMc: 140_000 });
    const list = engine.rangeWatchlist(NOW);
    // 母集団に入らない（peak_mc がしきい値未満で手動でもない）
    expect(list).toHaveLength(0);
  });

  it("冷え込んでいない（全盛期の近くにいる）銘柄は primed にしない", () => {
    const { store, engine } = setup();
    seedConsolidation(store, { symbol: "HOT", peakMc: 1_600_000, low: 1_000_000, high: 1_500_000, nowMc: 1_450_000 });
    const w = engine.rangeWatchlist(NOW)[0];
    expect(w.cooledRatio).toBeGreaterThan(cfgFor().reigniteCooledRatio);
    expect(w.primed).toBe(false);
  });

  it("観測が足りない銘柄は一覧に出さない（帯と呼べないため）", () => {
    const { store, engine } = setup();
    const p = makePair({ address: "0xpair_thin", symbol: "THIN", ageHours: 60 });
    p.marketCap = 1_200_000;
    p.fdv = 1_200_000;
    store.upsertPair(p, "test", NOW - 50 * H);
    store.insertSnapshot(p, NOW - H);
    expect(engine.rangeWatchlist(NOW)).toHaveLength(0);
  });
});

function cfgFor() {
  return makeConfig({ DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_TOKEN_ADDRESSES: "", DISCOVERY_USE_PROFILES: "false" });
}

describe("Engine — $MOO: 全盛期 $600K・7.5 時間の帯を監視に入れる", () => {
  /** 15 分足で見た $MOO: 初動で $600K → $150〜200K で 7.5 時間ヨコヨコ → 上抜け */
  function seedMoo(store: Store, opts: { peakMc: number; rangeHours: number; nowMc: number; symbol?: string }) {
    const symbol = opts.symbol ?? "MOO";
    const addr = `0xpair_${symbol.toLowerCase()}`;
    const mk = (mc: number) => {
      const p = makePair({ address: addr, token: `0xtok_${symbol.toLowerCase()}`, symbol, ageHours: 20, price: mc / 1e9, liq: 25_000 });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    store.upsertPair(mk(opts.peakMc), "test", NOW - 12 * H);
    // 45 秒間隔（hot）で観測される想定。帯の中を往復
    const n = Math.floor((opts.rangeHours * 3600) / 45);
    for (let i = 0; i < n; i++) store.insertSnapshot(mk(i % 2 === 0 ? 150_000 : 200_000), NOW - (opts.rangeHours + 0.2) * H + i * 45_000);
    store.insertSnapshot(mk(opts.nowMc), NOW - 60_000);
    return addr;
  }

  it("新しい門（$300K / 6h）では監視に入り、上抜けまでの距離が出る", () => {
    const { store, engine } = setup();
    seedMoo(store, { peakMc: 600_000, rangeHours: 7.5, nowMc: 185_000 });
    const list = engine.rangeWatchlist(NOW);
    expect(list.map((w) => w.row.base_symbol)).toContain("MOO");
    const w = list.find((x) => x.row.base_symbol === "MOO")!;
    expect(w.primed).toBe(true);
    expect(w.range.low).toBe(150_000);
    expect(w.range.high).toBe(200_000);
    expect(w.toBreakoutPct).toBeGreaterThan(0);
  });

  it("旧の門（$800K / 12h）だと二重に漏れていた（回帰の記録）", () => {
    const cfgOld = makeConfig({ DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_USE_PROFILES: "false", REIGNITE_MIN_PEAK_MC_USD: "800000", RANGE_MIN_HOURS: "12" });
    const store = new Store(":memory:");
    const engine = new Engine(cfgOld, store, {} as unknown as DexScreenerClient, { broadcast: async () => {} }, null, () => NOW);
    seedMoo(store, { peakMc: 600_000, rangeHours: 7.5, nowMc: 185_000 });
    expect(engine.rangeWatchlist(NOW)).toHaveLength(0);
    const d = engine.rangeDiagnosis("0xtok_moo", NOW)!;
    expect(d.peakOk).toBe(false);
    expect(d.inCandidates).toBe(false);
    // 帯も 12h に届かない
    expect(d.range).toBeNull();
    expect(d.windows.some((w) => w.why.includes("< 12h"))).toBe(true);
  });

  it("診断は『何が足りないか』を窓ごとに言う", () => {
    const { store, engine } = setup();
    // 全盛期は門を超えるが、帯がまだ 2 時間しか無い
    seedMoo(store, { peakMc: 600_000, rangeHours: 2, nowMc: 185_000, symbol: "YOUNG" });
    const d = engine.rangeDiagnosis("0xtok_young", NOW)!;
    expect(d.peakOk).toBe(true);
    expect(d.cooled).toBe(true);
    expect(d.range).toBeNull();
    expect(d.primed).toBe(false);
    expect(d.windows.every((w) => !w.ok)).toBe(true);
    expect(d.windows[d.windows.length - 1]!.why).toMatch(/期間 .*h < 6h/);
  });

  it("まだ冷えていない銘柄は、母集団にいても primed にしない", () => {
    const { store, engine } = setup();
    seedMoo(store, { peakMc: 600_000, rangeHours: 7.5, nowMc: 560_000, symbol: "WARM" });
    const d = engine.rangeDiagnosis("0xtok_warm", NOW)!;
    expect(d.inCandidates).toBe(true);
    expect(d.cooled).toBe(false);
    expect(d.primed).toBe(false);
  });

  it("知らないアドレスは null", () => {
    const { engine } = setup();
    expect(engine.rangeDiagnosis("0xnobody", NOW)).toBeNull();
  });
});

describe("Engine — 死んだ銘柄をヨコヨコ監視から外す（RANGE_MIN_MC_USD）", () => {
  /** 全盛期 $600K → $8K で平坦。全盛期の門は通るが、いまは死んでいる */
  function seedDead(store: Store, nowMc: number, symbol = "DEAD") {
    const addr = `0xpair_${symbol.toLowerCase()}`;
    const mk = (mc: number) => {
      const p = makePair({ address: addr, token: `0xtok_${symbol.toLowerCase()}`, symbol, ageHours: 40, price: mc / 1e9, liq: 6_000 });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    store.upsertPair(mk(600_000), "test", NOW - 30 * H);
    for (let i = 0; i < 40; i++) store.insertSnapshot(mk(i % 2 === 0 ? nowMc * 0.95 : nowMc * 1.05), NOW - (10 - i * 0.24) * H);
    store.insertSnapshot(mk(nowMc), NOW - 60_000);
    return addr;
  }

  it("いまの時価総額が下限未満なら一覧に出ない（利用者が見た $10K 未満の行）", () => {
    const { store, engine, cfg } = setup();
    seedDead(store, 8_000, "DEAD");
    seedDead(store, 60_000, "ALIVE");
    expect(cfg.rangeMinMcUsd).toBeGreaterThan(10_000);
    const list = engine.rangeWatchlist(NOW);
    expect(list.map((w) => w.row.base_symbol)).toEqual(["ALIVE"]);
  });

  it("診断はその理由を言う", () => {
    const { store, engine } = setup();
    seedDead(store, 8_000);
    const d = engine.rangeDiagnosis("0xtok_dead", NOW)!;
    expect(d.peakOk).toBe(true);
    expect(d.inCandidates).toBe(true);
    expect(d.mcOk).toBe(false);
    expect(d.primed).toBe(false);
  });

  it("下限は設定で動かせる", () => {
    const cfgLoose = makeConfig({ DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_USE_PROFILES: "false", RANGE_MIN_MC_USD: "5000" });
    const store = new Store(":memory:");
    const engine = new Engine(cfgLoose, store, {} as unknown as DexScreenerClient, { broadcast: async () => {} }, null, () => NOW);
    seedDead(store, 8_000);
    expect(engine.rangeWatchlist(NOW)).toHaveLength(1);
  });
});

describe("Engine — /ranges にバンドルを並べない", () => {
  /**
   * 利用者が /ranges で見た 2 つの型:
   *   A. 流動性を抜かれた銘柄（平坦な線だけ残る）
   *   B. ボットが一定の出来高で価格を固定している銘柄
   * どちらも全盛期の門は通り、帯の条件も満たすので、判定なしでは一覧に出てしまう
   */
  function seedFlat(store: Store, o: { symbol: string; liq: number; volH1: (hour: number) => number; buys: number; sells: number; nowMc?: number }) {
    const addr = `0xpair_${o.symbol.toLowerCase()}`;
    const mk = (mc: number, liq: number, volH1: number) => {
      const p = makePair({ address: addr, token: `0xtok_${o.symbol.toLowerCase()}`, symbol: o.symbol, ageHours: 60, price: mc / 1e9, liq, volH1, volH24: volH1 * 20, buysH1: o.buys, sellsH1: o.sells });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    store.upsertPair(mk(600_000, 80_000, 50_000), "test", NOW - 40 * H);
    const nowMc = o.nowMc ?? 120_000;
    // 12 時間、45 秒ごと。時価総額は狭い帯、出来高は関数で与える
    for (let t = 12 * H; t > 0; t -= 45_000) {
      const hour = Math.floor(t / H);
      const mc = nowMc * (t % (2 * 45_000) === 0 ? 0.97 : 1.03);
      store.insertSnapshot(mk(mc, o.liq, o.volH1(hour)), NOW - t);
    }
    return addr;
  }

  it("A. 流動性を抜かれた銘柄は一覧に出さない", () => {
    const { store, engine } = setup();
    seedFlat(store, { symbol: "RUGGED", liq: 400, volH1: () => 200, buys: 2, sells: 1 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list).toHaveLength(0);
    expect(r.excludedLiq).toBe(1);
    const d = engine.rangeDiagnosis("0xtok_rugged", NOW)!;
    expect(d.liqOk).toBe(false);
    expect(d.primed).toBe(false);
  });

  it("B. 一定の出来高で回されている銘柄は一覧に出さない", () => {
    const { store, engine } = setup();
    // 流動性 $20K に対し毎時 $30K が判で押したように流れる。少数の大口、買い偏重
    seedFlat(store, { symbol: "BOTTED", liq: 20_000, volH1: () => 30_000, buys: 40, sells: 12 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list).toHaveLength(0);
    expect(r.excludedScam).toBe(1);
    const d = engine.rangeDiagnosis("0xtok_botted", NOW)!;
    expect(d.scam!.signals.map((s) => s.id)).toContain("steady_wash");
    expect(d.scam!.score).toBeGreaterThanOrEqual(cfgFor().scamScoreThreshold);
  });

  it("本物の帯（出来高が波打ち、参加者に厚みがある）は残る", () => {
    const { store, engine } = setup();
    // 出来高は時間ごとに 3 倍〜1/3 で揺れる。小口が多数
    seedFlat(store, { symbol: "REAL", liq: 40_000, volH1: (h) => [4_000, 15_000, 9_000, 2_500, 12_000, 6_000, 20_000, 3_000, 8_000, 11_000, 5_000, 14_000][h % 12]!, buys: 50, sells: 40 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list.map((w) => w.row.base_symbol)).toEqual(["REAL"]);
    expect(r.excludedScam + r.excludedLiq).toBe(0);
    expect(r.list[0]!.scam!.signals.map((s) => s.id)).not.toContain("steady_wash");
  });

  it("一覧で除外した銘柄は、上抜けても通知しない（一覧と通知がずれない）", async () => {
    const { store, engine, dex, sent } = setup();
    const addr = seedFlat(store, { symbol: "BOTTED", liq: 20_000, volH1: () => 30_000, buys: 40, sells: 12 });
    // 帯の上限 +10% まで上げる
    const broke = makePair({ address: addr, token: "0xtok_botted", symbol: "BOTTED", ageHours: 60, price: 0.000136, liq: 20_000, volH1: 30_000, volH24: 600_000, buysH1: 40, sellsH1: 12, changeH1: 10 });
    broke.marketCap = 136_000;
    broke.fdv = 136_000;
    dex.set(broke);
    store.setTier(addr, "dormant", NOW - H);
    await engine.refreshTier("dormant", 5);
    expect(sent.join("\n")).not.toContain("$BOTTED");
    const a = store.recentSuppressed(5).find((x) => x.symbol === "BOTTED");
    expect(a).toBeDefined();
    expect(a!.scam_reasons).toContain("ほぼ一定");
  });
});

describe("Engine — 取引が途絶えた銘柄をヨコヨコ監視から外す（RANGE_MAX_IDLE_HOURS）", () => {
  /**
   * 全盛期を通り、帯の条件も満たすが、取引が止まっている銘柄。
   * @param idleHours 最後の取引からの時間。それ以降のスナップショットは buys/sells = 0
   */
  function seedIdle(store: Store, o: { symbol: string; liq: number; mc: number; idleHours: number }) {
    const addr = `0xpair_${o.symbol.toLowerCase()}`;
    const mk = (mc: number, active: boolean) => {
      const p = makePair({
        address: addr, token: `0xtok_${o.symbol.toLowerCase()}`, symbol: o.symbol, ageHours: 16, price: mc / 1e9, liq: o.liq,
        volH1: active ? 3_000 : 0, volH24: 40_000, buysH1: active ? 18 : 0, sellsH1: active ? 14 : 0,
      });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    store.upsertPair(mk(600_000, true), "test", NOW - 15 * H);
    for (let t = 12 * H; t > 0; t -= 45_000) {
      const active = t > o.idleHours * H;
      store.insertSnapshot(mk(o.mc * (t % 90_000 === 0 ? 0.97 : 1.03), active), NOW - t);
    }
    return addr;
  }

  it("$PUMPED（流動性 $1.2K・取引停止）は一覧に出ない", () => {
    const { store, engine } = setup();
    seedIdle(store, { symbol: "PUMPED", liq: 1_200, mc: 68_100, idleHours: 4 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list).toHaveLength(0);
    const d = engine.rangeDiagnosis("0xtok_pumped", NOW)!;
    expect(d.liqOk).toBe(false);
    expect(d.idleOk).toBe(false);
    expect(d.primed).toBe(false);
  });

  it("流動性は十分でも、3 時間取引が無ければ外す", () => {
    const { store, engine } = setup();
    seedIdle(store, { symbol: "SLEEPY", liq: 40_000, mc: 120_000, idleHours: 4 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list).toHaveLength(0);
    expect(r.excludedIdle).toBe(1);
    expect(r.excludedLiq).toBe(0);
    const d = engine.rangeDiagnosis("0xtok_sleepy", NOW)!;
    expect(d.idleMs).toBeGreaterThanOrEqual(4 * H - 60_000);
    expect(d.idleOk).toBe(false);
  });

  it("取引が続いていれば残り、止まっていた時間が短ければ残る", () => {
    const { store, engine } = setup();
    seedIdle(store, { symbol: "AWAKE", liq: 40_000, mc: 120_000, idleHours: 0 });
    seedIdle(store, { symbol: "NAP", liq: 40_000, mc: 120_000, idleHours: 1.5 });
    const r = engine.rangeWatchlistDetailed(NOW);
    expect(r.list.map((w) => w.row.base_symbol).sort()).toEqual(["AWAKE", "NAP"]);
    expect(r.excludedIdle).toBe(0);
  });

  it("目を覚ませば（取引が戻れば）自動で一覧に戻る", () => {
    const { store, engine } = setup();
    const addr = seedIdle(store, { symbol: "WAKE", liq: 40_000, mc: 120_000, idleHours: 4 });
    expect(engine.rangeWatchlistDetailed(NOW).list).toHaveLength(0);
    const p = makePair({ address: addr, token: "0xtok_wake", symbol: "WAKE", ageHours: 16, price: 0.00012, liq: 40_000, volH1: 5_000, volH24: 40_000, buysH1: 20, sellsH1: 15 });
    p.marketCap = 120_000;
    p.fdv = 120_000;
    store.insertSnapshot(p, NOW - 30_000);
    expect(engine.rangeWatchlistDetailed(NOW).list.map((w) => w.row.base_symbol)).toEqual(["WAKE"]);
  });

  it("しきい値は設定で動かせる", () => {
    const cfgLoose = makeConfig({ DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_USE_PROFILES: "false", RANGE_MAX_IDLE_HOURS: "6" });
    const store = new Store(":memory:");
    const engine = new Engine(cfgLoose, store, {} as unknown as DexScreenerClient, { broadcast: async () => {} }, null, () => NOW);
    seedIdle(store, { symbol: "SLEEPY", liq: 40_000, mc: 120_000, idleHours: 4 });
    expect(engine.rangeWatchlistDetailed(NOW).list).toHaveLength(1);
  });
});

describe("Engine — /scam: 利用者の手動スキャム指定", () => {
  function seedCalled(store: Store, symbol: string, score = 12) {
    const addr = `0xpair_${symbol.toLowerCase()}`;
    const tok = `0xtok_${symbol.toLowerCase()}`;
    const mk = (mc: number) => {
      const p = makePair({ address: addr, token: tok, symbol, ageHours: 30, price: mc / 1e9, liq: 40_000, volH1: 20_000, volH24: 200_000, buysH1: 80, sellsH1: 60 });
      p.marketCap = mc;
      p.fdv = mc;
      return p;
    };
    store.upsertPair(mk(600_000), "test", NOW - 29 * H);
    for (let t = 10 * H; t > 0; t -= 60_000) store.insertSnapshot(mk(t % 120_000 === 0 ? 145_000 : 155_000), NOW - t);
    store.insertAlert({
      kind: "revival", token_address: tok, pair_address: addr, ts: NOW - 3 * H, level: 1, price_usd: 0.00015, symbol, summary: "t",
      scam_score: score, scam_reasons: score > 0 ? "流動性が時価総額の 4.9% と薄い" : "", suppressed: 0, mc_usd: 150_000, trigger: "fast", vol_h1: 20_000, buys_h1: 80, sells_h1: 60, age_hours: 27,
    });
    store.recordWalletBuys([
      { wallet: "0xbundler1", token_address: tok, pair_address: addr, alert_id: 1, symbol, ts: NOW - 4 * H, block: 1, quote_amount: 2, tx_hash: `0xh_${symbol}_1` },
      { wallet: "0xshared", token_address: tok, pair_address: addr, alert_id: 1, symbol, ts: NOW - 4 * H, block: 2, quote_amount: 1, tx_hash: `0xh_${symbol}_2` },
    ]);
    return { addr, tok };
  }

  it("登録すると一覧から消え、通知も止まり、フィルタが付けていた点数が残る", async () => {
    const { store, engine, dex, sent } = setup();
    const { addr, tok } = seedCalled(store, "WOLF", 12);
    expect(engine.rangeWatchlistDetailed(NOW).list.map((w) => w.row.base_symbol)).toEqual(["WOLF"]);

    const r = await engine.markScam(tok, "バンドル");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbol).toBe("WOLF");
    expect(r.alertScore).toBe(12); // フィルタは 12 点で通していた＝判定の穴として記録
    expect(store.listBlacklist()[0]!.note).toBe("バンドル");

    const w = engine.rangeWatchlistDetailed(NOW);
    expect(w.list).toHaveLength(0);
    expect(w.excludedManual).toBe(1);
    expect(engine.rangeDiagnosis(tok, NOW)!.manual).toBe(true);

    // 上抜けても鳴らず、止めた記録に理由が残る
    const broke = makePair({ address: addr, token: tok, symbol: "WOLF", ageHours: 30, price: 0.00018, liq: 40_000, volH1: 60_000, volH24: 300_000, buysH1: 120, sellsH1: 60, changeH1: 25, changeM5: 30 });
    broke.marketCap = 180_000;
    broke.fdv = 180_000;
    dex.set(broke);
    store.setTier(addr, "dormant", NOW - H);
    await engine.refreshTier("dormant", 5);
    expect(sent.join("\n")).not.toContain("$WOLF");
    const sup = store.recentSuppressed(5).find((a) => a.symbol === "WOLF")!;
    expect(sup).toBeDefined();
    expect(sup.scam_score).toBe(100);
    expect(sup.scam_reasons).toContain("/scam");
  });

  it("台帳からその銘柄の買い手を消す。他銘柄でも入っていた財布は残る", async () => {
    const { store, engine } = setup();
    const { tok } = seedCalled(store, "WOOD", 0);
    // 0xshared は本物の別銘柄でも早期に入っていた
    store.recordWalletBuys([{ wallet: "0xshared", token_address: "0xtok_legit", pair_address: "0xpair_legit", alert_id: 2, symbol: "LEGIT", ts: NOW - 5 * H, block: 3, quote_amount: 1, tx_hash: "0xh_legit" }]);
    expect(store.getWallet("0xshared")!.hits).toBe(2);
    const r = await engine.markScam(tok, "");
    expect(r.ok && r.purged).toBe(2);
    expect(store.getWallet("0xbundler1")).toBeNull();
    expect(store.getWallet("0xshared")!.hits).toBe(1); // WOOD ぶんだけ減る
  });

  it("取り消せる", async () => {
    const { store, engine } = setup();
    const { tok } = seedCalled(store, "OOPS");
    await engine.markScam(tok, "");
    expect(engine.unmarkScam(tok)).toBe(true);
    expect(store.isBlacklisted(tok)).toBe(false);
    expect(engine.rangeWatchlistDetailed(NOW).list.map((w) => w.row.base_symbol)).toEqual(["OOPS"]);
    expect(engine.unmarkScam(tok)).toBe(false);
  });

  it("知らないアドレスは理由を返す", async () => {
    const { engine } = setup();
    const r = await engine.markScam("0x0000000000000000000000000000000000000abc", "");
    expect(r.ok).toBe(false);
  });
});


describe("Engine — 新規ローンチの影運転（NEW_LAUNCH_MODE=shadow）", () => {
  it("通知せず、記録だけ残す。止めたものとは区別される", async () => {
    const { dex, sent, engine, store } = setup({ NEW_LAUNCH_MODE: "shadow" });
    dex.searchResults = [makePair({ ageHours: 1, volH1: 60_000 })];
    await engine.discover();
    expect(sent).toHaveLength(0);
    const rows = store.listAlertsWithOutcomes(NOW - H, NOW + H);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("new_launch");
    expect(rows[0]!.suppressed).toBe(1);
    expect(rows[0]!.shadow).toBe(1);
    expect(rows[0]!.scam_score).toBeLessThan(50); // スキャム判定で止めたのではない
    // /filtered（止めたもの）には出ない
    expect(store.recentSuppressed(5).filter((a) => a.shadow !== 1)).toHaveLength(0);
  });

  it("復活系は影運転の影響を受けない", async () => {
    const { dex, sent, engine, setNow } = setup({ NEW_LAUNCH_MODE: "shadow" });
    const p = makePair({ ageHours: 40, volH1: 50, volH24: 1_000, price: 0.001, liq: 15_000 });
    p.marketCap = 300_000;
    p.fdv = 300_000;
    dex.searchResults = [p];
    await engine.discover();
    setNow(NOW + 90 * 60_000);
    const cur = dex.pairs.get(p.pairAddress.toLowerCase())!;
    cur.priceUsd = "0.0016";
    cur.priceChange.h1 = 60;
    cur.priceChange.m5 = 25;
    cur.volume.h1 = 15_000;
    cur.volume.h24 = 16_000;
    await engine.refreshTier("dormant", 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/急変|静穏から復活/);
  });

  it("off なら評価もしない", async () => {
    const { dex, sent, engine, store } = setup({ NEW_LAUNCH_MODE: "off" });
    dex.searchResults = [makePair({ ageHours: 1, volH1: 60_000 })];
    await engine.discover();
    expect(sent).toHaveLength(0);
    expect(store.listAlertsWithOutcomes(NOW - H, NOW + H)).toHaveLength(0);
  });

  it("NEW_LAUNCH_ENABLED=false は off と同じ（後方互換）", () => {
    expect(makeConfig({ NEW_LAUNCH_ENABLED: "false", NEW_LAUNCH_MODE: "on" }).newLaunchMode).toBe("off");
    expect(makeConfig({ NEW_LAUNCH_MODE: "" }).newLaunchMode).toBe("shadow");
    expect(makeConfig({}).newLaunchMode).toBe("on"); // helpers が on を渡している
  });
});
