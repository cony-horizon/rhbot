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
      rug: null,
    };

    const minLiq = cfg.outcomeMinLiquidityUsd;
    const gainAt = (offset: number, before: number, after: number): number | null => {
      const price = store.priceNear(a.pair_address, a.ts + offset, before, after, minLiq);
      return price === null ? null : (price / base - 1) * 100;
    };

    const elapsed = now - a.ts;
    if (o.p15m === null && elapsed >= 15 * MINUTE_MS) o.p15m = gainAt(15 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS);
    if (o.p1h === null && elapsed >= HOUR_MS) o.p1h = gainAt(HOUR_MS, 10 * MINUTE_MS, 15 * MINUTE_MS);
    if (o.p4h === null && elapsed >= 4 * HOUR_MS) o.p4h = gainAt(4 * HOUR_MS, 15 * MINUTE_MS, 30 * MINUTE_MS);
    if (o.p24h === null && elapsed >= 24 * HOUR_MS) o.p24h = gainAt(24 * HOUR_MS, 30 * MINUTE_MS, 60 * MINUTE_MS);

    // 24h までの最高・最安を毎回引き直す（地平が伸びるほど値が更新されうる）
    const horizon = Math.min(now, a.ts + 24 * HOUR_MS);
    const ext = store.priceExtremesBetween(a.pair_address, a.ts, horizon, minLiq);
    if (ext) {
      if (ext.max !== null) {
        o.max_gain_pct = (ext.max / base - 1) * 100;
        o.max_gain_at = ext.maxTs;
      }
      // 入口からの下落幅なので 0 が上限。上がりっぱなしの銘柄で「DD +300%」と出ないように
      o.max_dd_pct = Math.min(0, (ext.min / base - 1) * 100);
      // +30% を付けてからゼロになった銘柄は「的中」ではあってもラグ。別に持つ
      o.rug = o.max_dd_pct <= -cfg.outcomeRugPct ? 1 : 0;
    }

    // 的中判定は猶予時間内の最高値で決める
    if (o.hit === null) {
      const inWindow = store.priceExtremesBetween(a.pair_address, a.ts, Math.min(now, a.ts + hitWindow), minLiq);
      if (inWindow && inWindow.max !== null && (inWindow.max / base - 1) * 100 >= cfg.outcomeHitPct) {
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

/** +30% を付けたが、その後ラグった銘柄は勝ちに数えない */
export function isCleanHit(j: Judged): boolean {
  return j.hit === 1 && j.rug !== 1;
}
export function isRug(j: Judged): boolean {
  return j.rug === 1;
}

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
  new_lowmc: "🌱 新規(低MC)",
  reignite: "♻️ 再点火",
  dormant: "🔥 静穏から復活",
  breakout: "🔥 レンジ上抜け",
  fast: "🔥 急変",
};

/**
 * 集計の単位になる経路。
 * 新規を一括りにすると低MC レーンの成績が普通のレーンに埋もれて、
 * 試験運用の可否を判断できない。記録された経路をそのまま使う。
 */
function triggerOf(a: AlertRow): string {
  if (a.trigger) return a.trigger;
  return a.kind === "new_launch" ? "new" : "dormant";
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
 * 平均ではなく中央値で見る。
 * 1 件の +39741% が平均を +827% に引き上げ、残り 97 件の実態を隠してしまった。
 */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** 同じトークンの通知（段階 1/3, 2/3, 3/3 や複数プール）を 1 件にまとめる。先頭＝順位の高いほうを残す */
function uniqueByToken<T extends { token_address: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((j) => {
    const k = j.token_address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * しきい値を上げたら何が起きるかを、勝ちだけでなく負けも含めて数える。
 * 「止めた中に勝ちがある」だけでは上げる根拠にならない。
 * 一緒に通る負けのほうが多ければ、全体の的中率は下がる。
 */
export function thresholdTradeoff(
  blocked: Judged[],
  sentHitRate: number | null,
  current: number,
): { threshold: number; admitted: number; hits: number; rate: number; dilutes: boolean }[] {
  const out: { threshold: number; admitted: number; hits: number; rate: number; dilutes: boolean }[] = [];
  let prevAdmitted = 0;
  for (const t of [current + 10, current + 20, current + 30]) {
    if (t > 100) break;
    const admitted = blocked.filter((j) => j.scam_score < t);
    // 前の段と同じ集合なら根拠が増えていない。並べると「80 まで上げられる」と読めてしまう
    if (admitted.length === 0 || admitted.length === prevAdmitted) continue;
    prevAdmitted = admitted.length;
    const hits = admitted.filter(isCleanHit).length;
    const rate = hits / admitted.length;
    out.push({ threshold: t, admitted: admitted.length, hits, rate, dilutes: sentHitRate !== null && rate < sentHitRate });
  }
  return out;
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

  // 出来高が時価総額の何倍動いたか。低MC レーンのしきい値はここを見て決める。
  // 一件の実例から勘で置くと、また同じ取り逃がしをするため
  if (a.mc_usd > 0 && a.vol_h1 > 0) {
    const r = a.vol_h1 / a.mc_usd;
    const bucket = r >= 3 ? "3倍以上" : r >= 1 ? "1-3倍" : r >= 0.5 ? "0.5-1倍" : "0.5倍未満";
    out.push({ name: "出来高/MC", bucket, knob: "NEW_LOW_MC_VOL_TO_MC" });
  }

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
  // ラグを勝ちに数えると「買い偏重の新規は的中 79%」のような逆の結論が出る。ここは実質の勝ちで見る
  const totalHits = judged.filter(isCleanHit).length;
  for (const j of judged) {
    for (const at of attributes(j, cfg)) {
      const key = `${at.name}|${at.bucket}`;
      const g = groups.get(key) ?? { attr: at, n: 0, hits: 0 };
      g.n++;
      if (isCleanHit(j)) g.hits++;
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
    isRug(j) ? "💀ラグ" : "",
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
  const rawHits = sent.filter((a) => a.hit === 1).length;
  const hits = sent.filter(isCleanHit).length;
  const rugs = sent.filter(isRug).length;
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
    `通知 ${stats.judged} 件 ｜ 止めた ${blocked.length} 件`,
    `的中 = ${cfg.outcomeHitWindowHours}h 以内に +${cfg.outcomeHitPct}% ｜ ラグ = 24h 内に -${cfg.outcomeRugPct}% ｜ <b>実質</b> = 的中かつラグでない`,
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
    const raw = list.filter((a) => a.hit === 1).length;
    const clean = list.filter(isCleanHit).length;
    const rg = list.filter(isRug).length;
    const mg = median(list.map((a) => a.max_gain_pct ?? 0));
    const p4 = median(list.filter((a) => a.p4h !== null && a.p4h !== undefined).map((a) => a.p4h as number));
    const dd = median(list.map((a) => a.max_dd_pct ?? 0));
    lines.push(
      `${(TRIGGER_LABEL[k] ?? k).padEnd(10)} ${String(list.length).padStart(2)}件  的中 ${rate(raw, list.length)} → <b>実質 ${rate(clean, list.length)}</b>${rg > 0 ? `（ラグ率 ${rate(rg, list.length)}）` : ""}`,
      `　中央値: 最大 ${fmtPct(mg)} / 4h後 ${fmtPct(p4)} / DD ${fmtPct(dd)}`,
    );
  }
  // 主軸の再点火が一度も鳴っていないなら、それ自体が報告すべき事実
  if (cfg.reigniteEnabled && !byTrigger.has("reignite")) {
    lines.push(`${TRIGGER_LABEL.reignite!.padEnd(10)}  0件  — 待機中の銘柄は /ranges で確認`);
  }
  lines.push(
    "",
    `合計 的中 ${rate(rawHits, sent.length)} → <b>実質 ${rate(hits, sent.length)}</b>（${hits}/${sent.length}）${rugs > 0 ? ` ｜ ラグ ${rugs} 件` : ""}`,
    `（最大＝24h 内の最高値。4h後＝通知から 4 時間後にただ持っていた場合）`,
  );

  // 前日比
  const yesterday = store.getDailyReport(jst(now - 24 * HOUR_MS).date);
  if (yesterday && yesterday.hit_rate !== null && stats.hitRate !== null) {
    lines.push(`前日比: ${Math.round(yesterday.hit_rate * 100)}% → ${Math.round(stats.hitRate * 100)}%`);
  }

  // 良かった / 悪かった
  // ラグった銘柄は「良かった」に入れない。+1851% の後に -100% は勝ちではないし、
  // 同じ銘柄が良かった側と悪かった側の両方に並ぶことになる
  const ranked = uniqueByToken(
    [...sent].filter((a) => a.max_gain_pct !== null && a.max_gain_pct !== undefined && !isRug(a)).sort((a, b) => (b.max_gain_pct ?? 0) - (a.max_gain_pct ?? 0)),
  );
  if (ranked.length > 0) {
    lines.push("", "<b>🏆 良かったコール</b>（ラグ除く）");
    for (const j of ranked.slice(0, 3)) lines.push(`・${describeCall(j)}`);
    const worst = uniqueByToken([...sent].sort((a, b) => (a.p4h ?? a.max_gain_pct ?? 0) - (b.p4h ?? b.max_gain_pct ?? 0))).filter((j) => (j.p4h ?? j.max_gain_pct ?? 0) < 0).slice(0, 3);
    if (worst.length > 0) {
      lines.push("", "<b>💀 悪かったコール</b>");
      for (const j of worst) lines.push(`・${describeCall(j)}`);
    }
  }

  // 止めた中の逸材（フィルタが厳しすぎる証拠）
  // 止めた側の「伸びた」からもラグを除く。+2346% の後に -99.8% は、止めて正解
  const blockedRugHits = blocked.filter((a) => a.hit === 1 && isRug(a)).length;
  const missed = uniqueByToken(blocked.filter(isCleanHit).sort((a, b) => (b.max_gain_pct ?? 0) - (a.max_gain_pct ?? 0)));
  if (missed.length > 0) {
    const missedRaw = blocked.filter(isCleanHit).length;
    lines.push("", `<b>🚫 止めたが伸びた銘柄</b>（実質 ${missedRaw}/${blocked.length} 件${blockedRugHits > 0 ? `。他に ${blockedRugHits} 件は +${cfg.outcomeHitPct}% の後ラグ＝止めて正解` : ""}）`);
    for (const j of missed.slice(0, 3)) lines.push(`・${describeCall(j)} ｜ リスク ${j.scam_score}`);
    // 上げたら勝ちも負けも一緒に通る。その両方を見せる
    const trade = thresholdTradeoff(blocked, stats.hitRate, cfg.scamScoreThreshold);
    if (trade.length > 0) {
      lines.push(`しきい値を上げた場合（現在 ${cfg.scamScoreThreshold}、通知の的中率 ${rate(hits, sent.length)}）:`);
      for (const t of trade) {
        lines.push(`　${t.threshold} → +${t.admitted}件 通る、うち的中 ${t.hits}件（${Math.round(t.rate * 100)}%）${t.dilutes ? " ← 全体の的中率が下がる" : " ← 上げても質は落ちない"}`);
      }
      const good = trade.filter((t) => !t.dilutes);
      lines.push(
        good.length > 0
          ? `→ SCAM_SCORE_THRESHOLD=${good[good.length - 1]!.threshold} まで上げる余地あり`
          : `→ 止めた側の的中率が通知より低いので、しきい値は据え置きが妥当`,
      );
    }
  } else if (blocked.length > 0) {
    lines.push(
      "",
      blockedRugHits > 0
        ? `🚫 止めた ${blocked.length} 件のうち ${blockedRugHits} 件は +${cfg.outcomeHitPct}% の後ラグ、残りは伸びず（フィルタは妥当）`
        : `🚫 止めた ${blocked.length} 件はいずれも伸びませんでした（フィルタは妥当）`,
    );
  }

  // 傾向と改善案。通知したものだけで見る。
  // 止めたものを混ぜると、フィルタが「ローンチ 1h 未満」を狙って止めている以上、
  // 「1h 未満は的中が低い」という結論が自動的に出てしまう（フィルタの結果を原因と取り違える）
  const ins = insights(sent, cfg);
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
    const mark = isRug(j) ? "💀" : j.hit === 1 ? "✅" : j.hit === 0 ? "❌" : "⏳";
    const mg = j.max_gain_pct ?? null;
    lines.push(
      `${mark} <b>$${escapeHtml(j.symbol)}</b> ${t} ｜ 15m ${fmtPct(j.p15m ?? null)} ｜ 1h ${fmtPct(j.p1h ?? null)} ｜ 4h ${fmtPct(j.p4h ?? null)} ｜ 最大 ${fmtPct(mg)} ｜ MC ${fmtUsd(j.mc_usd)}`,
    );
  }
  return lines.join("\n");
}
