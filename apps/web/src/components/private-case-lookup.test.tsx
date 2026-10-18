import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PrivateCaseLookup } from "./private-case-lookup";

describe("private case lookup control", () => {
  it("starts with no private response or request and does not offer a moderation mutation", () => {
    const onOpen = vi.fn(),
      onDenied = vi.fn(),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const html = renderToStaticMarkup(
        createElement(PrivateCaseLookup, {
          session: {
            id: "TEST_ONLY-session",
            address: "0x1111111111111111111111111111111111111111",
            chainId: 560048,
            expiresAt: 4000000000000,
            accessExpiresAt: 4000000000000,
          },
          onOpen,
          onDenied,
          disabled: false,
        }),
      );
      expect(html).toContain("Open a case by ID");
      expect(html).toContain("independently of the current list page");
      expect(html).toMatch(/autocomplete="off"/i);
      expect(html).toContain("original case revision and eligibility rules");
      expect(html).not.toContain("Submit appeal");
      expect(html).not.toContain("TEST_ONLY private report");
      expect(fetch).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(onDenied).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
