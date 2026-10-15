import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/charity/editions/[tokenId]/holder-asset/file/route";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  canonicalTokenId: vi.fn(),
  readHolderGrant: vi.fn(),
  grantCoversEdition: vi.fn(),
  resolve: vi.fn(),
  fetchObject: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/charity-holder-auth", () => ({
  canonicalTokenId: mocks.canonicalTokenId,
  holderGrantCookie: "test-holder-grant",
  readHolderGrant: mocks.readHolderGrant,
  grantCoversEdition: mocks.grantCoversEdition,
}));
vi.mock("@/lib/charity-assets", () => ({
  resolveHolderAsset: mocks.resolve,
}));
vi.mock("@/lib/charity-object-store", () => ({
  fetchHolderObject: mocks.fetchObject,
}));

const asset = { tokenId: "1", contentType: "image/jpeg" };
const bytes = new Uint8Array([1, 2, 3]);
const request = () => new Request("https://example.invalid/api/holder-file");
const context = () => ({ params: Promise.resolve({ tokenId: "1" }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ARTFI_CHARITY_HOLDER_ASSET_MANIFEST", "");
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "test-grant" }) });
  mocks.canonicalTokenId.mockReturnValue("1");
  mocks.readHolderGrant.mockReturnValue({ tokenId: "1" });
  mocks.grantCoversEdition.mockReturnValue(true);
  mocks.resolve.mockResolvedValue({ ok: true, asset });
  mocks.fetchObject.mockResolvedValue({ ok: true, bytes });
});
afterEach(() => vi.unstubAllEnvs());

const refusals: {
  name: string;
  status: number;
  setup: () => void;
  expected: Record<string, string>;
}[] = [
  {
    name: "invalid edition",
    status: 404,
    setup: () => mocks.canonicalTokenId.mockReturnValue(undefined),
    expected: { detail: "Unknown charity edition." },
  },
  {
    name: "unverified holder",
    status: 401,
    setup: () => mocks.grantCoversEdition.mockReturnValue(false),
    expected: {
      detail:
        "Verify ownership of this charity edition to receive the watermarked file.",
    },
  },
  {
    name: "invalid private manifest",
    status: 503,
    setup: () => {
      vi.stubEnv("ARTFI_CHARITY_HOLDER_ASSET_MANIFEST", "{");
    },
    expected: { detail: "Charity holder delivery is unavailable." },
  },
  {
    name: "unknown resolved edition",
    status: 404,
    setup: () =>
      mocks.resolve.mockResolvedValue({
        ok: false,
        refusal: "unknown-edition",
      }),
    expected: { detail: "Unknown charity edition." },
  },
  {
    name: "master boundary refusal",
    status: 409,
    setup: () =>
      mocks.resolve.mockResolvedValue({
        ok: false,
        refusal: "master-digest-collision",
      }),
    expected: {
      detail:
        "The holder file for this edition failed the master boundary and was not served.",
      refusal: "master-digest-collision",
    },
  },
  {
    name: "unconfigured private store",
    status: 503,
    setup: () =>
      mocks.fetchObject.mockResolvedValue({
        ok: false,
        refusal: "not-configured",
      }),
    expected: {
      detail:
        "Watermarked holder delivery is not configured in this environment.",
      refusal: "not-configured",
    },
  },
  {
    name: "unreachable private store",
    status: 503,
    setup: () =>
      mocks.fetchObject.mockResolvedValue({
        ok: false,
        refusal: "unreachable",
      }),
    expected: {
      detail: "The holder file could not be read.",
      refusal: "unreachable",
    },
  },
  {
    name: "object digest or size mismatch",
    status: 409,
    setup: () =>
      mocks.fetchObject.mockResolvedValue({
        ok: false,
        refusal: "digest-mismatch",
      }),
    expected: {
      detail:
        "The stored file did not match its reviewed descriptor and was not served.",
      refusal: "digest-mismatch",
    },
  },
];

describe("charity holder file cache boundary", () => {
  it.each(refusals)("keeps $name uncacheable", async (item) => {
    item.setup();
    const response = await GET(request(), context());
    expect(response.status).toBe(item.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(item.expected);
  });

  it("checks edition and holder before object access", async () => {
    mocks.canonicalTokenId.mockReturnValue(undefined);
    await GET(request(), context());
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchObject).not.toHaveBeenCalled();

    mocks.canonicalTokenId.mockReturnValue("1");
    mocks.grantCoversEdition.mockReturnValue(false);
    await GET(request(), context());
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.fetchObject).not.toHaveBeenCalled();
  });

  it("keeps master boundary refusals ahead of object access", async () => {
    mocks.resolve.mockResolvedValue({
      ok: false,
      refusal: "master-digest-collision",
    });
    await GET(request(), context());
    expect(mocks.fetchObject).not.toHaveBeenCalled();
  });

  it("preserves the watermarked attachment response", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="artfi-charity-edition-1-watermarked"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.fetchObject).toHaveBeenCalledWith(asset);
  });
});
