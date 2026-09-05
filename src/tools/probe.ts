/**
 * 接続確認ツール。ボット本体を起動せずに DexScreener / RPC / Telegram の疎通を確かめる。
 *
 *   npm run probe            … DexScreener 検索 + トークンプール + RPC 最新ブロック
 *   npm run probe -- telegram … TELEGRAM_CHAT_ID へテストメッセージ送信
 *   npm run probe -- pair 0x… … 指定ペア/トークンの現在値を表示
 */
import { ConfigError, loadConfig } from "../config.js";
import { DexScreenerClient, liquidityUsd, pairAgeMs, vol, type DexPair } from "../dexscreener.js";
import { fmtAge, fmtUsd } from "../format.js";
import { RpcClient } from "../rpc.js";
import { TelegramClient } from "../telegram.js";

function line(p: DexPair, now: number): string {
  return `${p.chainId.padEnd(10)} ${p.dexId.padEnd(10)} $${p.baseToken.symbol.padEnd(10)} age=${fmtAge(pairAgeMs(p, now)).padEnd(10)} 1h=${fmtUsd(
    vol(p, "h1"),
  ).padEnd(9)} 24h=${fmtUsd(vol(p, "h24")).padEnd(9)} liq=${fmtUsd(liquidityUsd(p)).padEnd(9)} ${p.pairAddress}`;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "all";
  const cfg = loadConfig(mode === "telegram");
  const now = Date.now();
  const dex = new DexScreenerClient();

  if (mode === "telegram") {
    const tg = new TelegramClient(cfg.telegramBotToken);
    const me = await tg.getMe();
    console.log(`bot: @${me.username}`);
    for (const id of cfg.telegramChatIds) {
      await tg.sendMessage(id, "✅ テストメッセージ: スパイク検知ボットから送信できています");
      console.log(`sent to ${id}`);
    }
    return;
  }

  if (mode === "pair") {
    const addr = process.argv[3];
    if (!addr) throw new Error("アドレスを指定してください");
    let pairs = await dex.getPairs(cfg.chainId, [addr]);
    if (pairs.length === 0) pairs = await dex.getTokenPools(cfg.chainId, addr);
    for (const p of pairs) console.log(line(p, now));
    console.log(JSON.stringify(pairs[0] ?? null, null, 2));
    return;
  }

  console.log(`== DexScreener search (chainId=${cfg.chainId}) ==`);
  const chainCounts = new Map<string, number>();
  let matched = 0;
  for (const q of cfg.discoverySearchQueries) {
    try {
      const all = await dex.search(q);
      for (const p of all) chainCounts.set(p.chainId, (chainCounts.get(p.chainId) ?? 0) + 1);
      const mine = all.filter((p) => p.chainId === cfg.chainId);
      matched += mine.length;
      console.log(`q="${q}": ${all.length} 件中 ${mine.length} 件が ${cfg.chainId}`);
      for (const p of mine.slice(0, 5)) console.log("  " + line(p, now));
    } catch (err) {
      console.log(`q="${q}": ERROR ${(err as Error).message}`);
    }
  }

  // CHAIN_ID の綴り違い・DexScreener 側の改名は初心者が自力で気づけないので、
  // 実際に返ってきた chainId を並べて次の一手を示す。
  if (matched === 0 && chainCounts.size > 0) {
    const ranked = [...chainCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log("");
    console.log(`!! chainId="${cfg.chainId}" のペアが 1 件も返りませんでした。`);
    console.log("!! 実際に返ってきた chainId は次のとおりです:");
    for (const [id, n] of ranked.slice(0, 12)) console.log(`     ${id}  (${n} 件)`);
    console.log(`!! 目的のチェーンがこの中にあれば、.env の CHAIN_ID をその文字列に変えてください。`);
    console.log("");
  }
  console.log("== token-pairs ==");
  for (const t of cfg.discoveryTokenAddresses) {
    try {
      const pools = await dex.getTokenPools(cfg.chainId, t);
      console.log(`${t}: ${pools.length} pools`);
      for (const p of pools.slice(0, 10)) console.log("  " + line(p, now));
    } catch (err) {
      console.log(`${t}: ERROR ${(err as Error).message}`);
    }
  }
  console.log("== token-profiles / boosts ==");
  try {
    const profiles = await dex.latestTokenProfiles();
    const boosts = await dex.latestBoosts();
    const mine = [...profiles, ...boosts].filter((p) => p.chainId === cfg.chainId);
    console.log(`profiles ${profiles.length} / boosts ${boosts.length} → ${cfg.chainId}: ${mine.length}`);
    for (const p of mine.slice(0, 10)) console.log("  " + p.tokenAddress + " " + (p.description ?? "").slice(0, 60));
  } catch (err) {
    console.log(`ERROR ${(err as Error).message}`);
  }
  if (cfg.rpcUrl) {
    console.log(`== RPC ${cfg.rpcUrl} ==`);
    try {
      const rpc = new RpcClient(cfg.rpcUrl);
      const chainIdHex = await rpc.call<string>("eth_chainId", []);
      const block = await rpc.blockNumber();
      console.log(`chainId=${Number.parseInt(chainIdHex, 16)} latestBlock=${block}`);
      const logs = await rpc.getLogs(block - 2000, block, [
        ["0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9", "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118", "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"],
      ]);
      console.log(`直近 2000 ブロックのプール作成イベント: ${logs.length} 件`);
      for (const l of logs.slice(0, 5)) console.log(`  factory=${l.address} topic=${l.topics[0]?.slice(0, 10)} block=${Number.parseInt(l.blockNumber, 16)}`);
    } catch (err) {
      console.log(`RPC ERROR ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n⚠️  ${err.message}\n`);
    for (const line of err.hint) console.error(line);
    console.error("");
  } else {
    console.error(err);
  }
  process.exit(1);
});
