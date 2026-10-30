import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import {
  createOperatorChallenge,
  createOperatorSession,
  readOperatorChallenge,
  readOperatorSession,
  sessionStillAuthorized,
  verifyOperatorWallet,
} from "./operator-auth";

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  verifyMessage: vi.fn(),
  getChainId: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<object>()),
  createPublicClient: () => mocks,
}));
const owner = "0x1111111111111111111111111111111111111111" as Address;
const safe = "0x2222222222222222222222222222222222222222" as Address;
const registry = "0x3333333333333333333333333333333333333333" as Address;
const signature = `0x${"11".repeat(65)}` as Hex;
const role = keccak256(toBytes("REGISTRAR_ROLE"));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(
    "ARTFI_OPERATOR_SESSION_SECRET",
    "TEST_ONLY-session-signing-secret-longer-than-32",
  );
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
  vi.stubEnv("ARTFI_RPC_URL", "http://localhost:18545");
  vi.stubEnv("ARTFI_RWA_REGISTRY_ADDRESS", registry);
  vi.stubEnv("ARTFI_ADMIN_SAFE_ADDRESS", "");
  vi.stubEnv("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS", "");
  mocks.getChainId.mockResolvedValue(560048);
  mocks.verifyMessage.mockResolvedValue(true);
  mocks.readContract.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function configureSafe() {
  vi.stubEnv("ARTFI_ADMIN_SAFE_ADDRESS", safe);
  vi.stubEnv("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS", safe);
}

describe("operator authentication deployment binding", () => {
  it("keeps direct registrar deployments compatible", async () => {
    const { challenge, token } = createOperatorChallenge(
      owner,
      "https://artfi.example.test",
    );
    expect(readOperatorChallenge(token)).toEqual(challenge);
    expect(challenge.message).toContain("Chain ID: 560048");
    expect(challenge.message).toContain(`Registry: ${registry}`);
    expect(
      await verifyOperatorWallet(owner, challenge.message, signature),
    ).toBe(true);
    expect(mocks.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: registry,
        functionName: "hasRole",
        args: [role, owner],
      }),
    );
  });
  it("binds the configured safe into the signed challenge and short-lived session", async () => {
    configureSafe();
    const { challenge } = createOperatorChallenge(
      owner,
      "https://artfi.example.test",
    );
    expect(challenge.message).toContain(`Administration Safe: ${safe}`);
    expect(challenge.message).toContain("Nonce:");
    expect(
      await verifyOperatorWallet(owner, challenge.message, signature),
    ).toBe(true);
    const { session, token } = createOperatorSession(owner);
    expect(readOperatorSession(token)).toEqual(session);
    expect(session).toMatchObject({
      address: owner,
      chainId: 560048,
      registryAddress: registry,
      safeAddress: safe,
    });
    expect(mocks.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registry, args: [role, safe] }),
    );
    expect(mocks.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: safe,
        functionName: "isOwner",
        args: [owner],
      }),
    );
  });
  it("checks actual safe ownership again for a later session request", async () => {
    configureSafe();
    const { session } = createOperatorSession(owner);
    mocks.readContract.mockImplementation(
      async ({ functionName }) => functionName !== "isOwner",
    );
    expect(await sessionStillAuthorized(session)).toBe(false);
  });
  it("does not treat an unassigned safe as a registrar role", async () => {
    configureSafe();
    mocks.readContract.mockResolvedValue(false);
    expect(
      await verifyOperatorWallet(owner, "TEST_ONLY challenge", signature),
    ).toBe(false);
    expect(mocks.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "isOwner" }),
    );
  });
  it("retires existing challenges and sessions when the deployment safe changes", () => {
    configureSafe();
    const challenge = createOperatorChallenge(
      owner,
      "https://artfi.example.test",
    );
    const session = createOperatorSession(owner);
    vi.stubEnv("ARTFI_ADMIN_SAFE_ADDRESS", registry);
    vi.stubEnv("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS", registry);
    expect(readOperatorChallenge(challenge.token)).toBeUndefined();
    expect(readOperatorSession(session.token)).toBeUndefined();
  });
  it("retires sessions after their ordinary expiration", () => {
    vi.useFakeTimers();
    const { token } = createOperatorSession(owner);
    vi.advanceTimersByTime(10 * 60_000);
    expect(readOperatorSession(token)).toBeUndefined();
  });
  it("stops when the configured RPC reports another chain", async () => {
    mocks.getChainId.mockResolvedValue(1);
    await expect(
      verifyOperatorWallet(owner, "TEST_ONLY challenge", signature),
    ).rejects.toThrow(/chain/i);
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
  it("requires matching server and public safe configuration", () => {
    vi.stubEnv("ARTFI_ADMIN_SAFE_ADDRESS", safe);
    expect(() =>
      createOperatorChallenge(owner, "https://artfi.example.test"),
    ).toThrow(/configuration must match/);
  });
  it("does not establish authorization from a declined/invalid wallet sign-in", async () => {
    mocks.verifyMessage.mockResolvedValue(false);
    expect(
      await verifyOperatorWallet(owner, "TEST_ONLY challenge", signature),
    ).toBe(false);
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
});
