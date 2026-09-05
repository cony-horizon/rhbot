import { describe, expect, it } from "vitest";
import { PoolScanner, RpcClient, TOPICS, parseLog, type RawLog } from "../src/rpc.js";

const pad = (addr: string) => "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const T0 = "0x1111111111111111111111111111111111111111";
const T1 = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";

describe("parseLog", () => {
  it("V2 PairCreated", () => {
    const raw: RawLog = {
      address: "0xFactory00000000000000000000000000000001",
      topics: [TOPICS.V2_PAIR_CREATED, pad(T0), pad(T1)],
      data: pad(POOL) + "1".padStart(64, "0"),
      blockNumber: "0x10",
    };
    const ev = parseLog(raw);
    expect(ev).toEqual({ kind: "v2", poolAddress: POOL, token0: T0, token1: T1, factory: raw.address.toLowerCase(), blockNumber: 16, txHash: undefined });
  });

  it("V3 PoolCreated", () => {
    const raw: RawLog = {
      address: "0xfactory",
      topics: [TOPICS.V3_POOL_CREATED, pad(T0), pad(T1), "0x" + "bb8".padStart(64, "0")],
      data: "0x" + "3c".padStart(64, "0") + pad(POOL).slice(2),
      blockNumber: "0xff",
      transactionHash: "0xtx",
    };
    const ev = parseLog(raw);
    expect(ev?.kind).toBe("v3");
    expect(ev?.poolAddress).toBe(POOL);
    expect(ev?.token0).toBe(T0);
    expect(ev?.blockNumber).toBe(255);
    expect(ev?.txHash).toBe("0xtx");
  });

  it("V4 Initialize は PoolId を返す", () => {
    const id = "0x" + "ab".repeat(32);
    const raw: RawLog = { address: "0xpm", topics: [TOPICS.V4_INITIALIZE, id, pad(T0), pad(T1)], data: "0x", blockNumber: "0x1" };
    const ev = parseLog(raw);
    expect(ev?.kind).toBe("v4");
    expect(ev?.poolAddress).toBe(id);
    expect(ev?.token1).toBe(T1);
  });

  it("未知のトピックは無視", () => {
    expect(parseLog({ address: "0x", topics: ["0xdeadbeef"], data: "0x", blockNumber: "0x1" })).toBeNull();
  });
});

describe("PoolScanner", () => {
  function fakeRpc(latest: number, logsByRange: (from: number, to: number) => RawLog[], failOnRangeOver?: number) {
    const calls: { from: number; to: number }[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: { fromBlock: string; toBlock: string }[] };
      let result: unknown;
      if (body.method === "eth_blockNumber") result = "0x" + latest.toString(16);
      else if (body.method === "eth_getLogs") {
        const from = Number.parseInt(body.params[0]!.fromBlock, 16);
        const to = Number.parseInt(body.params[0]!.toBlock, 16);
        calls.push({ from, to });
        if (failOnRangeOver !== undefined && to - from + 1 > failOnRangeOver) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "block range too large" } }));
        }
        result = logsByRange(from, to);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }) as typeof fetch;
    return { rpc: new RpcClient("http://rpc", fetchImpl), calls };
  }

  it("進捗を保存しながらチャンク単位で読み進める", async () => {
    const { rpc, calls } = fakeRpc(1000, (from) =>
      from === 901
        ? [{ address: "0xf", topics: [TOPICS.V2_PAIR_CREATED, pad(T0), pad(T1)], data: pad(POOL) + "0".repeat(64), blockNumber: "0x385" }]
        : [],
    );
    let last: number | null = null;
    const scanner = new PoolScanner(rpc, { getLastBlock: () => last, setLastBlock: (n) => (last = n) }, { blockChunk: 50, backfillBlocks: 100, factoryAddresses: [] });
    const events = await scanner.tick();
    expect(events).toHaveLength(1);
    expect(events[0]?.poolAddress).toBe(POOL);
    expect(calls[0]).toEqual({ from: 901, to: 950 });
    expect(calls[1]).toEqual({ from: 951, to: 1000 });
    expect(last).toBe(1000);
    // 2 回目は新ブロックが無いので何もしない
    calls.length = 0;
    await scanner.tick();
    expect(calls).toHaveLength(0);
  });

  it("範囲エラーが出たら chunk を半分にして再試行", async () => {
    const { rpc, calls } = fakeRpc(400, () => [], 100);
    let last: number | null = 0;
    const scanner = new PoolScanner(rpc, { getLastBlock: () => last, setLastBlock: (n) => (last = n) }, { blockChunk: 400, backfillBlocks: 0, factoryAddresses: [], maxChunksPerTick: 20 });
    await scanner.tick();
    expect(last).toBe(400);
    const ok = calls.filter((c) => c.to - c.from + 1 <= 100);
    expect(ok.length).toBeGreaterThan(0);
  });
});
