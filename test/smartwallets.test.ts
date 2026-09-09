import { describe, expect, it } from "vitest";
import { RpcClient, type RawLog } from "../src/rpc.js";
import { SWAP_TOPICS, SwapHarvester, ZERO_ADDRESS, baseIsToken0, parseSwap } from "../src/smartwallets.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import type { DexScreenerClient } from "../src/dexscreener.js";
import { H, NOW, makeConfig, makePair } from "./helpers.js";

const H = 3_600_000;
const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const u = (n: bigint) => pad(n.toString(16));
const i = (n: bigint) => pad((n < 0n ? (1n << 256n) + n : n).toString(16));
const addrTopic = (a: string) => "0x" + pad(a);

const BASE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const QUOTE = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // WETH (Robinhood)
const POOL = "0x1111111111111111111111111111111111111111";

describe("baseIsToken0", () => {
  it("アドレスの小さい方が token0", () => {
    expect(baseIsToken0("0x0a", "0x0b")).toBe(true);
    expect(baseIsToken0(BASE, QUOTE)).toBe(false); // 0xbb… > 0x0b…
    expect(baseIsToken0(BASE, ZERO_ADDRESS)).toBe(false); // ネイティブ ETH は最小
  });
});

describe("parseSwap", () => {
  it("V2: base が token1 のとき amount1Out > 0 が買い", () => {
    const raw: RawLog = {
      address: POOL,
      topics: [SWAP_TOPICS.V2, addrTopic("0xr0"), addrTopic("0xt0")],
      // amount0In = 1 ETH (quote), amount1In = 0, amount0Out = 0, amount1Out = 1000 base
      data: "0x" + u(10n ** 18n) + u(0n) + u(0n) + u(1000n),
      blockNumber: "0x64",
      transactionHash: "0xTX1",
    };
    const s = parseSwap(raw, false)!;
    expect(s.buyBase).toBe(true);
    expect(s.quoteIn).toBe(10n ** 18n);
    expect(s.blockNumber).toBe(100);
    expect(s.txHash).toBe("0xtx1");
  });

  it("V2: 売り（base が入って quote が出る）は買いではない", () => {
    const raw: RawLog = {
      address: POOL,
      topics: [SWAP_TOPICS.V2, addrTopic("0xr0"), addrTopic("0xt0")],
      data: "0x" + u(0n) + u(500n) + u(10n ** 17n) + u(0n),
      blockNumber: "0x65",
      transactionHash: "0xtx2",
    };
    expect(parseSwap(raw, false)!.buyBase).toBe(false);
  });

  it("V3: プール残高の増減で向きを読む（base の delta が負なら買い）", () => {
    const buy: RawLog = {
      address: POOL,
      topics: [SWAP_TOPICS.V3, addrTopic("0xr0"), addrTopic("0xu0")],
      // amount0 = +2 ETH (quote in), amount1 = -900 base (out)
      data: "0x" + i(2n * 10n ** 18n) + i(-900n) + u(0n) + u(0n) + u(0n),
      blockNumber: "0x70",
      transactionHash: "0xtx3",
    };
    const s = parseSwap(buy, false)!;
    expect(s.buyBase).toBe(true);
    expect(s.quoteIn).toBe(2n * 10n ** 18n);
    const sell = { ...buy, data: "0x" + i(-1n * 10n ** 18n) + i(400n) + u(0n) + u(0n) + u(0n), transactionHash: "0xtx4" };
    expect(parseSwap(sell, false)!.buyBase).toBe(false);
  });

  it("V4: 同じ符号規約。base が token0 の場合も正しく反転する", () => {
    const raw: RawLog = {
      address: "0xpoolmanager",
      topics: [SWAP_TOPICS.V4, "0x" + "ab".repeat(32), addrTopic("0xrouter")],
      // amount0 = -700 base (out), amount1 = +1 ETH (in)  ← base0 = true
      data: "0x" + i(-700n) + i(10n ** 18n) + u(0n) + u(0n) + u(0n) + u(0n),
      blockNumber: "0x80",
      transactionHash: "0xtx5",
    };
    const s = parseSwap(raw, true)!;
    expect(s.buyBase).toBe(true);
    expect(s.quoteIn).toBe(10n ** 18n);
  });

  it("未知のトピックや tx ハッシュ欠落は無視", () => {
    expect(parseSwap({ address: POOL, topics: ["0xdead"], data: "0x", blockNumber: "0x1", transactionHash: "0x1" }, true)).toBeNull();
    expect(parseSwap({ address: POOL, topics: [SWAP_TOPICS.V2], data: "0x" + u(1n).repeat(4), blockNumber: "0x1" }, true)).toBeNull();
  });
});

/**
 * 偽の RPC。ブロック時刻は 250ms 刻み、指定範囲に Swap ログを返し、
 * バッチの eth_getTransactionByHash に from を返す。
 */
function fakeRpc(opts: { latest: number; latestTs: number; logs: RawLog[]; fromByHash: Record<string, string>; rejectBatch?: boolean; maxRange?: number }) {
  const calls: string[] = [];
  const blockTs = (n: number) => opts.latestTs - (opts.latest - n) * 0.25; // 秒
  const handle = (body: { id: number; method: string; params: unknown[] }) => {
    calls.push(body.method);
    switch (body.method) {
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        const n = tag === "latest" ? opts.latest : Number.parseInt(tag, 16);
        return { jsonrpc: "2.0", id: body.id, result: { number: "0x" + n.toString(16), timestamp: "0x" + Math.floor(blockTs(n)).toString(16) } };
      }
      case "eth_getLogs": {
        const f = body.params[0] as { fromBlock: string; toBlock: string; address?: string[]; topics: unknown[] };
        const from = Number.parseInt(f.fromBlock, 16), to = Number.parseInt(f.toBlock, 16);
        if (opts.maxRange && to - from + 1 > opts.maxRange) return { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "range too large" } };
        const res = opts.logs.filter((l) => {
          const b = Number.parseInt(l.blockNumber, 16);
          return b >= from && b <= to && (!f.address || f.address.map((a) => a.toLowerCase()).includes(l.address.toLowerCase()));
        });
        return { jsonrpc: "2.0", id: body.id, result: res };
      }
      case "eth_getTransactionByHash": {
        const h = (body.params[0] as string).toLowerCase();
        return { jsonrpc: "2.0", id: body.id, result: opts.fromByHash[h] ? { from: opts.fromByHash[h] } : null };
      }
      case "eth_call":
        return { jsonrpc: "2.0", id: body.id, result: "0x" + pad("12") }; // decimals = 18
      case "eth_blockNumber":
        return { jsonrpc: "2.0", id: body.id, result: "0x" + opts.latest.toString(16) };
      default:
        return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no method" } };
    }
  };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body)) {
      if (opts.rejectBatch) return new Response("batch not supported", { status: 400 });
      return new Response(JSON.stringify(body.map(handle)));
    }
    return new Response(JSON.stringify(handle(body)));
  }) as typeof fetch;
  return { rpc: new RpcClient("http://rpc", fetchImpl), calls };
}

function swapLog(block: number, tx: string, quoteIn: bigint, buy = true): RawLog {
  // base = BASE (token1), quote = WETH (token0)。V3 形式
  const a0 = buy ? quoteIn : -quoteIn; // quote delta
  const a1 = buy ? -1000n : 1000n; // base delta
  return {
    address: POOL,
    topics: [SWAP_TOPICS.V3, addrTopic("0xrouter"), addrTopic("0xrouter")],
    data: "0x" + i(a0) + i(a1) + u(0n) + u(0n) + u(0n),
    blockNumber: "0x" + block.toString(16),
    transactionHash: tx,
  };
}

describe("SwapHarvester", () => {
  const cfg = makeConfig({ SMART_HARVEST_WINDOW_HOURS: "1", RPC_BLOCK_CHUNK: "5000" });
  const latest = 1_000_000;
  const latestTs = Math.floor(NOW / 1000);

  function setup(logs: RawLog[], fromByHash: Record<string, string>, extra: Partial<Parameters<typeof fakeRpc>[0]> = {}) {
    const store = new Store(":memory:");
    const pair = makePair({ address: POOL, token: BASE, symbol: "PHX", price: 0.001 });
    pair.quoteToken.address = QUOTE;
    store.upsertPair(pair, "test", NOW - 3 * H);
    const alertTs = NOW - 2 * H; // 通知は 2 時間前。窓は [-3h, -2h]
    const id = store.insertAlert({
      kind: "revival", token_address: BASE, pair_address: POOL, ts: alertTs, level: 1, price_usd: 0.001, symbol: "PHX", summary: "",
      scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 3_000_000, trigger: "reignite", vol_h1: 100_000, buys_h1: 50, sells_h1: 30, age_hours: 50,
    });
    const { rpc, calls } = fakeRpc({ latest, latestTs, logs, fromByHash, ...extra });
    return { store, pair: store.getPair(POOL)!, alert: store.getAlert(id)!, harvester: new SwapHarvester(rpc, store, cfg), calls, alertTs };
  }

  /** 通知時刻から相対秒でブロック番号を作る（250ms/ブロック） */
  const blockAt = (secondsBeforeAlert: number) => latest - Math.round((2 * 3600 + secondsBeforeAlert) / 0.25);

  it("時刻からブロックを二分探索で求める", async () => {
    const { harvester } = setup([], {});
    const b = await harvester.findBlockByTimestamp(NOW - 2 * H);
    // 2h = 7200s = 28800 ブロック前。
    // ブロック時刻は秒単位なので、同じ秒に属する 4 ブロック（250ms 刻み）は区別できない。
    // 探索は「その秒の最後のブロック」に落ちるため、1 秒分のずれまでは正しい結果とみなす
    expect(Math.abs(b - (latest - 28_800))).toBeLessThanOrEqual(4);
  });

  it("窓の中の買いを tx.from 単位で集め、台帳に記録する", async () => {
    const logs = [
      swapLog(blockAt(1800), "0xaaa1", 5n * 10n ** 17n), // 30 分前  wallet A
      swapLog(blockAt(1200), "0xaaa2", 3n * 10n ** 17n), // 20 分前  wallet A
      swapLog(blockAt(900), "0xbbb1", 2n * 10n ** 18n), // 15 分前  wallet B
      swapLog(blockAt(600), "0xccc1", 1n * 10n ** 18n, false), // 売り → 除外
      swapLog(blockAt(-600), "0xddd1", 9n * 10n ** 18n), // 通知後 → 窓の外
    ];
    const { store, pair, alert, harvester } = setup(logs, { "0xaaa1": "0xA1", "0xaaa2": "0xA1", "0xbbb1": "0xB2", "0xccc1": "0xC3", "0xddd1": "0xD4" });
    const r = await harvester.harvest(alert, pair);
    expect(r.status).toBe("ok");
    expect(r.buyers).toBe(2);
    const a = store.getWallet("0xa1")!;
    expect(a.buys).toBe(2);
    expect(a.hits).toBe(1);
    expect(a.quote_volume).toBeCloseTo(0.8, 6);
    expect(store.getWallet("0xb2")!.quote_volume).toBeCloseTo(2, 6);
    expect(store.getWallet("0xc3")).toBeNull();
    expect(store.getWallet("0xd4")).toBeNull();
    expect(store.walletBuys("0xa1")).toHaveLength(2);
  });

  it("同じウォレットが別の勝ち銘柄でも入っていれば hits が増える", async () => {
    const first = setup([swapLog(blockAt(900), "0xaaa1", 10n ** 18n)], { "0xaaa1": "0xA1" });
    await first.harvester.harvest(first.alert, first.pair);
    // 別銘柄の通知を同じストアに足す
    const pair2 = makePair({ address: "0x2222222222222222222222222222222222222222", token: "0xcccccccccccccccccccccccccccccccccccccccc", symbol: "TWO", price: 0.01 });
    pair2.quoteToken.address = QUOTE;
    first.store.upsertPair(pair2, "test", NOW - 3 * H);
    const id2 = first.store.insertAlert({
      kind: "revival", token_address: pair2.baseToken.address, pair_address: pair2.pairAddress, ts: first.alertTs, level: 1, price_usd: 0.01, symbol: "TWO", summary: "",
      scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 5_000_000, trigger: "reignite", vol_h1: 100_000, buys_h1: 50, sells_h1: 30, age_hours: 50,
    });
    const log2 = { ...swapLog(blockAt(600), "0xeee1", 10n ** 18n), address: pair2.pairAddress };
    const { rpc } = fakeRpc({ latest, latestTs, logs: [log2], fromByHash: { "0xeee1": "0xA1" } });
    const h2 = new SwapHarvester(rpc, first.store, cfg);
    await h2.harvest(first.store.getAlert(id2)!, first.store.getPair(pair2.pairAddress)!);
    expect(first.store.getWallet("0xa1")!.hits).toBe(2);
    expect(first.store.topWallets(5, 2)).toHaveLength(1);
  });

  it("Swap が多すぎる（バンドル等）場合は記録せず too_many で終える", async () => {
    const many = Array.from({ length: 40 }, (_, k) => swapLog(blockAt(1000 + k), `0xf${k.toString(16).padStart(3, "0")}`, 10n ** 17n));
    const { store, pair, alert, harvester } = setup(many, {});
    const r = await new SwapHarvester((harvester as unknown as { rpc: RpcClient }).rpc, store, makeConfig({ SMART_HARVEST_WINDOW_HOURS: "1", SMART_MAX_SWAPS: "10" })).harvest(alert, pair);
    expect(r.status).toBe("too_many");
    expect(store.countWallets(1)).toBe(0);
  });

  it("RPC がバッチを拒んでも逐次に落として tx.from を取る", async () => {
    const { store, pair, alert, harvester } = setup([swapLog(blockAt(900), "0xaaa1", 10n ** 18n)], { "0xaaa1": "0xA1" }, { rejectBatch: true });
    const r = await harvester.harvest(alert, pair);
    expect(r.status).toBe("ok");
    expect(store.getWallet("0xa1")).not.toBeNull();
  });

  it("範囲エラーが出たらチャンクを半分にして続行する", async () => {
    const { store, pair, alert, harvester } = setup([swapLog(blockAt(900), "0xaaa1", 10n ** 18n)], { "0xaaa1": "0xA1" }, { maxRange: 2000 });
    const r = await harvester.harvest(alert, pair);
    expect(r.status).toBe("ok");
    expect(store.getWallet("0xa1")).not.toBeNull();
  });

  it("V4 は PoolId をトピックで絞り、アドレス指定なしで取る", async () => {
    const poolId = "0x" + "ab".repeat(32);
    const store = new Store(":memory:");
    const pair = makePair({ address: poolId, token: BASE, symbol: "V4T", price: 0.001 });
    pair.quoteToken.address = ZERO_ADDRESS; // ネイティブ ETH
    pair.labels = ["v4"];
    store.upsertPair(pair, "test", NOW - 3 * H);
    const id = store.insertAlert({
      kind: "revival", token_address: BASE, pair_address: poolId, ts: NOW - 2 * H, level: 1, price_usd: 0.001, symbol: "V4T", summary: "",
      scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 3_000_000, trigger: "reignite", vol_h1: 100_000, buys_h1: 50, sells_h1: 30, age_hours: 50,
    });
    // ETH(0x0) が currency0、BASE が currency1。買い = amount1 < 0
    const log: RawLog = {
      address: "0xpoolmanager",
      topics: [SWAP_TOPICS.V4, poolId, addrTopic("0xrouter")],
      data: "0x" + i(10n ** 18n) + i(-500n) + u(0n) + u(0n) + u(0n) + u(0n),
      blockNumber: "0x" + blockAt(900).toString(16),
      transactionHash: "0xv4tx",
    };
    const { rpc, calls } = fakeRpc({ latest, latestTs, logs: [log], fromByHash: { "0xv4tx": "0xE5" } });
    const r = await new SwapHarvester(rpc, store, cfg).harvest(store.getAlert(id)!, store.getPair(poolId)!);
    expect(r.status).toBe("ok");
    expect(store.getWallet("0xe5")!.quote_volume).toBeCloseTo(1, 6);
    expect(calls).toContain("eth_getLogs");
    expect(calls).not.toContain("eth_call"); // ネイティブ ETH は decimals を問い合わせない
  });
});

describe("Engine.harvestToken — /harvest で任意の銘柄の先回りを集める", () => {
  const latest = 1_000_000;
  const latestTs = Math.floor(NOW / 1000);
  const blockAt = (secondsBeforeAlert: number) => latest - Math.round((2 * 3600 + secondsBeforeAlert) / 0.25);

  function build(logs: RawLog[], fromByHash: Record<string, string>, withRpc = true) {
    const cfg = makeConfig({ SMART_HARVEST_WINDOW_HOURS: "1", RPC_BLOCK_CHUNK: "5000", DISCOVERY_SEARCH_QUERIES: "x", DISCOVERY_USE_PROFILES: "false" });
    const store = new Store(":memory:");
    const pair = makePair({ address: POOL, token: BASE, symbol: "PARLEY", price: 0.0000533 });
    pair.quoteToken.address = QUOTE;
    store.upsertPair(pair, "test", NOW - 30 * H);
    const alertTs = NOW - 2 * H;
    const id = store.insertAlert({
      kind: "revival", token_address: BASE, pair_address: POOL, ts: alertTs, level: 1, price_usd: 0.0000533, symbol: "PARLEY", summary: "",
      scam_score: 0, scam_reasons: "", suppressed: 0, mc_usd: 50_000, trigger: "fast", vol_h1: 10_700, buys_h1: 24, sells_h1: 14, age_hours: 26,
    });
    const { rpc } = fakeRpc({ latest, latestTs, logs, fromByHash });
    const engine = new Engine(cfg, store, {} as unknown as DexScreenerClient, { broadcast: async () => {} }, withRpc ? rpc : null, () => NOW);
    return { store, engine, alertId: id, alertTs, cfg };
  }

  it("通知の前に買っていたウォレットを早い順に返し、🏷 の印を付ける", async () => {
    const logs = [
      swapLog(blockAt(3000), "0x0001", 2n * 10n ** 18n), // 50 分前 wallet A ← 最も早い
      swapLog(blockAt(1200), "0x0002", 5n * 10n ** 17n), // 20 分前 wallet B
      swapLog(blockAt(900), "0x0003", 1n * 10n ** 18n), // 15 分前 wallet A（2 回目）
    ];
    const { store, engine, alertId } = build(logs, { "0x0001": "0xA1", "0x0002": "0xB2", "0x0003": "0xA1" });
    const r = await engine.harvestToken(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.status).toBe("ok");
    expect(r.buyers.map((b) => b.wallet)).toEqual(["0xa1", "0xb2"]);
    expect(r.buyers[0]!.buys).toBe(2);
    expect(r.tagged).toBe(2);
    expect(store.getWallet("0xa1")!.tag).toBe("PARLEY");
    expect(store.getHarvest(alertId)!.note).toContain("manual");
  });

  it("窓を広げると、静穏期に仕込んだウォレットまで届く", async () => {
    const logs = [
      swapLog(blockAt(5 * 3600), "0x0011", 10n ** 18n), // 5 時間前 ← 1h 窓には入らない
      swapLog(blockAt(600), "0x0012", 10n ** 18n), // 10 分前
    ];
    const { engine } = build(logs, { "0x0011": "0xEE", "0x0012": "0xFF" });
    const narrow = await engine.harvestToken(BASE, 1);
    expect(narrow.ok && narrow.buyers.map((b) => b.wallet)).toEqual(["0xff"]);
    const wide = await engine.harvestToken(BASE, 6);
    expect(wide.ok && wide.buyers.map((b) => b.wallet)).toEqual(["0xee", "0xff"]);
  });

  it("印は既存の hits を壊さず、別銘柄で当たれば ⭐ に昇格できる", async () => {
    const { store, engine } = build([swapLog(blockAt(900), "0x0021", 10n ** 18n)], { "0x0021": "0xA1" });
    await engine.harvestToken(BASE);
    expect(store.getWallet("0xa1")!.hits).toBe(1);
    expect(store.getWallet("0xa1")!.tag).toBe("PARLEY");
    // 同じウォレットが別銘柄でも早期に入っていた記録を足す
    store.recordWalletBuys([{ wallet: "0xa1", token_address: "0xother", pair_address: "0xotherpool", alert_id: 999, symbol: "OTHER", ts: NOW - H, block: 1, quote_amount: 1, tx_hash: "0xzz" }]);
    const w = store.getWallet("0xa1")!;
    expect(w.hits).toBe(2);
    expect(w.tag).toBe("PARLEY"); // refreshWallet が tag を消していない
  });

  it("RPC 未設定なら理由を返す", async () => {
    const { engine } = build([], {}, false);
    const r = await engine.harvestToken(BASE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("RPC_URL");
  });

  it("通知の記録が無い銘柄は「急騰前」を決められないと返す", async () => {
    const { store, engine } = build([], {});
    const other = makePair({ address: "0x3333333333333333333333333333333333333333", token: "0xdddddddddddddddddddddddddddddddddddddddd", symbol: "NOALERT" });
    store.upsertPair(other, "test", NOW - H);
    const r = await engine.harvestToken(other.baseToken.address);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("通知の記録が無く");
  });
});
