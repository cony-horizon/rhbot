import type { DexPair } from "./dexscreener.js";
import type { Detection } from "./detectors/types.js";
import type { ScamAssessment } from "./detectors/scam.js";
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
  const labels = p.labels && p.labels.length > 0 ? ` ${p.labels.join("/")}` : "";
  return `${p.dexId}${labels}`;
}

/** 出来高の水準を 低 / 中 / 高 の 3 段階に落とす */
export function volumeLevel(volH1: number, midUsd: number, highUsd: number): { label: string; mark: string } {
  if (volH1 >= highUsd) return { label: "高", mark: "🟥" };
  if (volH1 >= midUsd) return { label: "中", mark: "🟧" };
  return { label: "低", mark: "🟨" };
}

/** 新規ローンチの規模を 小 / 中 / 大 に落とす。段階しきい値の何段目かで決まる */
export function launchSize(level: number, levelCount: number): { label: string; mark: string } {
  if (levelCount >= 3) {
    if (level >= 3) return { label: "大", mark: "🚀🚀🚀" };
    if (level === 2) return { label: "中", mark: "🚀🚀" };
    return { label: "小", mark: "🚀" };
  }
  // 段階を 1〜2 個しか設定していない場合は、段数から素直に決める
  if (level >= levelCount && levelCount > 1) return { label: "大", mark: "🚀🚀" };
  return { label: "小", mark: "🚀" };
}

/** 買いか売りに偏っているときだけ 1 行返す。均衡していれば空文字 */
export function txnSkewLine(buysH1: number, sellsH1: number, showFrom: number): string {
  const total = buysH1 + sellsH1;
  if (total < 20) return "";
  const buyShare = buysH1 / total;
  if (buyShare >= showFrom) return `買い偏重  買 ${buysH1} / 売 ${sellsH1}（買い ${Math.round(buyShare * 100)}%）`;
  if (1 - buyShare >= showFrom) return `売り偏重  買 ${buysH1} / 売 ${sellsH1}（売り ${Math.round((1 - buyShare) * 100)}%）`;
  return "";
}

export interface AlertViewOptions {
  volLevelMidUsd: number;
  volLevelHighUsd: number;
  txnSkewShow: number;
  scamShowScoreFrom: number;
}

const DEFAULT_VIEW: AlertViewOptions = {
  volLevelMidUsd: 50_000,
  volLevelHighUsd: 250_000,
  txnSkewShow: 0.65,
  scamShowScoreFrom: 20,
};

/**
 * 通知本文。
 * 新規ローンチと復活では見るべき数字が違うので、共通の器に流し込まず別々に組む。
 * ひと目で種別が分かることを最優先し、内部のフィルタで担保済みの値（流動性・FDV）は載せない。
 */
export function formatAlert(
  d: Detection,
  p: DexPair,
  ageMs: number | null,
  scam?: ScamAssessment,
  view: AlertViewOptions = DEFAULT_VIEW,
): string {
  const lines = d.kind === "new_launch" ? newLaunchLines(d, p, ageMs, view) : revivalLines(d, p, ageMs, view);

  const skew = txnSkewLine(d.metrics.buysH1, d.metrics.sellsH1, view.txnSkewShow);
  if (skew) lines.push(skew);

  lines.push("", `📈 <a href="${escapeHtml(p.url)}">DexScreener</a>  ·  ${escapeHtml(dexLabel(p))}`);
  lines.push(`<code>${escapeHtml(p.baseToken.address)}</code>`);

  if (scam && scam.score >= view.scamShowScoreFrom && scam.signals.length > 0) {
    lines.push("", `⚠️ 注意 (${scam.score}/100)`);
    for (const sig of scam.signals) lines.push(`・${escapeHtml(sig.label)}`);
  }
  return lines.join("\n");
}

function titleLine(p: DexPair): string {
  const sym = escapeHtml(p.baseToken.symbol || "?");
  const name = escapeHtml(p.baseToken.name || "");
  return name && name.toLowerCase() !== (p.baseToken.symbol || "").toLowerCase() ? `<b>$${sym}</b>  ${name}` : `<b>$${sym}</b>`;
}

/** 🚀 新規ローンチ: 規模と勢いが分かればよい */
function newLaunchLines(d: Detection, p: DexPair, ageMs: number | null, view: AlertViewOptions): string[] {
  const m = d.metrics;
  const size = launchSize(d.level, d.levelCount);
  return [
    `${size.mark} <b>新規ローンチ</b> ｜ 規模 <b>${size.label}</b>`,
    titleLine(p),
    "",
    `価格   <b>${fmtPrice(m.priceUsd)}</b>   1h ${fmtPct(m.priceChangeH1)}   5m ${fmtPct(m.priceChangeM5)}`,
    `出来高  <b>${fmtUsd(m.volH1)}</b>/h   24h ${fmtUsd(m.volH24)}`,
    `時価総額 ${fmtUsd(p.marketCap ?? p.fdv)}`,
    `経過   ${fmtAge(ageMs)}`,
  ];
}

/** 🔥 復活: 「どこから」「どれだけ」上がったか、出来高がどの水準かを見せる */
function revivalLines(d: Detection, p: DexPair, ageMs: number | null, view: AlertViewOptions): string[] {
  const m = d.metrics;
  const lv = volumeLevel(m.volH1, view.volLevelMidUsd, view.volLevelHighUsd);
  const rise = d.display.baseRisePct;
  const quiet = d.display.quietMs;
  const ratio = m.volSpikeRatio;

  const t = d.display.trigger;
  const kindLabel =
    t === "reignite" ? "再点火" : t === "breakout" ? "レンジ上抜け" : t === "fast" ? "急変" : "静穏から復活";
  const icon = t === "reignite" ? "♻️🔥" : "🔥";
  const head = `${icon} <b>${kindLabel}</b> ｜ 出来高 <b>${lv.label}</b> ${lv.mark}${d.level > 1 ? `  ＋${d.level} 段目` : ""}`;
  const lines = [head, titleLine(p), ""];

  // いちばん見たい数字を最初に置く
  const bo = d.display.breakoutPct;
  if (t === "reignite") {
    const peak = d.display.peakMc ?? 0;
    const ago = d.display.peakAgoMs;
    const nowMc = d.display.currentMc ?? 0;
    const rangeMc = d.display.rangeHighMc ?? 0;
    const cooled = d.display.cooledRatio;
    lines.push(
      `全盛期 MC <b>${fmtUsd(peak)}</b>${ago ? `（${fmtAge(ago)}前）` : ""} → いま <b>${fmtUsd(nowMc)}</b>${
        cooled !== null && cooled !== undefined ? `（${Math.round(cooled * 100)}%）` : ""
      }`,
    );
    // 再点火は時価総額で判定しているので、上抜け率も時価総額基準のものを出す
    const mcBo = d.display.mcBreakoutPct;
    if (rangeMc > 0 && mcBo !== null && mcBo !== undefined) {
      lines.push(`レンジ上限 ${fmtUsd(rangeMc)} を <b>${fmtPct(mcBo)}</b> 上抜け`);
    }
    if (rise !== null && rise !== undefined) lines.push(`底値から <b>${fmtPct(rise)}</b>`);
  } else if (t === "breakout" && bo !== null && bo !== undefined) {
    lines.push(`レンジ上限を <b>${fmtPct(bo)}</b> 上抜け   （現在 ${fmtPrice(m.priceUsd)}）`);
    if (rise !== null && rise !== undefined) lines.push(`底値から ${fmtPct(rise)}`);
  } else if (rise !== null && rise !== undefined) {
    lines.push(`底値から <b>${fmtPct(rise)}</b>   （現在 ${fmtPrice(m.priceUsd)}）`);
  } else {
    lines.push(`価格   <b>${fmtPrice(m.priceUsd)}</b>`);
  }
  lines.push(`直近   1h ${fmtPct(m.priceChangeH1)}   5m ${fmtPct(m.priceChangeM5)}`);

  // 倍率は「平常より増えている」ときだけ意味を持つ。
  // レンジ抜けは出来高が引き金ではないので、平常並みなら倍率を書かない（0倍 と出ると誤解を招く）。
  let ratioText = "";
  if (ratio !== null) {
    if (!Number.isFinite(ratio)) ratioText = "平常はほぼ無取引";
    else if (ratio >= 2) ratioText = `平常の ${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}倍`;
  }
  lines.push(`出来高  <b>${fmtUsd(m.volH1)}</b>/h${ratioText ? `   ${ratioText}` : ""}`);

  if (quiet !== null && quiet !== undefined && quiet > 0 && d.display.trigger !== "breakout") {
    lines.push(`静穏   ${fmtAge(quiet)} ヨコヨコ → 急騰`);
  }
  lines.push(`経過   ${fmtAge(ageMs)}`);
  if (d.display.viaFastLane) lines.push(`⚡ 5分足の急変で早期検知`);
  return lines;
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

/** 止めた通知の 1 行表示。なぜ止めたのかが分かるようにする */
export function formatSuppressedRow(a: AlertRow): string {
  const when = new Date(a.ts).toISOString().replace("T", " ").slice(5, 16);
  const reasons = a.scam_reasons
    .split("\n")
    .filter(Boolean)
    .map((r) => `\n    ・${escapeHtml(r)}`)
    .join("");
  return `🚫 ${when} <b>$${escapeHtml(a.symbol)}</b> リスク ${a.scam_score}/100${reasons}\n    <code>${escapeHtml(a.token_address)}</code>`;
}
