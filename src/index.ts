import { ConfigError, loadConfig, type Config } from "./config.js";
import { DexScreenerClient } from "./dexscreener.js";
import { Engine } from "./engine.js";
import { escapeHtml, fmtPrice, fmtUsd, formatAlertRow, formatPairRow, formatRangeWatch, formatSuppressedRow, formatWalletBuyRow, formatWalletRow } from "./format.js";
import { formatRecentOutcomes } from "./outcomes.js";
import { log, setLogLevel } from "./logger.js";
import { RpcClient } from "./rpc.js";
import { every, type ScheduledTask } from "./scheduler.js";
import { Store } from "./store.js";
import { CommandLoop, TelegramClient, TelegramError, TelegramNetworkError } from "./telegram.js";

const COMMANDS = [
  { command: "status", description: "監視状況を表示" },
  { command: "top", description: "1h 出来高上位ペア" },
  { command: "ranges", description: "いまヨコヨコを組んでいる銘柄と、上抜けまでの距離" },
  { command: "alerts", description: "直近のアラート履歴" },
  { command: "test", description: "通知の見本を送って配信を確認" },
  { command: "filtered", description: "スキャム判定で止めた通知を見る" },
  { command: "report", description: "日次レポート（成績と改善案）を今すぐ出す" },
  { command: "outcomes", description: "直近の通知がその後どうなったか" },
  { command: "smart", description: "早期に入っていたウォレット台帳" },
  { command: "wallet", description: "ウォレットの買い履歴" },
  { command: "why", description: "指定アドレスのリスクを採点する" },
  { command: "watch", description: "アドレスを手動で監視に追加" },
  { command: "unwatch", description: "監視から外す" },
  { command: "list", description: "手動監視中のペア一覧" },
  { command: "mute", description: "通知を一時停止 (分)" },
  { command: "unmute", description: "通知を再開" },
  { command: "config", description: "検知しきい値を表示" },
  { command: "help", description: "ヘルプ" },
];

function helpText(): string {
  return [
    "<b>Robinhood Chain ミームコイン スパイク検知ボット</b>",
    "",
    "🚀 新規ローンチ: 作成から一定時間内に 1h 出来高が段階しきい値を超えたら通知",
    "🔥 復活スパイク: 20h 以上経過したペアで突発的な出来高と +30% 以上の価格上昇を検知",
    "",
    "🚫 バンドル・洗浄取引で出来高を作られた銘柄は自動で除外します（/filtered で確認）",
    "📊 毎朝、前日の通知の成績と改善案を送ります（/report でいつでも）",
    "👀 いま何を待っているかは /ranges — ヨコヨコ中の銘柄と、上抜けまであと何 % か",
    "⭐ 勝った復活銘柄の急騰前に買っていたウォレットを集めます（/smart）",
    "",
    "通知が来ないときは /status で監視ペア数を、/test で配信経路を確認してください。",
    "",
    ...COMMANDS.map((c) => `/${c.command} — ${c.description}`),
  ].join("\n");
}

function configText(cfg: Config): string {
  return [
    "<b>検知設定</b>",
    `chain: ${cfg.chainId} | 最低流動性: ${fmtUsd(cfg.minLiquidityUsd)}`,
    `<b>新規</b> ${cfg.newLaunchEnabled ? "ON" : "OFF"}: 〜${cfg.newMaxAgeHours}h, MC>=${fmtUsd(cfg.newMinMcUsd)}, 1h出来高段階 ${cfg.newVolH1TiersUsd
      .map((n) => fmtUsd(n))
      .join(" / ")}, 買>=${cfg.newMinBuysH1}`,
    `<b>新規(低MC・試験中)</b> ${cfg.newLowMcEnabled ? "ON" : "OFF"}: MC ${fmtUsd(cfg.newLowMcFloorUsd)}〜${fmtUsd(
      cfg.newMinMcUsd,
    )} かつ 1h出来高がMCの ${cfg.newLowMcVolToMcRatio} 倍以上 かつ 流動性 ${fmtUsd(cfg.newLowMcMinLiquidityUsd)} 以上 かつ 参加者の厚みあり`,
    `<b>復活</b> ${cfg.revivalEnabled ? "ON" : "OFF"}: ${cfg.revivalMinAgeHours}h〜, 価格 +${cfg.revivalPriceChangePct}% (1h or ${cfg.revivalLookbackMin}分安値比), 1h出来高>=${fmtUsd(
      cfg.revivalMinVolH1Usd,
    )}, 突発率>=${cfg.revivalVolSpikeRatio}x, 買>=${cfg.revivalMinBuysH1}, cooldown ${cfg.revivalCooldownMin}分, 追加上昇 +${cfg.revivalEscalationPct}%`,
    `<b>再点火</b> ${cfg.reigniteEnabled ? "ON" : "OFF"}: 全盛期 MC ${fmtUsd(cfg.reigniteMinPeakMcUsd)} 以上 → 全盛期の ${Math.round(cfg.reigniteCooledRatio * 100)}% 以下に冷え込み → レンジを +${cfg.reigniteBreakoutPct}% 上抜け`,
    `<b>レンジ上抜け</b>: レンジ上限を +${cfg.revivalBreakoutPct}% 上抜け（窓 ${cfg.revivalBaseWindowMin}分・直近 ${cfg.revivalRangeExcludeMin}分は除外）`,
    `<b>スキャム除外</b> ${cfg.scamFilterEnabled ? "ON" : "OFF"}: リスク ${cfg.scamScoreThreshold}/100 以上を通知しない`,
    `  出来高/流動性 ${cfg.scamChurnMid}x で加点・${cfg.scamChurnHigh}x で重く加点 | 流動性/時価総額 ${cfg.scamMinDepthPct}% 未満で加点`,
    `  流動性 ${fmtUsd(cfg.scamPumpLiquidityUsd)} 未満で +${cfg.scamPumpPct}% の急騰は加点 | 流動性 ${fmtUsd(cfg.scamMinLiquidityUsd)} 未満で加点`,
    `更新間隔: hot ${cfg.pollIntervalSec}s / dormant ${cfg.dormantPollIntervalSec}s / dead ${cfg.deadPollIntervalSec}s`,
    `RPC: ${cfg.rpcUrl ?? "無効"}`,
    "",
    "変更は .env を編集して再起動してください。",
  ].join("\n");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info(`起動: chain=${cfg.chainId} db=${cfg.dbPath}`);

  const store = new Store(cfg.dbPath);
  const dex = new DexScreenerClient();
  const tg = new TelegramClient(cfg.telegramBotToken);
  const rpc = cfg.rpcUrl ? new RpcClient(cfg.rpcUrl) : null;

  const sink = {
    async broadcast(html: string) {
      for (const chatId of cfg.telegramChatIds) await tg.sendMessage(chatId, html);
    },
  };
  const engine = new Engine(cfg, store, dex, sink, rpc);

  // 認証の確認。ここが通ればトークンは正しい。
  try {
    const me = await tg.getMe();
    log.info(`Telegram bot: @${me.username ?? me.id}`);
  } catch (err) {
    if (err instanceof TelegramNetworkError) {
      throw new ConfigError("Telegram に接続できませんでした（トークンの問題ではありません）", [
        `詳細: ${err.detail}`,
        "",
        "インターネット接続を確認してから、もう一度  npm start  を実行してください。",
        "",
        "・VPN を使っている場合は切って試してください",
        "・社内や学校のネットワークでは api.telegram.org が遮断されていることがあります",
        "・スマホのテザリングで試すと、ネットワーク側の問題か切り分けられます",
      ]);
    }
    if (err instanceof TelegramError && err.code === 401) {
      throw new ConfigError("Telegram にトークンを拒否されました", [
        ".env の TELEGRAM_BOT_TOKEN が正しくありません。",
        "Telegram の @BotFather に /mybots と送り、自分のボットを選んで",
        "「API Token」から正しい文字列をコピーし直してください。",
      ]);
    }
    throw err;
  }

  // コマンド一覧の登録は Telegram の入力補助のためだけのもの。
  // 失敗してもコマンド自体は手で打てば動くので、起動を止める理由にはならない。
  try {
    await tg.setMyCommands(COMMANDS);
  } catch (err) {
    log.warn(
      `コマンド一覧の登録に失敗しました（動作に支障はありません）: ${
        err instanceof TelegramNetworkError ? err.detail : err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const commands = new CommandLoop(
    tg,
    new Set(cfg.telegramChatIds),
    async (cmd, args) => {
      switch (cmd) {
        case "start":
        case "help":
          return helpText();
        case "config":
          return configText(cfg);
        case "status": {
          const tiers = store.countByTier();
          const s = engine.stats;
          return [
            "<b>監視状況</b>",
            `ペア: hot ${tiers.hot} / dormant ${tiers.dormant} / dead ${tiers.dead} (pending ${store.countPending()})`,
            `優先監視: ${store.countPriority(cfg.priorityPeakMcUsd)} 件（全盛期 MC ${fmtUsd(cfg.priorityPeakMcUsd)} 超）を ${cfg.priorityPollIntervalSec}s ごとに確認`,
            `日次レポート: 毎日 ${cfg.reportHourJst}:00 JST（最終送信 ${store.getKv("daily_report_date") ?? "-"}）`,
            `ウォレット台帳: ⭐ ${store.countWallets(cfg.smartMinHits)} 件 / 全 ${store.countWallets(1)} 件${cfg.rpcUrl ? "" : "（RPC 未設定のため収穫停止）"}`,
            `直近 24h アラート: ${store.countAlertsSince(Date.now() - 86_400_000)} 件 (送信累計 ${s.alertsSent})`,
            `直近 24h フィルタ: ${store.countSuppressedSince(Date.now() - 86_400_000)} 件をスキャム判定で抑制 (累計 ${s.alertsSuppressed})`,
            `最終 discovery: ${s.lastDiscoveryAt ? new Date(s.lastDiscoveryAt).toISOString() : "-"} (+${s.lastDiscoveryAdded})`,
            `RPC block: ${s.lastRpcBlock ?? "-"} / 検知イベント累計 ${s.rpcEventsTotal}`,
            `DexScreener リクエスト累計: ${dex.requestCount}`,
            engine.isMuted() ? `🔇 ミュート中 (残り ${engine.mutedRemainingMin()} 分)` : "🔔 通知 ON",
          ].join("\n");
        }
        case "top": {
          const n = Math.min(30, Number(args[0]) || 10);
          const rows = store.listTopByVolH1(n);
          if (rows.length === 0) return "まだ監視ペアがありません";
          return `<b>1h 出来高上位 ${rows.length}</b>\n` + rows.map(formatPairRow).join("\n");
        }
        case "alerts": {
          const n = Math.min(30, Number(args[0]) || 10);
          const rows = store.recentAlerts(n);
          if (rows.length === 0) return "アラート履歴はまだありません";
          return `<b>直近のアラート</b>\n` + rows.map(formatAlertRow).join("\n");
        }
        case "test":
          return await engine.sendSampleAlert();
        case "report":
          return engine.buildReport();
        case "outcomes": {
          const n = Math.min(30, Number(args[0]) || 12);
          return formatRecentOutcomes(store, Date.now(), n);
        }
        case "smart": {
          const n = Math.min(30, Number(args[0]) || 15);
          const rows = store.topWallets(n, 1);
          if (rows.length === 0) {
            return cfg.rpcUrl
              ? "まだ台帳が空です。復活系の通知が「的中」と確定すると、その急騰前に買っていたウォレットを自動で集めます。"
              : "スマートウォレットの収穫には RPC_URL が必要です（.env を確認してください）";
          }
          const smart = rows.filter((w) => w.hits >= cfg.smartMinHits);
          return (
            `<b>早期に入っていたウォレット</b>（${cfg.smartMinHits} 銘柄以上で ⭐）\n` +
            rows.map((w) => formatWalletRow(w, cfg.smartMinHits)).join("\n") +
            `\n\n⭐ ${smart.length} 件 / 全 ${store.countWallets(1)} 件。詳細は /wallet &lt;アドレス&gt;`
          );
        }
        case "wallet": {
          const addr = args[0];
          if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return "使い方: /wallet &lt;ウォレットアドレス&gt;";
          const w = store.getWallet(addr);
          if (!w) return "このウォレットの記録はありません";
          const buys = store.walletBuys(addr, 20);
          return `${formatWalletRow(w, cfg.smartMinHits)}\n\n<b>買い履歴</b>\n` + buys.map(formatWalletBuyRow).join("\n");
        }
        case "ranges": {
          const n = Math.min(30, Number(args[0]) || 15);
          const all = engine.rangeWatchlist();
          if (all.length === 0) {
            return (
              "いまヨコヨコと判定できる銘柄はありません。\n" +
              `帯として認めるには ${cfg.rangeMinHours} 時間以上・${cfg.rangeMinSamples} 点以上の観測が要ります。` +
              "起動直後は履歴が足りないので、しばらく回してから見てください。"
            );
          }
          const primed = all.filter((w) => w.primed);
          const rows = (primed.length > 0 ? primed : all).slice(0, n);
          const head =
            `<b>ヨコヨコ監視中 ${primed.length} 件</b>` +
            (all.length > primed.length ? `（帯を組んでいる銘柄は全 ${all.length} 件）` : "") +
            `\n上抜け条件: 帯の上限 +${cfg.reigniteBreakoutPct}%`;
          return (
            head +
            "\n\n" +
            rows.map(formatRangeWatch).join("\n\n") +
            "\n\n🔔 = 条件到達 / 🟠 あと 5% / 🟡 あと 15% / ⚪ それ以上"
          );
        }
        case "filtered": {
          const n = Math.min(20, Number(args[0]) || 10);
          const rows = store.recentSuppressed(n);
          if (rows.length === 0) return "スキャム判定で止めた通知はまだありません";
          return (
            `<b>止めた通知 ${rows.length} 件</b>（しきい値 ${cfg.scamScoreThreshold}/100）\n` +
            rows.map(formatSuppressedRow).join("\n") +
            `\n\n本来ほしかった銘柄が混ざっていたら、.env の SCAM_SCORE_THRESHOLD を上げてください。`
          );
        }
        case "why": {
          const addr = args[0];
          if (!addr || !/^0x[0-9a-fA-F]{40,64}$/.test(addr)) return "使い方: /why &lt;ペア or トークンアドレス&gt;";
          const res = await engine.explain(addr);
          if (!res) return `DexScreener に ${escapeHtml(addr)} のペアが見つかりませんでした (chain=${cfg.chainId})`;
          const { pair, scam } = res;
          const verdict =
            scam.score >= cfg.scamScoreThreshold
              ? `🚫 <b>通知しない</b>（しきい値 ${cfg.scamScoreThreshold} 以上）`
              : `✅ <b>通知する</b>（しきい値 ${cfg.scamScoreThreshold} 未満）`;
          const lines = [
            `<b>$${escapeHtml(pair.baseToken.symbol)}</b> のリスク評価`,
            `価格 ${fmtPrice(Number(pair.priceUsd))} | 流動性 ${fmtUsd(pair.liquidity?.usd)} | 1h 出来高 ${fmtUsd(pair.volume?.h1)}`,
            "",
            `リスク <b>${scam.score}/100</b>  ${verdict}`,
            `👥 厚み ${scam.breadth.points}/3 — 取引 ${scam.breadth.txns.toLocaleString("en-US")} 件 / 平均 ${fmtUsd(scam.breadth.avgTradeUsd)} / 買い ${Math.round(scam.breadth.buyShare * 100)}%`,
          ];
          if (scam.breadth.organic) {
            lines.push("厚みが確認できたため、出来高が流動性に対して過大でも減点していません。");
          }
          if (scam.signals.length === 0) lines.push("", "引っかかった点はありません。");
          else {
            lines.push("");
            for (const sig of scam.signals) lines.push(`・+${sig.points} ${escapeHtml(sig.label)}`);
          }
          return lines.join("\n");
        }
        case "watch": {
          const addr = args[0];
          if (!addr || !/^0x[0-9a-fA-F]{40,64}$/.test(addr)) return "使い方: /watch <ペア or トークンアドレス>";
          const pairs = await engine.watch(addr);
          if (pairs.length === 0) return `DexScreener に ${escapeHtml(addr)} のペアが見つかりませんでした (chain=${cfg.chainId})`;
          return `✅ ${pairs.length} ペアを監視に追加:\n` + pairs.map((p) => `• $${escapeHtml(p.baseToken.symbol)}/${escapeHtml(p.quoteToken.symbol)} (${p.dexId})`).join("\n");
        }
        case "unwatch": {
          const addr = args[0];
          if (!addr) return "使い方: /unwatch <ペア or トークンアドレス>";
          const n = engine.unwatch(addr);
          return n > 0 ? `🗑 ${n} ペアを監視から外しました` : "該当ペアがありません";
        }
        case "list": {
          const rows = store.listManual();
          if (rows.length === 0) return "手動監視中のペアはありません (/watch で追加)";
          return `<b>手動監視中 ${rows.length}</b>\n` + rows.map(formatPairRow).join("\n");
        }
        case "mute": {
          const min = Number(args[0]) || 60;
          engine.mute(min);
          return `🔇 ${min} 分間通知を停止します（検知は継続し履歴に残ります）`;
        }
        case "unmute":
          engine.unmute();
          return "🔔 通知を再開しました";
        default:
          return null;
      }
    },
    {
      get: () => {
        const v = store.getKv("tg_offset");
        return v === null ? null : Number(v);
      },
      set: (n) => store.setKv("tg_offset", String(n)),
    },
  );
  commands.start();

  const tasks: ScheduledTask[] = [
    every("discovery", cfg.discoveryIntervalSec * 1000, () => engine.discover().then(() => undefined)),
    every("refresh:hot", Math.max(10, Math.floor(cfg.pollIntervalSec / 3)) * 1000, () =>
      engine.refreshTier("hot", cfg.pollIntervalSec).then(() => undefined),
    ),
    every("refresh:priority", Math.max(10, Math.floor(cfg.priorityPollIntervalSec / 3)) * 1000, () =>
      engine.refreshPriority(cfg.priorityPollIntervalSec).then(() => undefined),
    ),
    every("refresh:dormant", 30_000, () => engine.refreshTier("dormant", cfg.dormantPollIntervalSec).then(() => undefined)),
    every("refresh:dead", 120_000, () => engine.refreshTier("dead", cfg.deadPollIntervalSec, 300).then(() => undefined)),
    every("pending", 60_000, () => engine.resolvePending().then(() => undefined)),
    every("maintain", 3_600_000, async () => engine.maintain(), { immediate: false }),
    // 反省の材料づくり: 通知のその後を埋め、決めた時刻に日次レポートを送る
    every("outcomes", 5 * 60_000, async () => void engine.runOutcomes(), { immediate: false }),
    every("daily-report", 60_000, () => engine.maybeSendDailyReport().then(() => undefined), { immediate: false }),
  ];
  if (rpc && cfg.smartWalletEnabled) {
    tasks.push(every("harvest", 10 * 60_000, () => engine.runHarvests().then(() => undefined), { immediate: false }));
  }
  if (rpc) tasks.push(every("rpc-scan", cfg.rpcScanIntervalSec * 1000, () => engine.scanRpc().then(() => undefined)));

  if (cfg.notifyOnStart) {
    try {
      await sink.broadcast(
        `🟢 スパイク検知ボット起動 (chain=${cfg.chainId}, 監視 ${store.countPairs()} ペア)\n/help でコマンド一覧`,
      );
    } catch (err) {
      log.error("起動通知の送信に失敗 (TELEGRAM_CHAT_ID を確認してください)", err);
    }
  }

  const shutdown = (sig: string) => {
    log.info(`${sig} 受信 — 停止します`);
    for (const t of tasks) t.stop();
    commands.stop();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n⚠️  ${err.message}\n`);
    for (const line of err.hint) console.error(line);
    console.error("");
  } else {
    log.error("致命的エラー", err);
  }
  process.exit(1);
});
