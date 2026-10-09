import { describe, expect, it } from "vitest";
import {
  validAgentRuntimeStatus,
  validAgentOperation,
  agentMode,
} from "./agent-runtime-client";
import type { UserSession } from "./user-session-client-state";
const session: UserSession = {
  id: "session",
  address: `0x${"a".repeat(40)}`,
  chainId: 560048,
  expiresAt: 1000,
  accessExpiresAt: 900,
};
const status = {
  schemaVersion: 1,
  mode: agentMode,
  productionReady: false,
  state: "SAFE_DEGRADED",
  adapterKind: "unavailable",
  walletProtocol: "NOT_CONFIRMED",
  capabilities: {
    prepareIntent: false,
    createIntent: false,
    queryIntent: true,
    recordRevocation: false,
    history: true,
    signIntent: false,
    revokeNonce: false,
  },
  actions: [],
  constitutionalMutations: false,
  privateKeyCustody: false,
  limitations: [],
  observedAt: 10,
};
describe("bounded agent client evidence", () => {
  it("does not promote fixture or unverified wallet capability to production", () => {
    expect(validAgentRuntimeStatus(status)).toBe(true);
    expect(validAgentRuntimeStatus({ ...status, productionReady: true })).toBe(
      false,
    );
    expect(
      validAgentRuntimeStatus({
        ...status,
        capabilities: { ...status.capabilities, signIntent: true },
      }),
    ).toBe(false);
  });
  it("settlement needs canonical accounting reconciliation and current owner session", () => {
    const record = {
      id: "op",
      mode: agentMode,
      intent: { wallet: session.address },
      asset: { chainId: "560048", contract: session.address, tokenId: "1" },
      execution: { state: "SETTLED", canonical: true },
      grounding: { state: "UNVERIFIED" },
      reconciliation: { state: "MATCHED", accountingMatches: true },
      recovery: { state: "RECOVERED" },
      revocation: { state: "NOT_REQUESTED" },
      fresh: false,
      observedAt: 10,
    };
    expect(validAgentOperation(record, "op", session)).toBe(true);
    expect(
      validAgentOperation(
        { ...record, execution: { state: "SETTLED", canonical: false } },
        "op",
        session,
      ),
    ).toBe(false);
    expect(validAgentOperation(record, "wrong", session)).toBe(false);
  });
});
