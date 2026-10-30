import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/nft/[action]/route";
import { NftError } from "./model";
const state = vi.hoisted(() => ({
  auth: vi.fn(),
  owned: vi.fn(),
  api: vi.fn(),
}));
vi.mock("../user-auth", async (original) => ({
  ...(await original<typeof import("../user-auth")>()),
  requireUserSession: state.auth,
}));
vi.mock("./venue", async (original) => ({
  ...(await original<typeof import("./venue")>()),
  nftAPI: state.api,
}));
const account = "0x1111111111111111111111111111111111111111";
const scope = {
  slug: "isolated-digital",
  chain: "ethereum",
  contract: "0x2222222222222222222222222222222222222222",
  standard: "erc1155",
  label: "Isolated",
  charity: true,
};
const nft = {
  identifier: "7",
  contract: scope.contract,
  collection: scope.slug,
  tokenStandard: scope.standard,
  name: "Private owned edition",
};
async function get(
  query = new URLSearchParams({ collection: scope.slug, account }),
) {
  return GET(new Request(`https://artfi.example/api/nft/owned?${query}`), {
    params: Promise.resolve({ action: "owned" }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ARTFI_NFT_COLLECTIONS_JSON", JSON.stringify([scope]));
  state.auth.mockResolvedValue({
    session: { address: account, chainId: 1 },
    accessToken: "isolated",
  });
  state.api.mockReturnValue({ nfts: { getNFTsByAccount: state.owned } });
  state.owned.mockResolvedValue({ nfts: [nft], next: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("private NFT holdings boundary", () => {
  it("authenticates owner and collection chain before accessing the venue", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.auth).toHaveBeenCalledWith(account, 1);
    expect(state.owned).toHaveBeenCalledWith(
      account,
      24,
      undefined,
      "ethereum",
    );
    expect(await response.json()).toMatchObject({
      wallet: account,
      chainId: 1,
      source: "opensea",
      data: [{ tokenId: "7", name: "Private owned edition" }],
    });
  });
  it.each([401, 403])(
    "does not access private holdings after auth failure %s",
    async (status) => {
      state.auth.mockRejectedValue(
        new NftError(status, "Sign in with this wallet."),
      );
      expect((await get()).status).toBe(status);
      expect(state.api).not.toHaveBeenCalled();
      expect(state.owned).not.toHaveBeenCalled();
    },
  );
  it("filters other contracts and collections without exposing unrelated wallet items", async () => {
    state.owned.mockResolvedValue({
      nfts: [
        nft,
        { ...nft, contract: account },
        { ...nft, collection: "unrelated" },
      ],
      next: "next-isolated",
    });
    expect(await (await get()).json()).toMatchObject({
      data: [{ tokenId: "7" }],
      next: "next-isolated",
    });
  });
  it("does not interpret an empty filtered page as complete zero holdings", async () => {
    state.owned.mockResolvedValue({
      nfts: [{ ...nft, collection: "unrelated" }],
      next: "more",
    });
    expect(await (await get()).json()).toMatchObject({
      data: [],
      next: "more",
    });
  });
  it("rejects duplicate identity and unsupported query fields before auth", async () => {
    const query = new URLSearchParams({ collection: scope.slug, account });
    query.append("account", account);
    expect((await get(query)).status).toBe(400);
    expect(state.auth).not.toHaveBeenCalled();
  });
  it("bounds pagination before requesting holdings", async () => {
    expect(
      (
        await get(
          new URLSearchParams({
            collection: scope.slug,
            account,
            cursor: "a".repeat(2049),
          }),
        )
      ).status,
    ).toBe(400);
    expect(state.owned).not.toHaveBeenCalled();
  });
});
