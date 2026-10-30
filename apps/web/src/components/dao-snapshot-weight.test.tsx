import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DaoSnapshotWeight } from "./dao-snapshot-weight";
const render = (input: Partial<Parameters<typeof DaoSnapshotWeight>[0]> = {}) =>
  renderToStaticMarkup(
    <dl>
      <DaoSnapshotWeight
        snapshot={90n}
        snapshotKnown
        weight={10n}
        weightKnown
        authenticated
        {...input}
      />
    </dl>,
  );
describe("selected DAO snapshot weight display", () => {
  it("shows exact small voting power without rounding it to zero", () => {
    const html = render();
    expect(html).toContain("0.00000000000000001");
    expect(html).toContain(">10</code>");
    expect(html).toContain(">90</dd>");
  });
  it("does not fabricate zero voting power from unavailable reads", () => {
    const html = render({ snapshotKnown: false, weightKnown: false });
    expect(html.match(/Unavailable/g)).toHaveLength(2);
    expect(html).not.toContain(">10</code>");
  });
  it("redacts account weight when the current session is absent", () => {
    const html = render({ authenticated: false, weight: 123456789n });
    expect(html).not.toContain("123456789");
    expect(html).toContain(">90</dd>");
    expect(html).toContain("Unavailable");
  });
  it("does not render malformed contract values as an observed weight", () => {
    const html = render({ snapshot: -1n, weight: 1n << 256n });
    expect(html.match(/Unavailable/g)).toHaveLength(2);
    expect(html).not.toContain("-1");
  });
});
