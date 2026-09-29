import { beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

const holder = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const signature = `0x${"11".repeat(65)}` as Hex;

process.env.ARTFI_CHARITY_HOLDER_SESSION_SECRET = "x".repeat(48);

const {
  canonicalTokenId,
  createHolderChallenge,
  createHolderGrant,
  grantCoversEdition,
  readHolderChallenge,
  readHolderGrant,
  verifyHolderOwnership,
} = await import("./charity-holder-auth");

function reader(options: { signed: boolean; balance: bigint }) {
  return {
    verifyMessage: async () => options.signed,
    balanceOf: async () => options.balance,
  };
}

describe("token id canonicalisation", () => {
  it("accepts decimal ids and rejects everything else", () => {
    expect(canonicalTokenId("1")).toBe("1");
    expect(canonicalTokenId("0042")).toBe("42");
    expect(canonicalTokenId("0")).toBeUndefined();
    expect(canonicalTokenId("-1")).toBeUndefined();
    expect(canonicalTokenId("0x01")).toBeUndefined();
    expect(canonicalTokenId("../master")).toBeUndefined();
    expect(canonicalTokenId(undefined)).toBeUndefined();
  });
});

describe("holder challenge", () => {
  it("binds the token id into the signed text", () => {
    const { challenge } = createHolderChallenge(
      holder,
      "7",
      "https://artfi.example",
    );
    expect(challenge.tokenId).toBe("7");
    expect(challenge.message).toContain("charity edition 7");
    expect(challenge.message).toContain(holder);
    // The message must promise nothing it cannot deliver.
    expect(challenge.message).toContain("grants no rights in the artwork");
  });

  it("round-trips through its signed token", () => {
    const { token } = createHolderChallenge(
      holder,
      "7",
      "https://artfi.example",
    );
    expect(readHolderChallenge(token)?.tokenId).toBe("7");
  });

  it("rejects a tampered token", () => {
    const { token } = createHolderChallenge(
      holder,
      "7",
      "https://artfi.example",
    );
    const [payload, mac] = token.split(".");
    const forged = `${payload}.${mac.slice(0, -2)}aa`;
    expect(readHolderChallenge(forged)).toBeUndefined();
  });

  it("rejects a token whose payload was swapped for another edition", () => {
    const mine = createHolderChallenge(holder, "7", "https://artfi.example");
    const theirs = createHolderChallenge(holder, "8", "https://artfi.example");
    const swapped = `${theirs.token.split(".")[0]}.${mine.token.split(".")[1]}`;
    expect(readHolderChallenge(swapped)).toBeUndefined();
  });

  it("refuses an invalid address or edition", () => {
    expect(() =>
      createHolderChallenge("not-an-address", "7", "https://artfi.example"),
    ).toThrow();
    expect(() =>
      createHolderChallenge(holder, "0", "https://artfi.example"),
    ).toThrow();
  });
});

describe("holder grant", () => {
  it("unlocks only the edition it names", () => {
    const { grant, token } = createHolderGrant(holder, "7");
    expect(grantCoversEdition(grant, "7")).toBe(true);
    expect(grantCoversEdition(grant, "8")).toBe(false);
    expect(readHolderGrant(token)?.address).toBe(holder.toLowerCase());
  });

  it("does not read as a challenge, and a challenge does not read as a grant", () => {
    const { token: grantToken } = createHolderGrant(holder, "7");
    const { token: challengeToken } = createHolderChallenge(
      holder,
      "7",
      "https://artfi.example",
    );
    expect(readHolderChallenge(grantToken)).toBeUndefined();
    expect(readHolderGrant(challengeToken)).toBeUndefined();
  });

  it("treats a missing grant as no access", () => {
    expect(grantCoversEdition(undefined, "7")).toBe(false);
  });
});

describe("ownership verification", () => {
  beforeEach(() => {
    process.env.ARTFI_CHARITY_HOLDER_SESSION_SECRET = "x".repeat(48);
  });

  it("requires both wallet control and a held balance", async () => {
    await expect(
      verifyHolderOwnership(
        holder,
        "7",
        "message",
        signature,
        reader({ signed: true, balance: 1n }),
      ),
    ).resolves.toBe(true);
  });

  it("refuses a valid signature over a wallet that holds nothing", async () => {
    await expect(
      verifyHolderOwnership(
        holder,
        "7",
        "message",
        signature,
        reader({ signed: true, balance: 0n }),
      ),
    ).resolves.toBe(false);
  });

  it("refuses a held balance without a valid signature", async () => {
    await expect(
      verifyHolderOwnership(
        other,
        "7",
        "message",
        signature,
        reader({ signed: false, balance: 5n }),
      ),
    ).resolves.toBe(false);
  });

  it("does not read a balance when the signature fails", async () => {
    let balanceReads = 0;
    await verifyHolderOwnership(holder, "7", "message", signature, {
      verifyMessage: async () => false,
      balanceOf: async () => {
        balanceReads += 1;
        return 1n;
      },
    });
    expect(balanceReads).toBe(0);
  });

  it("fails closed when the chain read throws rather than assuming a holder", async () => {
    await expect(
      verifyHolderOwnership(holder, "7", "message", signature, {
        verifyMessage: async () => true,
        balanceOf: async () => {
          throw new Error("rpc unavailable");
        },
      }),
    ).rejects.toThrow("rpc unavailable");
  });

  it("refuses a malformed edition before touching the chain", async () => {
    let reads = 0;
    const result = await verifyHolderOwnership(
      holder,
      "../master",
      "message",
      signature,
      {
        verifyMessage: async () => {
          reads += 1;
          return true;
        },
        balanceOf: async () => 1n,
      },
    );
    expect(result).toBe(false);
    expect(reads).toBe(0);
  });
});
