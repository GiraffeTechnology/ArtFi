import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributedNftURL,
  NftVenueRejection,
  safeNft,
  venueFetch,
} from "./venue";
import type { NftScope } from "./model";
afterEach(() => vi.unstubAllGlobals());
describe("venue attribution and bounded HTTP outcomes", () => {
  it("preserves an actual venue URL as data", () => {
    const url =
      "https://opensea.io/assets/ethereum/0x2222222222222222222222222222222222222222/7";
    expect(attributedNftURL(url)).toBe(url);
    const scope: NftScope = {
      slug: "isolated",
      chain: "ethereum",
      contract: "0x2222222222222222222222222222222222222222",
      standard: "erc721",
      label: "Isolated",
      charity: false,
    };
    expect(
      safeNft(
        {
          identifier: "7",
          contract: scope.contract,
          collection: scope.slug,
          tokenStandard: "erc721",
          openseaUrl: url,
        },
        scope,
      ).sourceURL,
    ).toBe(url);
  });
  it.each([
    "http://opensea.io/asset",
    "https://opensea.io.evil.example/a",
    "https://user:password@opensea.io/a",
    "javascript:alert(1)",
  ])("rejects unsafe attribution %s", (value) =>
    expect(attributedNftURL(value)).toBeUndefined(),
  );
  it("does not echo upstream rejection body", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("private upstream detail", { status: 422 }),
    );
    await expect(
      venueFetch("submit")(
        "https://api.opensea.io/api/v2/orders/ethereum/seaport/listings",
        { method: "POST" },
      ),
    ).rejects.toBeInstanceOf(NftVenueRejection);
  });
  it("keeps ambiguous upstream server failures distinct from explicit rejection", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("unavailable", { status: 503 }),
    );
    try {
      await venueFetch("submit")(
        "https://api.opensea.io/api/v2/orders/ethereum/seaport/listings",
        { method: "POST" },
      );
      throw Error("unexpected success");
    } catch (error) {
      expect(error).not.toBeInstanceOf(NftVenueRejection);
      expect(error).toMatchObject({ status: 503 });
    }
  });
});
