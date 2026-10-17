import { describe, expect, it, vi } from "vitest";
import type { UserSession } from "./user-session-client-state";
import { runDaoSessionAction } from "./dao-session-action";

const account = "0x1234567890123456789012345678901234567890";
const other = "0x2234567890123456789012345678901234567890";
const currentSession = (): UserSession => ({
  id: "test-session",
  address: account,
  chainId: 560048,
  expiresAt: Date.now() + 60_000,
  accessExpiresAt: Date.now() + 30_000,
});
function setup() {
  const order: string[] = [];
  let current = true;
  const assertSession = vi.fn(async () => {
    order.push("session");
    return currentSession();
  });
  const prepare = vi.fn(async () => {
    order.push("prepare");
  });
  const execute = vi.fn(async () => {
    order.push("wallet");
    return "submitted-result";
  });
  const run = () =>
    runDaoSessionAction({
      account,
      chainId: 560048,
      assertSession,
      isCurrent: () => current,
      prepare,
      execute,
    });
  return {
    order,
    run,
    assertSession,
    prepare,
    execute,
    retire: () => {
      current = false;
    },
  };
}
describe("DAO current platform-session action boundary", () => {
  it("checks the session before preparation and again before the first wallet request", async () => {
    const s = setup();
    expect(await s.run()).toBe("submitted-result");
    expect(s.order).toEqual(["session", "prepare", "session", "wallet"]);
    expect(s.assertSession).toHaveBeenNthCalledWith(1, account, 560048);
    expect(s.assertSession).toHaveBeenNthCalledWith(2, account, 560048);
  });
  it("an unauthenticated caller never prepares or opens a prompt", async () => {
    const s = setup();
    s.assertSession.mockRejectedValue(new Error("Sign in"));
    await expect(s.run()).rejects.toThrow("Sign in");
    expect(s.prepare).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("logout or a changed wallet during preparation prevents the next session check and prompt", async () => {
    const s = setup();
    s.prepare.mockImplementation(async () => {
      s.retire();
    });
    await expect(s.run()).rejects.toThrow("changed");
    expect(s.assertSession).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("a revoked second session stops a previously successful preparation", async () => {
    const s = setup();
    s.assertSession
      .mockResolvedValueOnce(currentSession())
      .mockRejectedValueOnce(new Error("Revoked"));
    await expect(s.run()).rejects.toThrow("Revoked");
    expect(s.prepare).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("simulation or chain-reader failure does not open a wallet request", async () => {
    const s = setup();
    s.prepare.mockRejectedValue(new Error("Simulation refused"));
    await expect(s.run()).rejects.toThrow("Simulation refused");
    expect(s.execute).not.toHaveBeenCalled();
  });
  it.each<Partial<UserSession>>([
    { address: other },
    { chainId: 1 },
    { accessExpiresAt: 0 },
    { expiresAt: 0 },
  ])(
    "does not accept a mismatched or expired platform session %j",
    async (patch) => {
      const s = setup();
      s.assertSession.mockResolvedValue({ ...currentSession(), ...patch });
      await expect(s.run()).rejects.toThrow("Sign in");
      expect(s.prepare).not.toHaveBeenCalled();
      expect(s.execute).not.toHaveBeenCalled();
    },
  );
  it("rejects a departed operation before any server request", async () => {
    const s = setup();
    s.retire();
    await expect(s.run()).rejects.toThrow("changed");
    expect(s.assertSession).not.toHaveBeenCalled();
  });
  it.each([1, 84532])(
    "rejects unsupported chain %i before authentication or simulation",
    async (chainId) => {
      const assertSession = vi.fn(async () => currentSession());
      const prepare = vi.fn(async () => {}),
        execute = vi.fn(async () => "unused");
      await expect(
        runDaoSessionAction({
          account,
          chainId,
          assertSession,
          isCurrent: () => true,
          prepare,
          execute,
        }),
      ).rejects.toThrow("Hoodi");
      expect(assertSession).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("returns an already submitted result after navigation for original-operation recovery", async () => {
    const s = setup();
    s.execute.mockImplementation(async () => {
      s.retire();
      return "submitted-result";
    });
    expect(await s.run()).toBe("submitted-result");
    expect(s.execute).toHaveBeenCalledOnce();
  });
});
