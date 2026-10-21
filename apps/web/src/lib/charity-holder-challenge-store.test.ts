import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./user-auth", () => ({ userAuthRequest: mocks.request }));
import {
  registerHolderChallenge,
  consumeHolderChallenge,
} from "./charity-holder-challenge-store";
const token = "synthetic-test-only-signed-cookie-identity";
const challenge = {
  type: "holder-challenge" as const,
  chainId: 560048,
  contractAddress: "0x2222222222222222222222222222222222222222" as const,
  address: "0x1111111111111111111111111111111111111111" as const,
  tokenId: "7",
  message: "synthetic holder proof",
  expiresAt: 1792454700000,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockResolvedValue(undefined);
});
describe("existing authenticated app bridge holder purpose", () => {
  it.each([
    ["holder-challenge", registerHolderChallenge],
    ["holder-consume", consumeHolderChallenge],
  ] as const)(
    "sends exact original identity and scope for %s",
    async (action, operation) => {
      await operation(token, challenge, "https://artfi.example");
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith(action, {
        challengeHash: createHash("sha256").update(token).digest("hex"),
        address: challenge.address,
        chainId: 560048,
        tokenId: "7",
        origin: "https://artfi.example",
        issuedAt: challenge.expiresAt - 300000,
        expiresAt: challenge.expiresAt,
      });
      expect(JSON.stringify(mocks.request.mock.calls)).not.toContain(token);
    },
  );
  it.each([registerHolderChallenge, consumeHolderChallenge])(
    "does not accept an unexpected successful payload",
    async (operation) => {
      mocks.request.mockResolvedValue({ accepted: true });
      await expect(
        operation(token, challenge, "https://artfi.example"),
      ).rejects.toThrow("not confirmed");
      expect(mocks.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([registerHolderChallenge, consumeHolderChallenge])(
    "does not retry a failed or uncertain bridge response",
    async (operation) => {
      mocks.request.mockRejectedValue(new Error("unknown outcome"));
      await expect(
        operation(token, challenge, "https://artfi.example"),
      ).rejects.toThrow("unknown outcome");
      expect(mocks.request).toHaveBeenCalledTimes(1);
    },
  );
});
