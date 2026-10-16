import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DaoPresentationCard, DaoPresentationFields } from "./dao-presentation";
describe("DAO presentation interface", () => {
  it("renders configurable fields without adding an upload or image request", () => {
    const html = renderToStaticMarkup(<DaoPresentationFields />);
    expect(html).toContain('name="daoPresentation"');
    expect(html).toContain('name="daoDescription"');
    expect(html).toContain('name="daoAvatarPalette"');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("<img");
  });
  it("renders descriptions as text while keeping the rights boundary visible", () => {
    const html = renderToStaticMarkup(
      <DaoPresentationCard
        name="Example"
        symbol="TEST"
        presentation={{
          version: 1,
          description: "<script>TEST_ONLY</script>",
          avatar: { text: "DAO", palette: "teal" },
        }}
      />,
    );
    expect(html).toContain("&lt;script&gt;TEST_ONLY&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      "custody, roles and membership are verified separately",
    );
  });
});
