import { createHmac } from "node:crypto";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHolderChallenge,
  createHolderGrant,
  grantCoversEdition,
  readHolderChallenge,
  readHolderGrant,
} from "./charity-holder-auth";

const holder = "0x1111111111111111111111111111111111111111";
const contract = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const replacement = "0x2222222222222222222222222222222222222222";
const key = "synthetic-test-only-charity-deployment-hmac-key";

beforeEach(() => {
  vi.stubEnv("ARTFI_CHARITY_HOLDER_SESSION_SECRET", key);
  vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", contract);
});
afterEach(() => vi.unstubAllEnvs());

function signed(payload: unknown) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
}

describe("charity holder deployment binding", () => {
  it("signs the exact edition, contract and chain in the wallet challenge", () => {
    const { challenge, token } = createHolderChallenge(
      holder,
      "0007",
      "https://artfi.example",
    );
    expect(challenge).toMatchObject({
      chainId: 560048,
      contractAddress: contract,
      tokenId: "7",
    });
    expect(challenge.message).toContain(`eip155:560048/erc1155:${contract}/7`);
    expect(readHolderChallenge(token)).toEqual(challenge);
  });

  it("keeps a grant valid for the same canonical deployment", () => {
    const { grant, token } = createHolderGrant(holder, "7");
    expect(grant).toMatchObject({ chainId: 560048, contractAddress: contract });
    vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", getAddress(contract));
    expect(readHolderGrant(token)).toEqual(grant);
    expect(grantCoversEdition(grant, "007")).toBe(true);
    expect(grantCoversEdition(grant, "8")).toBe(false);
  });

  it("does not reinterpret an existing challenge against a replacement contract", () => {
    const issued = createHolderChallenge(holder, "7", "https://artfi.example");
    vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", replacement);
    expect(readHolderChallenge(issued.token)).toBeUndefined();
  });

  it("does not unlock the same token number on a replacement contract", () => {
    const issued = createHolderGrant(holder, "7");
    vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", replacement);
    expect(readHolderGrant(issued.token)).toBeUndefined();
    expect(grantCoversEdition(issued.grant, "7")).toBe(false);
  });

  it.each(["challenge", "grant"])(
    "refuses a legacy unscoped %s even with a valid MAC",
    (kind) => {
      const issued =
        kind === "challenge"
          ? createHolderChallenge(holder, "7", "https://artfi.example")
              .challenge
          : createHolderGrant(holder, "7").grant;
      const { chainId, contractAddress, ...legacy } = issued;
      expect(chainId).toBe(560048);
      expect(contractAddress).toBe(contract);
      expect(
        (kind === "challenge" ? readHolderChallenge : readHolderGrant)(
          signed(legacy),
        ),
      ).toBeUndefined();
    },
  );

  it.each([1, 11155111, "560048"])(
    "refuses the signed wrong chain %s",
    (chainId) => {
      const issued = createHolderGrant(holder, "7").grant;
      expect(readHolderGrant(signed({ ...issued, chainId }))).toBeUndefined();
    },
  );

  it("refuses a signed different contract despite a matching edition", () => {
    const issued = createHolderGrant(holder, "7").grant;
    expect(
      readHolderGrant(signed({ ...issued, contractAddress: replacement })),
    ).toBeUndefined();
  });

  it.each(["", "invalid", "0x0000000000000000000000000000000000000000"])(
    "does not issue access credentials for unavailable contract %s",
    (configured) => {
      vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", configured);
      vi.stubEnv("NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS", "");
      expect(() => createHolderGrant(holder, "7")).toThrow();
      expect(() =>
        createHolderChallenge(holder, "7", "https://artfi.example"),
      ).toThrow();
    },
  );

  it("uses the original public configuration fallback with identical scope", () => {
    vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", "");
    vi.stubEnv("NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS", contract);
    const issued = createHolderGrant(holder, "7");
    expect(readHolderGrant(issued.token)).toEqual(issued.grant);
    expect(issued.grant.contractAddress).toBe(contract);
  });
});
