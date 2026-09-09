import type { Config } from "./config.js";
import { HOUR_MS } from "./detectors/common.js";
import { log } from "./logger.js";
import { RpcClient, RpcError, type RawLog } from "./rpc.js";
import type { AlertRow, PairRow, Store, WalletBuyRow } from "./store.js";

/**
 * 勝ちと確定した復活銘柄について、急騰の前（底・レンジの期間）に買っていたウォレットを集める。
 *
 * 狙いは「先に入っている人」を機械的に見つけること。同じことを何度もやっているウォレットは
 * 偶然ではなく情報か腕がある。その台帳を育て、将来はシグナルの参考にする。
 *
 * データは DexScreener には無いので RPC でプールの Swap イベントを直接読む。
 * トレーダーの特定は tx.from で統一する。イベント中の sender/recipient はルーターや
 * PoolManager であることが多く（特に Uniswap v4）、そのままでは人を指さないため。
 */

/** Uniswap 系 Swap イベントのトピック（keccak256 で検証済み） */
export const SWAP_TOPICS = {
  /** UniswapV2Pair: Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to) */
  V2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  /** UniswapV3Pool: Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick) */
  V3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  /** UniswapV4 PoolManager: Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee) */
  V4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ParsedSwap {
  txHash: string;
  blockNumber: number;
  /** base トークンを買った取引か */
  buyBase: boolean;
  /** 支払った quote の生の量（decimals 未適用） */
  quoteIn: bigint;
}

function word(data: string, i: number): string | null {
  const start = 2 + i * 64;
  return data.length >= start + 64 ? data.slice(start, start + 64) : null;
}

function uint(w: string): bigint {
  return BigInt("0x" + w);
}

/** 32 バイト語を符号付きとして読む（int256 / 符号拡張された int128 の両方に使える） */
function int(w: string): bigint {
  let v = BigInt("0x" + w);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v;
}

/**
 * Uniswap はトークンアドレスの小さい方を token0 にする（v4 のネイティブ ETH は 0x0 で最小）。
 * 同じ長さの小文字 16 進なので文字列比較で順序が決まる。
 */
export function baseIsToken0(baseAddress: string, quoteAddress: string): boolean {
  return baseAddress.toLowerCase() < quoteAddress.toLowerCase();
}

export function parseSwap(raw: RawLog, base0: boolean): ParsedSwap | null {
  const sig = raw.topics[0]?.toLowerCase();
  const txHash = (raw.transactionHash ?? "").toLowerCase();
  const blockNumber = Number.parseInt(raw.blockNumber, 16);
  if (!txHash) return null;

  if (sig === SWAP_TOPICS.V2) {
    const w0 = word(raw.data, 0), w1 = word(raw.data, 1), w2 = word(raw.data, 2), w3 = word(raw.data, 3);
    if (!w0 || !w1 || !w2 || !w3) return null;
    const a0In = uint(w0), a1In = uint(w1), a0Out = uint(w2), a1Out = uint(w3);
    const buyBase = base0 ? a0Out > 0n : a1Out > 0n;
    const quoteIn = base0 ? a1In : a0In;
    return { txHash, blockNumber, buyBase, quoteIn };
  }

  if (sig === SWAP_TOPICS.V3 || sig === SWAP_TOPICS.V4) {
    // v3/v4 の amount0/amount1 はプール残高の増減。負ならプールから出た＝利用者が受け取った
    const w0 = word(raw.data, 0), w1 = word(raw.data, 1);
    if (!w0 || !w1) return null;
    const a0 = int(w0), a1 = int(w1);
    const baseDelta = base0 ? a0 : a1;
    const quoteDelta = base0 ? a1 : a0;
    const buyBase = baseDelta < 0n;
    const quoteIn = quoteDelta > 0n ? quoteDelta : 0n;
    return { txHash, blockNumber, buyBase, quoteIn };
  }
  return null;
}

export interface HarvestResult {
  status: "ok" | "too_many" | "no_swaps" | "error";
  swaps: number;
  buyers: number;
  note?: string;
}

export class SwapHarvester {
  constructor(
    private readonly rpc: RpcClient,
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  /**
   * UNIX ミリ秒 → その時刻以前で最後のブロック番号。
   * 推定ブロック時間で当たりをつけ、範囲を確かめてから二分探索する。RPC 呼び出しは 30 回程度。
   */
  async findBlockByTimestamp(tsMs: number, cache = new Map<number, number>()): Promise<number> {
    const latest = await this.rpc.getBlockByNumber("latest");
    if (!latest) throw new RpcError("latest block unavailable");
    const tsOf = async (n: number): Promise<number> => {
      const c = cache.get(n);
      if (c !== undefined) return c;
      const b = await this.rpc.getBlockByNumber(n);
      const t = (b?.timestamp ?? 0) * 1000;
      cache.set(n, t);
      return t;
    };
    const tL = latest.timestamp * 1000;
    cache.set(latest.number, tL);
    if (tsMs >= tL) return latest.number;

    const bt = Math.max(50, this.cfg.rpcBlockTimeMs);
    const guess = Math.max(0, latest.number - Math.ceil((tL - tsMs) / bt));
    let margin = Math.max(2000, Math.ceil((latest.number - guess) * 0.25));
    let lo = Math.max(0, guess - margin);
    let hi = Math.min(latest.number, guess + margin);
    for (let i = 0; i < 8; i++) {
      if ((await tsOf(lo)) > tsMs && lo > 0) {
        lo = Math.max(0, lo - margin);
        margin *= 2;
        continue;
      }
      if ((await tsOf(hi)) < tsMs && hi < latest.number) {
        hi = Math.min(latest.number, hi + margin);
        margin *= 2;
        continue;
      }
      break;
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await tsOf(mid)) <= tsMs) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** ERC-20 decimals()。kv にキャッシュする。ネイティブ ETH は 18 */
  async quoteDecimals(address: string): Promise<number> {
    const addr = address.toLowerCase();
    if (addr === ZERO_ADDRESS || addr === "") return 18;
    const cached = this.store.getKv(`decimals:${addr}`);
    if (cached !== null) return Number(cached);
    try {
      const hex = await this.rpc.ethCall(addr, "0x313ce567");
      const d = Number.parseInt(hex, 16);
      const dec = Number.isFinite(d) && d >= 0 && d <= 36 ? d : 18;
      this.store.setKv(`decimals:${addr}`, String(dec));
      return dec;
    } catch {
      return 18;
    }
  }

  /**
   * 通知の前 N 時間に、そのプールで base を買ったウォレットを集めて記録する。
   * @param windowHours 既定は設定値。フェニックスは静穏期に仕込まれるので、手動では広めに取れる
   */
  async harvest(alert: AlertRow, pair: PairRow, windowHours = this.cfg.smartHarvestWindowHours): Promise<HarvestResult> {
    const toTs = alert.ts;
    const fromTs = toTs - windowHours * HOUR_MS;
    const cache = new Map<number, number>();
    const fromBlock = await this.findBlockByTimestamp(fromTs, cache);
    const toBlock = await this.findBlockByTimestamp(toTs, cache);
    if (toBlock <= fromBlock) return { status: "no_swaps", swaps: 0, buyers: 0, note: "empty block range" };

    const isV4 = pair.pair_address.length === 66;
    const topics: (string | string[])[] = isV4 ? [SWAP_TOPICS.V4, pair.pair_address] : [[SWAP_TOPICS.V2, SWAP_TOPICS.V3]];
    const addresses = isV4 ? undefined : [pair.pair_address];

    // ブロック範囲を刻んで取得。範囲エラーが出たら半分にして続ける
    const logs: RawLog[] = [];
    let chunk = Math.max(100, this.cfg.rpcBlockChunk);
    let from = fromBlock;
    while (from <= toBlock) {
      const to = Math.min(toBlock, from + chunk - 1);
      try {
        const part = await this.rpc.getLogs(from, to, topics, addresses);
        logs.push(...part);
        if (logs.length > this.cfg.smartMaxSwaps) {
          return { status: "too_many", swaps: logs.length, buyers: 0, note: `>${this.cfg.smartMaxSwaps} swaps` };
        }
        from = to + 1;
      } catch (err) {
        if (err instanceof RpcError && chunk > 100) {
          chunk = Math.floor(chunk / 2);
          continue;
        }
        throw err;
      }
    }
    if (logs.length === 0) return { status: "no_swaps", swaps: 0, buyers: 0 };

    const base0 = baseIsToken0(pair.base_address, pair.quote_address || ZERO_ADDRESS);
    const buys = logs.map((l) => parseSwap(l, base0)).filter((s): s is ParsedSwap => s !== null && s.buyBase);
    if (buys.length === 0) return { status: "no_swaps", swaps: logs.length, buyers: 0 };

    // tx.from を取る。バッチで 50 件ずつ
    const hashes = [...new Set(buys.map((b) => b.txHash))];
    const fromByHash = new Map<string, string>();
    for (let i = 0; i < hashes.length; i += 50) {
      const slice = hashes.slice(i, i + 50);
      const txs = await this.rpc.batch<{ from?: string } | null>(slice.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
      slice.forEach((h, idx) => {
        const f = txs[idx]?.from;
        if (f) fromByHash.set(h, f.toLowerCase());
      });
    }

    const decimals = await this.quoteDecimals(pair.quote_address || ZERO_ADDRESS);
    const scale = 10 ** decimals;
    const span = Math.max(1, toBlock - fromBlock);
    const rows: Omit<WalletBuyRow, "id">[] = [];
    for (const b of buys) {
      const wallet = fromByHash.get(b.txHash);
      if (!wallet) continue;
      rows.push({
        wallet,
        token_address: pair.base_address,
        pair_address: pair.pair_address,
        alert_id: alert.id,
        symbol: alert.symbol,
        // ブロック→時刻は範囲の両端から線形に補間する（数秒の誤差は用途上問題ない）
        ts: Math.round(fromTs + ((b.blockNumber - fromBlock) / span) * (toTs - fromTs)),
        block: b.blockNumber,
        quote_amount: Number(b.quoteIn) / scale,
        tx_hash: b.txHash,
      });
    }
    const added = this.store.recordWalletBuys(rows);
    const buyers = new Set(rows.map((r) => r.wallet)).size;
    log.info(`harvest $${alert.symbol}: swaps ${logs.length}, buys ${buys.length}, buyers ${buyers}, 新規記録 ${added}`);
    return { status: "ok", swaps: logs.length, buyers };
  }
}
