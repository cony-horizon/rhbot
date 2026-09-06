import { describe, expect, it, vi } from "vitest";
import { TelegramClient, TelegramError, TelegramNetworkError, describeNetworkError } from "../src/telegram.js";

/** undici が投げる本物の形: TypeError: fetch failed の cause に実際の理由が入る */
function fetchFailed(code = "ECONNRESET", msg = "read ECONNRESET"): TypeError {
  const cause = Object.assign(new Error(msg), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function ok(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

describe("describeNetworkError", () => {
  it("cause を辿って本当の原因を出す", () => {
    expect(describeNetworkError(fetchFailed())).toBe("fetch failed ← read ECONNRESET (ECONNRESET)");
  });

  it("原因が無くても壊れない", () => {
    expect(describeNetworkError(new Error("boom"))).toBe("boom");
  });
});

describe("TelegramClient の通信エラー耐性", () => {
  it("一時的な fetch failed は再試行して成功する", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce(ok({ id: 1, username: "my_bot" }));
    const tg = new TelegramClient("t", fetchImpl as unknown as typeof fetch);
    await expect(tg.getMe()).resolves.toMatchObject({ username: "my_bot" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ずっと繋がらないときは原因付きの TelegramNetworkError になる", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.telegram.org"));
    const tg = new TelegramClient("t", fetchImpl as unknown as typeof fetch);
    const err = await tg.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(TelegramNetworkError);
    expect(err.detail).toContain("ENOTFOUND");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("トークンが違う場合(401)は再試行せず即座に失敗する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 }),
    );
    const tg = new TelegramClient("t", fetchImpl as unknown as typeof fetch);
    const err = await tg.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.code).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 無駄な再試行をしない
  });

  it("報告された事象の再現: getMe は成功し setMyCommands だけ落ちても、認証は済んでいる", async () => {
    // 1回目 getMe = 成功、以降 setMyCommands は3回とも通信失敗
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ id: 1, username: "my_memecoin_spike_bot" }))
      .mockRejectedValue(fetchFailed());
    const tg = new TelegramClient("t", fetchImpl as unknown as typeof fetch);

    await expect(tg.getMe()).resolves.toMatchObject({ username: "my_memecoin_spike_bot" });
    // setMyCommands は失敗するが、それはトークンの問題ではないと分かる型で返る
    const err = await tg.setMyCommands([{ command: "status", description: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramNetworkError);
    expect(err).not.toBeInstanceOf(TelegramError);
  });
});
