import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentOperationHistory } from "./agent-operation-history";
import {
  decodeAgentHistoryPage,
  type AgentHistoryScope,
} from "@/lib/agent-operation-history";
const scope: AgentHistoryScope = {
  kind: "intents",
  id: "TEST_ONLY_op",
  mode: "TEST_ONLY_NO_REAL_VALUE",
  session: {
    id: "TEST_ONLY_session",
    address: "0x" + "a".repeat(40),
    chainId: 560048,
    expiresAt: 4000000000000,
    accessExpiresAt: 4000000000000,
  },
};
describe("private history presentation", () => {
  it("offers cursor navigation and explicitly scoped filters without settlement claims", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      operationId: scope.id,
      state: "PREPARED",
      kind: "PREPARED",
      version: 1,
      observedAt: 1000,
    }));
    const initial = decodeAgentHistoryPage(
      { id: scope.id, mode: scope.mode, events, nextAfter: "100" },
      scope,
    );
    const html = renderToStaticMarkup(
      <AgentOperationHistory initial={initial} scope={scope} />,
    );
    expect(html).toContain("Next history page");
    expect(html).toContain("State filter on this page");
    expect(html).toContain('data-translation-skip="true"');
    expect(html).toContain(
      "not new execution authority or proof of settlement",
    );
    expect(html).not.toContain("No further events were indicated");
  });
  it("describes empty reads without declaring permanent history completion", () => {
    const initial = decodeAgentHistoryPage(
      { id: scope.id, mode: scope.mode, events: [], nextAfter: "0" },
      scope,
    );
    const html = renderToStaticMarkup(
      <AgentOperationHistory initial={initial} scope={scope} />,
    );
    expect(html).toContain("not a permanent end of history");
    expect(html).toContain("No events were returned for this read");
  });
  it("keeps legacy workflow history visibly incomplete", () => {
    const legacy = { ...scope, kind: "actions" };
    const initial = decodeAgentHistoryPage(
      { id: scope.id, mode: scope.mode, events: [] },
      legacy,
    );
    const html = renderToStaticMarkup(
      <AgentOperationHistory initial={initial} scope={legacy} />,
    );
    expect(html).toContain("Only this returned batch is shown");
    expect(html).toContain("complete history is not established");
  });
});
