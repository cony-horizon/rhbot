import { describe, expect, it } from "vitest";
import { escapeHtml, fmtAge, fmtPrice, fmtUsd, formatAlert } from "../src/format.js";
import { parseCommand } from "../src/telegram.js";
import { detectNewLaunch } from "../src/detectors/newLaunch.js";
import { assessScam } from "../src/detectors/scam.js";
import { H, NOW, makeConfig, makePair } from "./helpers.js";

describe("parseCommand", () => {
  it("グループ内の /cmd@bot 形式も解釈", () => {
    expect(parseCommand("/watch@MyBot 0xabc")).toEqual({ cmd: "watch", args: ["0xabc"] });
    expect(parseCommand("  /STATUS ")).toEqual({ cmd: "status", args: [] });
    expect(parseCommand("hello")).toBeNull();
  });
});

describe("format", () => {
  it("数値フォーマット", () => {
    expect(fmtUsd(1234)).toBe("$1.2K");
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
    expect(fmtUsd(null)).toBe("-");
    expect(fmtPrice(0.00001234)).toBe("$0.00001234");
    expect(fmtPrice(2.5)).toBe("$2.5000");
    expect(fmtAge(90 * 60_000)).toBe("1時間30分");
    expect(fmtAge(3 * 24 * H)).toBe("3日0時間");
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("アラート本文に主要情報と CA を含む", () => {
    const p = makePair({ ageHours: 1, volH1: 60_000, symbol: "A<B" });
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: H, lastAlert: null, lookbackMinPrice: null }, makeConfig())!;
    const html = formatAlert(d, p, H);
    expect(html).toContain("🚀");
    expect(html).toContain("新規ローンチ");
    expect(html).toContain("規模");
    expect(html).toContain("$A&lt;B");
    expect(html).toContain("<code>" + p.baseToken.address + "</code>");
    expect(html).toContain('href="' + p.url + '"');
    expect(html).toContain("<b>$60.0K</b>/h");
    // 内部フィルタで担保済みの値は載せない
    expect(html).not.toContain("流動性");
    expect(html).not.toContain("FDV");
  });

  it("厚みが確認できた銘柄には、通した理由を添える", () => {
    const p = makePair({ ageHours: 1, volH1: 1_700_000, liq: 94_000, buysH1: 6033, sellsH1: 5778, changeH1: 1900 });
    p.marketCap = 1_000_000;
    p.fdv = 1_000_000;
    const cfg = makeConfig();
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: H, lastAlert: null, lookbackMinPrice: null }, cfg)!;
    const html = formatAlert(d, p, H, assessScam(p, cfg, NOW));
    expect(html).toContain("👥");
    expect(html).toContain("参加者の厚みあり");
    expect(html).toContain("11,811 件");
    // 厚みと無関係な注意（薄いプールでの急騰）は残す
    expect(html).toContain("⚠️ 注意");
  });

  it("厚みが無ければ、その行は出さない", () => {
    const p = makePair({ ageHours: 1, volH1: 60_000 });
    const cfg = makeConfig();
    const d = detectNewLaunch({ now: NOW, pair: p, ageMs: H, lastAlert: null, lookbackMinPrice: null }, cfg)!;
    expect(formatAlert(d, p, H, assessScam(p, cfg, NOW))).not.toContain("👥");
  });
});
