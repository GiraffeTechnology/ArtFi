import { describe, expect, it } from "vitest";

import { freshness, shortOrderId, venueLabel, venueLink } from "./market-links";

describe("venueLink", () => {
  const listing = "https://opensea.io/assets/ethereum/0xabc/1";

  it("returns an attributed OpenSea listing unchanged in substance", () => {
    expect(venueLink("opensea", listing)).toBe(listing);
  });

  it("refuses any scheme but HTTPS", () => {
    expect(venueLink("opensea", "http://opensea.io/assets/x")).toBeUndefined();
    // The one that matters: a scheme that executes rather than navigates.
    expect(venueLink("opensea", "javascript:alert(1)")).toBeUndefined();
    expect(venueLink("opensea", "data:text/html,<script>")).toBeUndefined();
  });

  it("refuses embedded credentials", () => {
    expect(
      venueLink("opensea", "https://user:pass@opensea.io/assets/x"),
    ).toBeUndefined();
  });

  it("refuses a lookalike or subdomain host", () => {
    for (const host of [
      "opensea.io.example.com",
      "notopensea.io",
      "evil.opensea.io.attacker.net",
      "xn--opensea-1234.io",
    ]) {
      expect(venueLink("opensea", `https://${host}/assets/x`)).toBeUndefined();
    }
  });

  it("refuses a source with no allowlisted host", () => {
    expect(venueLink("blur", listing)).toBeUndefined();
    expect(venueLink("", listing)).toBeUndefined();
  });

  it("refuses an absent or unparseable URL rather than guessing one", () => {
    expect(venueLink("opensea", undefined)).toBeUndefined();
    expect(venueLink("opensea", "")).toBeUndefined();
    expect(venueLink("opensea", "not a url")).toBeUndefined();
  });
});

describe("venueLabel", () => {
  it("names the venue the way a reader would", () => {
    expect(venueLabel("opensea")).toBe("OpenSea");
  });

  it("passes an unknown source through rather than inventing a name", () => {
    expect(venueLabel("somewhere-else")).toBe("somewhere-else");
  });
});

describe("shortOrderId", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("shortens a well-formed order hash", () => {
    expect(shortOrderId(hash)).toBe("0xabababab…ababab");
  });

  it("shows nothing for a malformed or absent hash", () => {
    expect(shortOrderId(undefined)).toBeUndefined();
    expect(shortOrderId("0xdeadbeef")).toBeUndefined();
    expect(shortOrderId(`0x${"zz".repeat(32)}`)).toBeUndefined();
  });
});

describe("freshness", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");
  const at = (iso: string) => freshness(iso, now);

  it("reports recent observations in the coarsest honest unit", () => {
    expect(at("2026-09-19T11:59:30.000Z")).toBe("Under a minute ago");
    expect(at("2026-09-19T11:59:00.000Z")).toBe("1 minute ago");
    expect(at("2026-09-19T11:46:00.000Z")).toBe("14 minutes ago");
    expect(at("2026-09-19T09:00:00.000Z")).toBe("3 hours ago");
    expect(at("2026-09-16T12:00:00.000Z")).toBe("3 days ago");
  });

  it("surfaces a source clock ahead of ours instead of rounding it away", () => {
    expect(at("2026-09-19T12:05:00.000Z")).toBe("Source clock ahead");
  });

  it("says freshness is unknown rather than implying it is current", () => {
    expect(freshness(undefined, now)).toBe("Freshness unknown");
    expect(at("not a timestamp")).toBe("Freshness unknown");
  });
});
