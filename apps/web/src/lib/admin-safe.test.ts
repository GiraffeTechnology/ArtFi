import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import {
  encodeSafeSubmission,
  ownerCheck,
  proposalStage,
  secondsUntilExecutable,
  ZERO_ADDRESS,
  ZERO_REQUEST_ID,
  type SafeTransactionState,
} from "./admin-safe";
import { rwaRegistryAbi } from "./contracts";

const TARGET = "0x1111111111111111111111111111111111111111" as const;
const OWNER = "0x2222222222222222222222222222222222222222" as const;
const SAFE = "0x3333333333333333333333333333333333333333" as const;
const REQUEST_ID =
  "0x00000000000000000000000000000000000000000000000000000000000000aa" as const;
const METADATA_HASH =
  "0x00000000000000000000000000000000000000000000000000000000000000bb" as const;

function submission() {
  return encodeSafeSubmission({
    requestId: REQUEST_ID,
    target: TARGET,
    abi: rwaRegistryAbi,
    functionName: "createAsset",
    args: [REQUEST_ID, OWNER, "ipfs://example", METADATA_HASH],
  });
}

describe("encodeSafeSubmission", () => {
  it("produces calldata the target itself would accept", () => {
    const decoded = decodeFunctionData({
      abi: rwaRegistryAbi,
      data: submission().data,
    });
    expect(decoded.functionName).toBe("createAsset");
    expect(decoded.args).toEqual([
      REQUEST_ID,
      OWNER,
      "ipfs://example",
      METADATA_HASH,
    ]);
  });

  it("never carries ETH value", () => {
    // A proposal that could move the safe's balance turns a mis-encoded argument
    // into a transfer. None of the three operator calls is payable.
    expect(submission().value).toBe(0n);
  });

  it("refuses the zero target", () => {
    expect(() =>
      encodeSafeSubmission({
        requestId: REQUEST_ID,
        target: ZERO_ADDRESS,
        abi: rwaRegistryAbi,
        functionName: "createAsset",
        args: [REQUEST_ID, OWNER, "ipfs://example", METADATA_HASH],
      }),
    ).toThrow(/zero address/i);
  });

  it("refuses a zero request id, which the safe uses as its idempotency key", () => {
    expect(() =>
      encodeSafeSubmission({
        requestId: ZERO_REQUEST_ID,
        target: TARGET,
        abi: rwaRegistryAbi,
        functionName: "createAsset",
        args: [REQUEST_ID, OWNER, "ipfs://example", METADATA_HASH],
      }),
    ).toThrow(/request id/i);
  });
});

describe("proposalStage", () => {
  const base: SafeTransactionState = {
    target: TARGET,
    readyAt: 0n,
    confirmations: 0,
    executed: false,
  };

  it("reports unknown for an absent proposal", () => {
    expect(proposalStage(undefined, 2n, 100n)).toBe("unknown");
  });

  it("reports unknown when the safe returns an empty entry", () => {
    // ArtFiAdminSafe treats a zero target as "no such transaction".
    expect(proposalStage({ ...base, target: ZERO_ADDRESS }, 2n, 100n)).toBe(
      "unknown",
    );
  });

  it("waits for confirmations below the threshold", () => {
    expect(proposalStage({ ...base, confirmations: 1 }, 2n, 100n)).toBe(
      "awaiting-confirmations",
    );
  });

  it("waits for confirmations when the count is met but readyAt is unset", () => {
    // The safe sets readyAt only as the count first reaches the threshold, and
    // clears it when a revocation drops below. Trusting the count alone would
    // report a revoked proposal as merely waiting on the timelock.
    expect(proposalStage({ ...base, confirmations: 2 }, 2n, 100n)).toBe(
      "awaiting-confirmations",
    );
  });

  it("waits for the timelock while readyAt is in the future", () => {
    expect(
      proposalStage({ ...base, confirmations: 2, readyAt: 200n }, 2n, 100n),
    ).toBe("awaiting-timelock");
  });

  it("becomes executable exactly at readyAt, not one second later", () => {
    // ArtFiAdminSafe.execute rejects only while block.timestamp < readyAt.
    expect(
      proposalStage({ ...base, confirmations: 2, readyAt: 200n }, 2n, 200n),
    ).toBe("executable");
  });

  it("reports executed regardless of the clock", () => {
    expect(
      proposalStage(
        { ...base, confirmations: 2, readyAt: 200n, executed: true },
        2n,
        100n,
      ),
    ).toBe("executed");
  });

  it("counts extra confirmations as still executable", () => {
    expect(
      proposalStage({ ...base, confirmations: 5, readyAt: 200n }, 2n, 300n),
    ).toBe("executable");
  });
});

describe("secondsUntilExecutable", () => {
  const state: SafeTransactionState = {
    target: TARGET,
    readyAt: 500n,
    confirmations: 2,
    executed: false,
  };

  it("counts down to readyAt", () => {
    expect(secondsUntilExecutable(state, 440n)).toBe(60n);
  });

  it("is zero once the timelock has elapsed", () => {
    expect(secondsUntilExecutable(state, 500n)).toBe(0n);
    expect(secondsUntilExecutable(state, 900n)).toBe(0n);
  });

  it("is zero while the threshold has not been reached", () => {
    expect(secondsUntilExecutable({ ...state, readyAt: 0n }, 100n)).toBe(0n);
  });
});

describe("ownerCheck", () => {
  it("asks the safe about ownership, not the target about roles", () => {
    // The break this replaces: authenticating with hasRole(role, connectedEOA)
    // against the target, which no wallet can satisfy once the safe holds the role.
    const call = ownerCheck(SAFE, OWNER);
    expect(call.address).toBe(SAFE);
    expect(call.functionName).toBe("isOwner");
    expect(call.args).toEqual([OWNER]);
  });
});
