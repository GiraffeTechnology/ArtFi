import { equalAddress, NFT_CHAINS, type NftScope } from "./model";
import { observeNftCatalogPage, type ObservedNft } from "./catalog";
export type NftOwnedPage = {
  wallet: string;
  chainId: number;
  data: ObservedNft[];
  next: string | null;
  observedAt: string;
};
/** Display only: existing session API authorizes the read; holdings never authorize a wallet action. */
export function readNftOwnedPage(
  raw: unknown,
  scope: NftScope,
  expected: { wallet: string; chainId: number },
): NftOwnedPage {
  const refuse = (): never => {
    throw new Error(
      "The holdings response is invalid or belongs to another wallet, chain or collection. Refresh before using these records.",
    );
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(raw),
    keys = [
      "wallet",
      "chainId",
      "data",
      "next",
      "scope",
      "observedAt",
      "source",
    ];
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value"),
    ) ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    return refuse();
  const body = Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  );
  if (
    !equalAddress(body.wallet, expected.wallet) ||
    body.chainId !== expected.chainId ||
    NFT_CHAINS[scope.chain] !== expected.chainId
  )
    return refuse();
  const data = observeNftCatalogPage(
    {
      data: body.data,
      next: body.next,
      scope: body.scope,
      source: body.source,
      observedAt: body.observedAt,
    },
    scope,
  );
  return {
    wallet: (body.wallet as string).toLowerCase(),
    chainId: expected.chainId,
    data,
    next: body.next as string | null,
    observedAt: body.observedAt as string,
  };
}
