import { log } from "./logger.js";

/** Uniswap 系ファクトリのプール作成イベント（keccak256 のトピック） */
export const TOPICS = {
  /** UniswapV2Factory: PairCreated(address indexed token0, address indexed token1, address pair, uint256) */
  V2_PAIR_CREATED: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
  /** UniswapV3Factory: PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) */
  V3_POOL_CREATED: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
  /** UniswapV4 PoolManager: Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick) */
  V4_INITIALIZE: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
} as const;

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash?: string;
}

export interface NewPoolEvent {
  kind: "v2" | "v3" | "v4";
  /** V2/V3 はプールのコントラクトアドレス、V4 は PoolId (bytes32) */
  poolAddress: string;
  token0: string;
  token1: string;
  factory: string;
  blockNumber: number;
  txHash?: string;
}

function topicToAddress(topic: string | undefined): string | null {
  if (!topic || topic.length !== 66) return null;
  return ("0x" + topic.slice(26)).toLowerCase();
}

function dataWord(data: string, index: number): string | null {
  const start = 2 + index * 64;
  if (data.length < start + 64) return null;
  return data.slice(start, start + 64);
}

export function parseLog(raw: RawLog): NewPoolEvent | null {
  const sig = raw.topics[0]?.toLowerCase();
  const blockNumber = Number.parseInt(raw.blockNumber, 16);
  const base = { factory: raw.address.toLowerCase(), blockNumber, txHash: raw.transactionHash };
  if (sig === TOPICS.V2_PAIR_CREATED) {
    const token0 = topicToAddress(raw.topics[1]);
    const token1 = topicToAddress(raw.topics[2]);
    const w = dataWord(raw.data, 0);
    if (!token0 || !token1 || !w) return null;
    return { kind: "v2", poolAddress: ("0x" + w.slice(24)).toLowerCase(), token0, token1, ...base };
  }
  if (sig === TOPICS.V3_POOL_CREATED) {
    const token0 = topicToAddress(raw.topics[1]);
    const token1 = topicToAddress(raw.topics[2]);
    const w = dataWord(raw.data, 1);
    if (!token0 || !token1 || !w) return null;
    return { kind: "v3", poolAddress: ("0x" + w.slice(24)).toLowerCase(), token0, token1, ...base };
  }
  if (sig === TOPICS.V4_INITIALIZE) {
    const id = raw.topics[1];
    const token0 = topicToAddress(raw.topics[2]);
    const token1 = topicToAddress(raw.topics[3]);
    if (!id || !token0 || !token1) return null;
    return { kind: "v4", poolAddress: id.toLowerCase(), token0, token1, ...base };
  }
  return null;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcClient {
  private id = 1;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from RPC`, res.status);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new RpcError(body.error.message, body.error.code);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async blockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return Number.parseInt(hex, 16);
  }

  async getLogs(fromBlock: number, toBlock: number, topics: (string | string[] | null)[], addresses?: string[]): Promise<RawLog[]> {
    const filter: Record<string, unknown> = {
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics,
    };
    if (addresses && addresses.length > 0) filter.address = addresses;
    return this.call<RawLog[]>("eth_getLogs", [filter]);
  }
}

export interface ScannerState {
  getLastBlock(): number | null;
  setLastBlock(n: number): void;
}

export interface PoolScannerOptions {
  blockChunk: number;
  backfillBlocks: number;
  factoryAddresses: string[];
  /** 1 tick で処理する最大チャンク数（RPC 負荷の上限） */
  maxChunksPerTick?: number;
}

/**
 * ブロック範囲を少しずつ進めながら PairCreated / PoolCreated / Initialize を拾う。
 * 進捗はストアに保存され、再起動しても続きから読める。
 */
export class PoolScanner {
  private chunk: number;
  constructor(
    private readonly rpc: RpcClient,
    private readonly state: ScannerState,
    private readonly opts: PoolScannerOptions,
  ) {
    this.chunk = Math.max(10, opts.blockChunk);
  }

  async tick(): Promise<NewPoolEvent[]> {
    const latest = await this.rpc.blockNumber();
    let last = this.state.getLastBlock();
    if (last === null) {
      last = Math.max(0, latest - this.opts.backfillBlocks);
      log.info(`RPC スキャン開始: block ${last + 1} から (latest=${latest})`);
    }
    const events: NewPoolEvent[] = [];
    const maxChunks = this.opts.maxChunksPerTick ?? 10;
    let from = last + 1;
    for (let i = 0; i < maxChunks && from <= latest; i++) {
      const to = Math.min(latest, from + this.chunk - 1);
      let logs: RawLog[];
      try {
        logs = await this.rpc.getLogs(
          from,
          to,
          [[TOPICS.V2_PAIR_CREATED, TOPICS.V3_POOL_CREATED, TOPICS.V4_INITIALIZE]],
          this.opts.factoryAddresses.length > 0 ? this.opts.factoryAddresses : undefined,
        );
      } catch (err) {
        if (err instanceof RpcError && looksLikeRangeError(err) && this.chunk > 50) {
          this.chunk = Math.floor(this.chunk / 2);
          log.warn(`eth_getLogs の範囲が大きすぎるため chunk を ${this.chunk} に縮小: ${err.message}`);
          continue;
        }
        throw err;
      }
      for (const raw of logs) {
        const ev = parseLog(raw);
        if (ev) events.push(ev);
      }
      this.state.setLastBlock(to);
      from = to + 1;
      // 成功が続いたら元のサイズへ徐々に戻す
      if (this.chunk < this.opts.blockChunk) this.chunk = Math.min(this.opts.blockChunk, this.chunk * 2);
    }
    if (from <= latest) log.debug(`RPC スキャン遅延: ${latest - from + 1} ブロック未処理`);
    return events;
  }
}

function looksLikeRangeError(err: RpcError): boolean {
  const m = err.message.toLowerCase();
  return (
    m.includes("range") ||
    m.includes("too many") ||
    m.includes("limit") ||
    m.includes("exceed") ||
    m.includes("timeout") ||
    err.code === -32005 ||
    err.code === -32000
  );
}
