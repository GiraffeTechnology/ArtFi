import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DaoPublishedExecution } from "./dao-published-execution";

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useChainId: () => 560048,
  usePublicClient: () => undefined,
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock("./user-session-provider", () => ({
  useUserSession: () => ({ authenticated: false, revision: 1 }),
}));
describe("published DAO execution entry", () => {
  it("keeps missing deployment bindings explicit", () => {
    const html = renderToStaticMarkup(
      <DaoPublishedExecution deployment={{}} />,
    );
    expect(html).toContain("execution unavailable");
    expect(html).not.toContain("Queue reviewed proposal");
  });
  it("offers a public transaction loader without an automatic wallet action", () => {
    const html = renderToStaticMarkup(
      <DaoPublishedExecution
        deployment={{
          governorAddress: "0x" + "1".repeat(40),
          actionRegistryAddress: "0x" + "2".repeat(40),
          tokenAddress: "0x" + "3".repeat(40),
          vaultAddress: "0x" + "4".repeat(40),
        }}
      />,
    );
    expect(html).toContain("Proposal creation transaction");
    expect(html).toContain("Load published terms");
    expect(html).not.toContain("Queue reviewed proposal");
    expect(html).not.toContain("Execute reviewed proposal");
  });
});
