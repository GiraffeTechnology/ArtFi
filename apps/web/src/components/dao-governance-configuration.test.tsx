import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DaoGovernance, type DaoDeployment } from "./dao-governance";

const calls = vi.hoisted(() => ({
  read: vi.fn(),
  sign: vi.fn(),
  write: vi.fn(),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: undefined,
    isConnected: false,
    status: "disconnected",
  }),
  useChainId: () => 560048,
  usePublicClient: () => undefined,
  useReadContract: (request: unknown) => {
    calls.read(request);
    return { data: undefined, isSuccess: false, refetch: vi.fn() };
  },
  useSignMessage: () => ({
    signMessageAsync: calls.sign,
    isPending: false,
  }),
  useWriteContract: () => ({ writeContractAsync: calls.write }),
}));
vi.mock("./user-session-provider", () => ({
  useUserSession: () => ({
    authenticated: false,
    session: undefined,
    signOutPending: false,
    revision: 1,
  }),
}));
// Offline drafting is independent of this initial on-chain read boundary.
vi.mock("./dao-proposal-draft-workspace", () => ({
  DaoProposalDraftWorkspace: () => null,
}));

const deployment: Required<DaoDeployment> = {
  governorAddress: "0x" + "1".repeat(40),
  tokenAddress: "0x" + "2".repeat(40),
  actionRegistryAddress: "0x" + "3".repeat(40),
  vaultAddress: "0x" + "4".repeat(40),
};
const fields = [
  "governorAddress",
  "tokenAddress",
  "actionRegistryAddress",
  "vaultAddress",
] as const;
type ReadRequest = {
  address?: string;
  functionName: string;
  query?: { enabled?: boolean };
};
function reads(): ReadRequest[] {
  return calls.read.mock.calls.map(([value]) => value as ReadRequest);
}
function unavailable(input: DaoDeployment) {
  const html = renderToStaticMarkup(<DaoGovernance deployment={input} />);
  expect(html).toContain("DAO deployment not configured");
  expect(html).toContain("valid and nonzero");
  expect(reads()).toHaveLength(11);
  expect(reads().every((request) => request.query?.enabled === false)).toBe(
    true,
  );
  expect(reads().every((request) => request.address === undefined)).toBe(true);
  expect(calls.sign).not.toHaveBeenCalled();
  expect(calls.write).not.toHaveBeenCalled();
}

describe("DAO initial deployment read availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(fields)("refuses a zero %s before enabling reads", (field) => {
    unavailable({
      ...deployment,
      [field]: "0x" + "0".repeat(40),
    });
  });

  it.each(fields)("refuses a missing %s before enabling reads", (field) => {
    const partial: DaoDeployment = { ...deployment };
    delete partial[field];
    unavailable(partial);
  });

  it.each(fields)("refuses an invalid %s before enabling reads", (field) => {
    unavailable({
      ...deployment,
      [field]: "invalid-public-deployment-address",
    });
  });

  it("keeps an empty configuration unavailable", () => {
    unavailable({});
  });

  it("retains the existing exact four-field deployment shape", () => {
    const extra = { ...deployment, unexpected: deployment.governorAddress };
    unavailable(extra);
  });

  it("preserves public reads for a valid configuration without a wallet login", () => {
    const html = renderToStaticMarkup(
      <DaoGovernance deployment={deployment} />,
    );
    expect(html).not.toContain("DAO deployment not configured");
    expect(reads()).toHaveLength(11);
    const enabled = reads()
      .filter((request) => request.query?.enabled === true)
      .map((request) => request.functionName)
      .sort();
    expect(enabled).toEqual([
      "proposalThreshold",
      "rwaEligible",
      "totalSupply",
    ]);
    for (const request of reads().filter(
      (request) => request.query?.enabled === true,
    )) {
      expect(request.address).toBe(
        request.functionName === "totalSupply"
          ? deployment.tokenAddress
          : deployment.governorAddress,
      );
    }
    expect(calls.sign).not.toHaveBeenCalled();
    expect(calls.write).not.toHaveBeenCalled();
  });
});
