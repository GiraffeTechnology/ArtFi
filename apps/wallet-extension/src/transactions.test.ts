import { describe, expect, it } from "vitest";

import { PermissionController } from "./permissions.js";
import { ConfirmationController, SUPPORTED_CHAIN_ID } from "./transactions.js";

const origin = "https://app.artfi.test";
const transaction = {
  from: "0x1111111111111111111111111111111111111111" as const,
  to: "0x2222222222222222222222222222222222222222" as const,
  value: "0x0" as const,
  data: "0x1234" as const,
  chainId: SUPPORTED_CHAIN_ID,
};

describe("transaction confirmation boundary", () => {
  it("requires origin permission, Hoodi, fresh simulation, and one-time approval", () => {
    const permissions = new PermissionController();
    permissions.grant(origin, ["eth_sendTransaction"], 1_000, 60_000);
    const confirmations = new ConfirmationController(permissions);
    const pending = confirmations.prepare(
      origin,
      transaction,
      {
        chainId: SUPPORTED_CHAIN_ID,
        status: "success",
        requestHash: "0x1234",
        expiresAt: 31_000,
      },
      2_000,
    );
    expect(confirmations.approve(pending.id, origin, 3_000)).toEqual(pending);
    expect(() => confirmations.approve(pending.id, origin, 3_001)).toThrow(
      /missing/,
    );
  });

  it("rejects unsupported chains, stale simulations, and cross-origin approval", () => {
    const permissions = new PermissionController();
    permissions.grant(origin, ["eth_sendTransaction"], 1_000, 60_000);
    permissions.grant(
      "https://other.artfi.test",
      ["eth_sendTransaction"],
      1_000,
      60_000,
    );
    const confirmations = new ConfirmationController(permissions);
    expect(() =>
      confirmations.prepare(
        origin,
        { ...transaction, chainId: 1 },
        {
          chainId: 1,
          status: "success",
          requestHash: "0x12",
          expiresAt: 30_000,
        },
        2_000,
      ),
    ).toThrow(/Hoodi-only/);
    const pending = confirmations.prepare(
      origin,
      transaction,
      {
        chainId: SUPPORTED_CHAIN_ID,
        status: "success",
        requestHash: "0x12",
        expiresAt: 30_000,
      },
      2_000,
    );
    expect(() =>
      confirmations.approve(pending.id, "https://other.artfi.test", 3_000),
    ).toThrow(/another origin/);
  });
});
