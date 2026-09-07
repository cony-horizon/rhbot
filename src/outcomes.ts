import type { Config } from "./config.js";
import { HOUR_MS, MINUTE_MS } from "./detectors/common.js";
import { fmtPct, fmtUsd, escapeHtml } from "./format.js";
import type { AlertRow, OutcomeRow, Store } from "./store.js";

/**
 * 通知の「その後」を機械的に埋める。
 *
 * 目的は反省の材料を人手ゼロで揃えること。良かったコール・悪かったコールを
 * 感覚ではなく数字で振り返れるようにし、そこから調整すべき設定を導く。
 *
 * 価格はすでに取っているスナップショットから拾うので、追加の API 呼び出しは無い。
 * 通知したものだけでなく、スキャム判定で止めたものも追う。
 * 止めた中に勝ち銘柄が混ざっていれば、フィルタが厳しすぎる証拠になる。
 */
export function computeOutcomes(store: Store, cfg: Config, now: number): number {
  const rows = store.listAlertsNeedingOutcome(now, 30 * HOUR_MS);
  let updated = 0;
  const hitWindow = cfg.outcomeHitWindowHours * HOUR_MS;

  for (const a of rows) {
    const base = a.price_usd ?? 0;
    if (base <= 0) continue;
    const prev = store.getOutcome(a.id);
    const o: OutcomeRow = prev ?? {
      alert_id: a.id,
      alert_ts: a.ts,
      base_price: base,
      p15m: null,
      p1h: null,
      p4h: null,
      p24h: null,
      max_gain_pct: null,
      max_gain_at: null,
      max_dd_pct: null,
      done_until: 0,
      hit: null,
      bust: null,
    };

    const gainAt = (offset: number, before: number, after: number): number | null => {
      const price = store.priceNear(a.pair_address, a.ts + offset, before, after);
      return price === null ? null : (price / base - 1) * 100;
    };

    const elapsed = now - a.ts;
    if (o.p15m === null && elapsed >= 15 * MINUTE_MS) o.p15m = gainAt(15 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS);
    if (o.p1h === null && elapsed >= HOUR_MS) o.p1h = gainAt(HOUR_MS, 10 * MINUTE_MS, 15 * MINUTE_MS);
    if (o.p4h === null && elapsed >= 4 * HOUR_MS) o.p4h = gainAt(4 * HOUR_MS, 15 * MINUTE_MS, 30 * MINUTE_MS);
    if (o.p24h === null && elapsed >= 24 * HOUR_MS) o.p24h = gainAt(24 * HOUR_MS, 30 * MINUTE_MS, 60 * MINUTE_MS);

    // 24h までの最高・最安を毎回引き直す（地平が伸びるほど値が更新されうる）
    const horizon = Math.min(now, a.ts + 24 * HOUR_MS);
    const ext = store.priceExtremesBetween(a.pair_address, a.ts, horizon);
    if (ext) {
      o.max_gain_pct = (ext.max / base - 1) * 100;
      o.max_gain_at = ext.maxTs;
      o.max_dd_pct = (ext.min / base - 1) * 100;
    }

    // 的中判定は猶予時間内の最高値で決める
    if (o.hit === null) {
      const inWindow = store.priceExtremesBetween(a.pair_address, a.ts, Math.min(now, a.ts + hitWindow));
      if (inWindow && (inWindow.max / base - 1) * 100 >= cfg.outcomeHitPct) {
        o.hit = 1;
        o.bust = 0;
      } else if (elapsed >= hitWindow) {
        o.hit = 0;
        o.bust = inWindow && (inWindow.min / base - 1) * 100 <= -cfg.outcomeBustPct ? 1 : 0;
      }
    }

    o.done_until = elapsed >= 24 * HOUR_MS ? 24 * HOUR_MS : elapsed >= 4 * HOUR_MS ? 4 * HOUR_MS : elapsed >= HOUR_MS ? HOUR_MS : 15 * MINUTE_MS;
    store.upsertOutcome(o);
    updated++;
  }
  return updated;
}

/* ------------------------------------------------------------------ */
/*                              日次レポート                            */
/* ------------------------------------------------------------------ */

export type Judged = AlertRow & Partial<OutcomeRow>;

export interface ReportStats {
  from: number;
  to: number;
  total: number;
  suppressed: number;
  judged: number;
  hits: number;
  hitRate: number | null;
}

export const TRIGGER_LABEL: Record<string, string> = {
  new: "🚀 新規",
  reignite: "♻️ 再点火",
  dormant: "🔥 静穏から復活",
  breakout: "🔥 レンジ上抜け",
  fast: "🔥 急変",
};

function triggerOf(a: AlertRow): string {
  return a.kind === "new_launch" ? "new" : a.trigger || "dormant";
}

/** JST の日付文字列 YYYY-MM-DD と時刻 */
export function jst(now: number): { date: string; hour: number; label: string } {
  const d = new Date(now + 9 * HOUR_MS);
  const date = d.toISOString().slice(0, 10);
  return { date, hour: d.getUTCHours(), label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` };
}

function rate(hits: number, n: number): string {
  return n === 0 ? "-" : `${Math.round((hits / n) * 100)}%`;
}

function avg(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 属性ごとの的中率の差から、見直すべき設定を機械的に候補として挙げる。
 * 「買い偏重の新規は的中 20%、それ以外は 60%」のような対比が出れば、対応するノブを示す。
 */
interface Attr {
  name: string;
  bucket: string;
  knob: string;
}

function attributes(a: Judged, cfg: Config): Attr[] {
  const out: Attr[] = [];
  const t = triggerOf(a);
  out.push({ name: "種別", bucket: TRIGGER_LABEL[t] ?? t, knob: "NEW_LAUNCH_ENABLED / REVIVAL_ENABLED / REIGNITE_ENABLED" });

  const lv = a.vol_h1 >= cfg.volLevelHighUsd ? "高" : a.vol_h1 >= cfg.volLevelMidUsd ? "中" : "低";
  out.push({ name: "出来高", bucket: lv, knob: "REVIVAL_MIN_VOL_H1_USD / NEW_VOL_H1_TIERS_USD" });

  const band = a.scam_score >= 40 ? "40+" : a.scam_score >= 20 ? "20-39" : "0-19";
  out.push({ name: "リスク", bucket: band, knob: "SCAM_SCORE_THRESHOLD" });

  const tx = a.buys_h1 + a.sells_h1;
  if (tx >= 20) {
    const share = a.buys_h1 / tx;
    out.push({ name: "売買", bucket: share >= 0.7 ? "買い偏重" : share <= 0.3 ? "売り偏重" : "均衡", knob: "NEW_MIN_BUYS_H1 / スキャム加点の候補" });
  }

  const h = jst(a.ts).hour;
  out.push({ name: "時間帯(JST)", bucket: h < 6 ? "0-5時" : h < 12 ? "6-11時" : h < 18 ? "12-17時" : "18-23時", knob: "（参考情報）" });

  if (a.age_hours !== null && a.age_hours !== undefined) {
    const ag = a.age_hours;
    out.push({
      name: "経過",
      bucket: ag < 1 ? "1h未満" : ag < 6 ? "1-6h" : ag < 24 ? "6-24h" : ag < 72 ? "1-3日" : "3日超",
      knob: "NEW_MAX_AGE_HOURS / REVIVAL_MIN_AGE_HOURS",
    });
  }
  return out;
}

interface Insight {
  text: string;
  weight: number;
}

function insights(judged: Judged[], cfg: Config): Insight[] {
  const groups = new Map<string, { attr: Attr; n: number; hits: number }>();
  const totalHits = judged.filter((j) => j.hit === 1).length;
  for (const j of judged) {
    for (const at of attributes(j, cfg)) {
      const key = `${at.name}|${at.bucket}`;
      const g = groups.get(key) ?? { attr: at, n: 0, hits: 0 };
      g.n++;
      if (j.hit === 1) g.hits++;
      groups.set(key, g);
    }
  }
  // 属性ごとにまとめる。同じ属性の 2 分類は互いの裏表なので、別々の行にせず 1 行で対比する
  const byAttr = new Map<string, { attr: Attr; n: number; hits: number }[]>();
  for (const g of groups.values()) byAttr.set(g.attr.name, [...(byAttr.get(g.attr.name) ?? []), g]);

  const pct = (h: number, n: number) => Math.round((h / n) * 100);
  const hint = (knob: string, diff: number) =>
    knob.startsWith("（参考") ? "（設定ではなく参考情報）" : `${diff > 0 ? "増やす方向" : "絞る方向"}で見直す候補: ${knob}`;

  const out: Insight[] = [];
  for (const list of byAttr.values()) {
    const eligible = list.filter((g) => g.n >= cfg.reportMinSamples);
    if (eligible.length === 2 && eligible.length === list.length) {
      const [a, b] = [...eligible].sort((x, y) => y.hits / y.n - x.hits / x.n) as [typeof eligible[number], typeof eligible[number]];
      const diff = (a.hits / a.n - b.hits / b.n) * 100;
      if (diff < 20) continue;
      out.push({
        text: `${a.attr.name}: 「${a.attr.bucket}」${pct(a.hits, a.n)}%（${a.n}件） vs 「${b.attr.bucket}」${pct(b.hits, b.n)}%（${b.n}件）。${hint(b.attr.knob, -diff)}`,
        weight: diff * Math.sqrt(Math.min(a.n, b.n)),
      });
      continue;
    }
    for (const g of eligible) {
      const restN = judged.length - g.n;
      if (restN < cfg.reportMinSamples) continue;
      const r = g.hits / g.n;
      const rest = (totalHits - g.hits) / restN;
      const diff = (r - rest) * 100;
      if (Math.abs(diff) < 20) continue;
      out.push({
        text: `${g.attr.name}「${g.attr.bucket}」の的中 ${Math.round(r * 100)}%（${g.n}件） vs それ以外 ${Math.round(rest * 100)}% → ${diff > 0 ? "高い" : "低い"}。${hint(g.attr.knob, diff)}`,
        weight: Math.abs(diff) * Math.sqrt(g.n),
      });
    }
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 4);
}

function describeCall(j: Judged): string {
  const t = TRIGGER_LABEL[triggerOf(j)] ?? triggerOf(j);
  const mg = j.max_gain_pct ?? null;
  const when = j.max_gain_at && j.max_gain_at > j.ts ? `${Math.round((j.max_gain_at - j.ts) / MINUTE_MS)}分後` : "";
  const p4 = j.p4h ?? null;
  const dd = j.max_dd_pct ?? null;
  const parts = [
    `<b>$${escapeHtml(j.symbol)}</b> ${t}`,
    mg !== null ? `最大 ${fmtPct(mg)}${when ? `（${when}）` : ""}` : "",
    p4 !== null ? `4h ${fmtPct(p4)}` : "",
    dd !== null && dd <= -30 ? `最大DD ${fmtPct(dd)}` : "",
  ].filter(Boolean);
  return parts.join(" ｜ ");
}

/**
 * 日次レポートを組み立てる。
 * 判定対象は「4 時間以上経って結果が確定した通知」に限る。判定前のものを混ぜると
 * 直近の通知ほど不利に見えて、集計が歪むため。
 */
export function buildDailyReport(store: Store, cfg: Config, now: number): { text: string; stats: ReportStats } {
  const hitWindow = cfg.outcomeHitWindowHours * HOUR_MS;
  const to = now - hitWindow;
  const from = to - 24 * HOUR_MS;
  const all = store.listAlertsWithOutcomes(from, to);
  const judged = all.filter((a) => a.hit === 0 || a.hit === 1);
  const sent = judged.filter((a) => a.suppressed === 0);
  const blocked = judged.filter((a) => a.suppressed === 1);
  const hits = sent.filter((a) => a.hit === 1).length;
  const stats: ReportStats = {
    from,
    to,
    total: all.filter((a) => a.suppressed === 0).length,
    suppressed: all.filter((a) => a.suppressed === 1).length,
    judged: sent.length,
    hits,
    hitRate: sent.length ? hits / sent.length : null,
  };

  const { label } = jst(now);
  const lines: string[] = [
    `📊 <b>日次レポート ${label}</b>`,
    `対象: ${jst(from).label} ${jst(from).hour}時 〜 ${jst(to).label} ${jst(to).hour}時 の通知（結果確定分）`,
    `通知 ${stats.judged} 件 ｜ 止めた ${blocked.length} 件 ｜ 的中 = ${cfg.outcomeHitWindowHours}h 以内に +${cfg.outcomeHitPct}%`,
    "",
  ];

  if (sent.length === 0) {
    lines.push("判定できる通知がまだありません。24 時間ほど動かすと集計が始まります。");
    return { text: lines.join("\n"), stats };
  }

  // 種別別
  lines.push("<b>種別別の成績</b>");
  const byTrigger = new Map<string, Judged[]>();
  for (const a of sent) {
    const k = triggerOf(a);
    byTrigger.set(k, [...(byTrigger.get(k) ?? []), a]);
  }
  for (const [k, list] of [...byTrigger.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const h = list.filter((a) => a.hit === 1).length;
    const mg = avg(list.map((a) => a.max_gain_pct ?? 0));
    const dd = avg(list.map((a) => a.max_dd_pct ?? 0));
    lines.push(
      `${(TRIGGER_LABEL[k] ?? k).padEnd(10)} ${String(list.length).padStart(2)}件  的中 ${rate(h, list.length).padStart(4)}  平均最大 ${fmtPct(mg)}  平均DD ${fmtPct(dd)}`,
    );
  }
  lines.push("", `合計 的中率 <b>${rate(hits, sent.length)}</b>（${hits}/${sent.length}）`);

  // 前日比
  const yesterday = store.getDailyReport(jst(now - 24 * HOUR_MS).date);
  if (yesterday && yesterday.hit_rate !== null && stats.hitRate !== null) {
    lines.push(`前日比: ${Math.round(yesterday.hit_rate * 100)}% → ${Math.round(stats.hitRate * 100)}%`);
  }

  // 良かった / 悪かった
  const ranked = [...sent].filter((a) => a.max_gain_pct !== null && a.max_gain_pct !== undefined).sort((a, b) => (b.max_gain_pct ?? 0) - (a.max_gain_pct ?? 0));
  if (ranked.length > 0) {
    lines.push("", "<b>🏆 良かったコール</b>");
    for (const j of ranked.slice(0, 3)) lines.push(`・${describeCall(j)}`);
    const worst = [...ranked].reverse().filter((j) => (j.p4h ?? j.max_gain_pct ?? 0) < 0).slice(0, 3);
    if (worst.length > 0) {
      lines.push("", "<b>💀 悪かったコール</b>");
      for (const j of worst) lines.push(`・${describeCall(j)}`);
    }
  }

  // 止めた中の逸材（フィルタが厳しすぎる証拠）
  const missed = blocked.filter((a) => a.hit === 1).sort((a, b) => (b.max_gain_pct ?? 0) - (a.max_gain_pct ?? 0));
  if (missed.length > 0) {
    lines.push("", `<b>🚫 止めたが伸びた銘柄</b>（${missed.length}/${blocked.length} 件）`);
    for (const j of missed.slice(0, 3)) lines.push(`・${describeCall(j)} ｜ リスク ${j.scam_score}`);
    const minScore = Math.min(...missed.map((j) => j.scam_score));
    lines.push(`→ SCAM_SCORE_THRESHOLD を ${Math.min(100, minScore + 5)} 前後まで上げると拾えた可能性`);
  } else if (blocked.length > 0) {
    lines.push("", `🚫 止めた ${blocked.length} 件はいずれも伸びませんでした（フィルタは妥当）`);
  }

  // 傾向と改善案
  const ins = insights([...sent, ...blocked], cfg);
  if (ins.length > 0) {
    lines.push("", "<b>📈 傾向と改善案</b>");
    for (const i of ins) lines.push(`・${escapeHtml(i.text)}`);
  } else {
    lines.push("", "📈 属性ごとの差はまだ出ていません（件数が増えると出ます）");
  }

  lines.push("", `過去の通知は /alerts、止めたものは /filtered で確認できます。`);
  return { text: lines.join("\n"), stats };
}

/** 直近の通知の結果を一覧にする（/outcomes 用） */
export function formatRecentOutcomes(store: Store, now: number, limit: number): string {
  const rows = store.listAlertsWithOutcomes(now - 48 * HOUR_MS, now).filter((a) => a.suppressed === 0).slice(-limit).reverse();
  if (rows.length === 0) return "直近 48 時間に通知はありません";
  const lines = ["<b>直近の通知とその後</b>"];
  for (const j of rows) {
    const t = TRIGGER_LABEL[triggerOf(j)] ?? triggerOf(j);
    const mark = j.hit === 1 ? "✅" : j.hit === 0 ? "❌" : "⏳";
    const mg = j.max_gain_pct ?? null;
    lines.push(
      `${mark} <b>$${escapeHtml(j.symbol)}</b> ${t} ｜ 15m ${fmtPct(j.p15m ?? null)} ｜ 1h ${fmtPct(j.p1h ?? null)} ｜ 4h ${fmtPct(j.p4h ?? null)} ｜ 最大 ${fmtPct(mg)} ｜ MC ${fmtUsd(j.mc_usd)}`,
    );
  }
  return lines.join("\n");
}
