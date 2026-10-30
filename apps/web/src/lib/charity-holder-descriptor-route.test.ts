import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/charity/editions/[tokenId]/holder-asset/route";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  canonicalTokenId: vi.fn(),
  readHolderGrant: vi.fn(),
  grantCoversEdition: vi.fn(),
  resolve: vi.fn(),
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

const asset = {
  tokenId: "1",
  class: "watermarked-holder",
  contentType: "image/jpeg",
  byteLength: 3,
  sha256: "ab".repeat(32),
  objectKey: "test-only/watermarked.jpg",
};
const request = () => new Request("https://example.invalid/api/holder");
const context = () => ({ params: Promise.resolve({ tokenId: "1" }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(
    "ARTFI_CHARITY_EDITIONS_ADDRESS",
    "0x2222222222222222222222222222222222222222",
  );

  vi.stubEnv("ARTFI_CHARITY_HOLDER_ASSET_MANIFEST", "");
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "test-grant" }) });
  mocks.canonicalTokenId.mockReturnValue("1");
  mocks.readHolderGrant.mockReturnValue({ tokenId: "1" });
  mocks.grantCoversEdition.mockReturnValue(true);
  mocks.resolve.mockResolvedValue({ ok: true, asset });
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
];

describe("charity holder descriptor cache boundary", () => {
  it.each(refusals)("keeps $name uncacheable", async (item) => {
    item.setup();
    const response = await GET(request(), context());
    expect(response.status).toBe(item.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(item.expected);
  });

  it("checks the edition before reading holder credentials", async () => {
    mocks.canonicalTokenId.mockReturnValue(undefined);
    await GET(request(), context());
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("checks the edition grant before resolving a descriptor", async () => {
    mocks.grantCoversEdition.mockReturnValue(false);
    await GET(request(), context());
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("preserves the gated descriptor and existing rights disclosure", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="charity-edition-1"',
    );
    expect(await response.json()).toEqual({
      ...asset,
      artworkPreview: "not-provided",
      rights:
        "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
    });
    expect(mocks.resolve).toHaveBeenCalledWith("1", expect.any(Function));
  });
});

describe("holder descriptor original grant at return", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["expired", "changed-token-key"])(
    "holder-descriptor regression refuses %s after resolving a descriptor",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
      vi.stubEnv(
        "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
        "test-only-holder-descriptor-key-not-a-real-credential",
      );
      const auth = await vi.importActual<
        typeof import("./charity-holder-auth")
      >("./charity-holder-auth");
      const issued = auth.createHolderGrant(
        "0x1111111111111111111111111111111111111111",
        "1",
      );
      mocks.cookies.mockResolvedValue({ get: () => ({ value: issued.token }) });
      mocks.readHolderGrant.mockImplementation(auth.readHolderGrant);
      mocks.grantCoversEdition.mockImplementation(auth.grantCoversEdition);
      mocks.resolve.mockImplementation(async () => {
        if (kind === "expired") vi.setSystemTime(issued.grant.expiresAt);
        else
          vi.stubEnv(
            "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
            "different-test-only-descriptor-key-not-a-real-credential",
          );
        return { ok: true, asset };
      });
      const response = await GET(request(), context());
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(asset.objectKey);
    },
  );
  it("returns a still-valid descriptor without another ownership challenge", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(mocks.cookies).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });
});

describe("holder descriptor deployment binding", () => {
  it("does not reveal a descriptor after the configured charity contract changes", async () => {
    vi.stubEnv(
      "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
      "test-only-holder-deployment-descriptor-hmac-key",
    );
    const auth = await vi.importActual<typeof import("./charity-holder-auth")>(
      "./charity-holder-auth",
    );
    const issued = auth.createHolderGrant(
      "0x1111111111111111111111111111111111111111",
      "1",
    );
    mocks.cookies.mockResolvedValue({ get: () => ({ value: issued.token }) });
    mocks.readHolderGrant.mockImplementation(auth.readHolderGrant);
    mocks.grantCoversEdition.mockImplementation(auth.grantCoversEdition);
    mocks.resolve.mockImplementation(async () => {
      vi.stubEnv(
        "ARTFI_CHARITY_EDITIONS_ADDRESS",
        "0x3333333333333333333333333333333333333333",
      );
      return { ok: true, asset };
    });
    const response = await GET(request(), context());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(asset.objectKey);
  });
});
