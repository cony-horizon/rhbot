import type { DexPair } from "./dexscreener.js";
import type { Detection } from "./detectors/types.js";
import type { PairRow, AlertRow } from "./store.js";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1) return `$${n.toFixed(4)}`;
  // 小さい価格は有効数字 4 桁で
  const digits = Math.max(4, -Math.floor(Math.log10(n)) + 3);
  return `$${n.toFixed(Math.min(digits, 12))}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(n >= 100 || n <= -100 ? 0 : 1)}%`;
}

export function fmtAge(ms: number | null): string {
  if (ms === null || ms < 0) return "不明";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return `${h}時間${m}分`;
  const d = Math.floor(h / 24);
  return `${d}日${h % 24}時間`;
}

function dexLabel(p: DexPair): string {
  const labels = p.labels && p.labels.length > 0 ? ` (${p.labels.join(", ")})` : "";
  return `${p.dexId}${labels}`;
}

export function formatAlert(d: Detection, p: DexPair, ageMs: number | null): string {
  const m = d.metrics;
  const sym = escapeHtml(p.baseToken.symbol || "?");
  const name = escapeHtml(p.baseToken.name || "");
  const quote = escapeHtml(p.quoteToken?.symbol ?? "");
  const header =
    d.kind === "new_launch"
      ? `🚀 <b>新規ローンチ検知</b>  段階 ${d.level}/${d.levelCount}`
      : `🔥 <b>復活スパイク検知</b>${d.level > 1 ? `  (追加上昇 #${d.level})` : ""}`;

  const lines: string[] = [
    header,
    `<b>$${sym}</b> ${name ? `— ${name}` : ""}  <i>/${quote}</i>`,
    `DEX: ${escapeHtml(dexLabel(p))} | 経過: ${fmtAge(ageMs)}`,
    `価格: <b>${fmtPrice(m.priceUsd)}</b>  (5m ${fmtPct(m.priceChangeM5)} / 1h ${fmtPct(m.priceChangeH1)}${
      m.lookbackChangePct !== null ? ` / 安値比 ${fmtPct(m.lookbackChangePct)}` : ""
    })`,
    `出来高: 1h <b>${fmtUsd(m.volH1)}</b> | 24h ${fmtUsd(m.volH24)}${
      m.volSpikeRatio !== null ? ` | 突発率 ${Number.isFinite(m.volSpikeRatio) ? m.volSpikeRatio.toFixed(1) + "x" : "∞"}` : ""
    }`,
    `流動性: ${fmtUsd(m.liquidityUsd)} | FDV: ${fmtUsd(p.fdv)}${p.marketCap ? ` | MC: ${fmtUsd(p.marketCap)}` : ""}`,
    `取引 1h: 買 ${m.buysH1} / 売 ${m.sellsH1}`,
    `理由: ${escapeHtml(d.reason)}`,
    `📈 <a href="${escapeHtml(p.url)}">DexScreener で開く</a>`,
    `CA: <code>${escapeHtml(p.baseToken.address)}</code>`,
  ];
  return lines.join("\n");
}

export function formatPairRow(r: PairRow): string {
  return `• <b>$${escapeHtml(r.base_symbol)}</b>/${escapeHtml(r.quote_symbol)} [${r.tier}] 1h ${fmtUsd(r.last_vol_h1)} | liq ${fmtUsd(
    r.last_liquidity_usd,
  )} | ${fmtPrice(r.last_price_usd)}\n  <code>${escapeHtml(r.base_address)}</code>`;
}

export function formatAlertRow(a: AlertRow): string {
  const when = new Date(a.ts).toISOString().replace("T", " ").slice(5, 16);
  const icon = a.kind === "new_launch" ? "🚀" : "🔥";
  return `${icon} ${when} <b>$${escapeHtml(a.symbol)}</b> L${a.level} ${fmtPrice(a.price_usd)} — ${escapeHtml(a.summary)}`;
}
