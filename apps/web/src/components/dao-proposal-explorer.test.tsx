import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicProposalResults } from "./dao-proposal-explorer";
import type { PublicProposalPage } from "@/lib/dao-proposal-discovery";
const page: PublicProposalPage = {
  governor: "0x1000000000000000000000000000000000000001",
  chainId: 560048,
  fromBlock: "10001",
  toBlock: "20000",
  observedBlock: "20001",
  observedBlockHash: "0x" + "a".repeat(64),
  observedAt: 10000,
  proposals: [
    {
      proposalId: "7",
      kind: 1,
      state: 4,
      approvalNumerator: "500000",
      againstVotes: "1",
      forVotes: "9",
      abstainVotes: "2",
      classifiedBlock: "15000",
      classifiedBlockHash: "0x" + "b".repeat(64),
      transactionHash: "0x" + "c".repeat(64),
      logIndex: 0,
    },
  ],
};
describe("public proposal result provenance", () => {
  it("shows observed outcomes with exact event references and no execution action", () => {
    const html = renderToStaticMarkup(
      createElement(PublicProposalResults, { page }),
    );
    for (const text of [
      "Succeeded",
      "500000",
      "Raw vote units",
      page.observedBlockHash,
      page.proposals[0]!.transactionHash,
      "not reserved availability or finality",
      "does not import execution packages",
      "original membership rules",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Vote confirmed");
  });
  it("describes an empty window without denying proposals outside it", () => {
    const html = renderToStaticMarkup(
      createElement(PublicProposalResults, {
        page: { ...page, proposals: [] },
      }),
    );
    expect(html).toContain("Other block ranges have not been searched");
    expect(html).not.toContain("No proposals exist");
  });
});
