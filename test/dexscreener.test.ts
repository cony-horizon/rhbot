import { describe, expect, it } from "vitest";
import { DexScreenerClient, RateLimiter, chunked } from "../src/dexscreener.js";
import { makePair } from "./helpers.js";

function mockFetch(handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const noSleep = async () => {};

describe("DexScreenerClient", () => {
  it("getPairs は 30 件ごとに分割し、重複を除く", async () => {
    const { fetchImpl, urls } = mockFetch((url) => {
      const addrs = url.split("/").pop()!.split(",");
      return { body: { pairs: addrs.map((a) => makePair({ address: a })) } };
    });
    const c = new DexScreenerClient({ fetchImpl, sleep: noSleep });
    const addrs = Array.from({ length: 65 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
    const pairs = await c.getPairs("robinhood", [...addrs, addrs[0]!.toUpperCase()]);
    expect(urls).toHaveLength(3);
    expect(pairs).toHaveLength(65);
    expect(urls[0]).toContain("/latest/dex/pairs/robinhood/");
  });

  it("search は pairs が null でも空配列", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { pairs: null } }));
    const c = new DexScreenerClient({ fetchImpl, sleep: noSleep });
    expect(await c.search("x")).toEqual([]);
  });

  it("429 は retry-after を待って再試行", async () => {
    let n = 0;
    const { fetchImpl } = mockFetch(() => {
      n++;
      return n === 1 ? { status: 429, headers: { "retry-after": "1" } } : { body: [makePair()] };
    });
    const c = new DexScreenerClient({ fetchImpl, sleep: noSleep });
    const pools = await c.getTokenPools("robinhood", "0xabc");
    expect(pools).toHaveLength(1);
    expect(n).toBe(2);
  });

  it("404 等の 4xx は即座に失敗", async () => {
    const { fetchImpl, urls } = mockFetch(() => ({ status: 404, body: {} }));
    const c = new DexScreenerClient({ fetchImpl, sleep: noSleep });
    await expect(c.getTokenPools("robinhood", "0xabc")).rejects.toThrow(/404/);
    expect(urls).toHaveLength(1);
  });

  it("5xx は最大試行回数まで再試行してから失敗", async () => {
    const { fetchImpl, urls } = mockFetch(() => ({ status: 503, body: {} }));
    const c = new DexScreenerClient({ fetchImpl, sleep: noSleep, maxAttempts: 3 });
    await expect(c.search("x")).rejects.toThrow(/503/);
    expect(urls).toHaveLength(3);
  });
});

describe("RateLimiter", () => {
  it("上限を超えたら古いリクエストが期限切れになるまで待つ", async () => {
    let t = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(
      2,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(waits).toEqual([60_000]);
  });
});

describe("chunked", () => {
  it("分割", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 3)).toEqual([]);
  });
});
