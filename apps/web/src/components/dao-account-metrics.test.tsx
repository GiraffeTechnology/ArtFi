import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DaoAccountMetrics } from "./dao-account-metrics";

const data = {
  balance: 197n * 10n ** 18n,
  votes: 148n * 10n ** 18n,
  totalSupply: 1000n * 10n ** 18n,
  balanceKnown: true,
  votesKnown: true,
  supplyKnown: true,
};
describe("DAO personal metrics static output", () => {
  it("hides cached account data outside the authenticated wallet view", () => {
    const html = renderToStaticMarkup(
      <DaoAccountMetrics {...data} authenticated={false} />,
    );
    expect(html.match(/Sign in to view/g)).toHaveLength(3);
    expect(html).not.toContain(">197<");
    expect(html).not.toContain(">148<");
    expect(html).not.toContain("19.7%");
  });
  it("shows successful authenticated reads", () => {
    const html = renderToStaticMarkup(
      <DaoAccountMetrics {...data} authenticated />,
    );
    expect(html).toContain(">197<");
    expect(html).toContain(">148<");
    expect(html).toContain("19.7%");
  });
  it("does not describe failed or pending reads as a successful zero balance", () => {
    const html = renderToStaticMarkup(
      <DaoAccountMetrics
        {...data}
        authenticated
        balanceKnown={false}
        votesKnown={false}
      />,
    );
    expect(html.match(/Unavailable/g)).toHaveLength(3);
    expect(html).not.toContain(">197<");
  });
  it("keeps a successful zero distinct from unknown supply", () => {
    const html = renderToStaticMarkup(
      <DaoAccountMetrics
        {...data}
        authenticated
        balance={0n}
        votes={0n}
        totalSupply={0n}
      />,
    );
    expect(html.match(/>0</g)).toHaveLength(2);
    expect(html).toContain("Unavailable");
  });
});
