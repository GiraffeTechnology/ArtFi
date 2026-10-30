import type { NftPlan } from "./model";
import { equalAddress, NFT_CHAINS } from "./model";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
/** A refreshed authorization check must never silently replace the terms shown to the user. */
export function assertSameNftReview(
  displayed: NftPlan,
  current: NftPlan,
  account: string,
  chainId: number,
) {
  if (
    !["approval", "signature", "transaction"].includes(current.kind) ||
    !Number.isSafeInteger(current.expiresAt) ||
    JSON.stringify(canonical(displayed)) !==
      JSON.stringify(canonical(current)) ||
    !equalAddress(current.request.account, account) ||
    current.chainId !== chainId ||
    NFT_CHAINS[current.scope.chain] !== chainId ||
    current.expiresAt <= Date.now()
  )
    throw new Error(
      "The NFT review, wallet or chain changed. Prepare a fresh review.",
    );
  if (current.kind === "signature") {
    const data = current.typedData;
    if (
      !data ||
      current.transaction !== undefined ||
      data.primaryType !== "OrderComponents" ||
      data.domain.name !== "Seaport" ||
      data.domain.version !== "1.6" ||
      data.domain.chainId !== chainId ||
      !equalAddress(
        data.domain.verifyingContract,
        "0x0000000000000068F116a894984e2DB1123eB395",
      ) ||
      !equalAddress(data.message.offerer, account)
    )
      throw new Error(
        "The signing request does not match the reviewed Seaport order.",
      );
  } else {
    const tx = current.transaction;
    if (
      !tx ||
      current.typedData !== undefined ||
      !equalAddress(tx.to, tx.to) ||
      equalAddress(tx.to, "0x0000000000000000000000000000000000000000") ||
      typeof tx.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2}){4,65536}$/.test(tx.data) ||
      typeof tx.value !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(tx.value) ||
      BigInt(tx.value) >= 1n << 256n
    )
      throw new Error("The reviewed NFT transaction is invalid.");
    if (
      current.kind === "transaction" &&
      !equalAddress(tx.to, "0x0000000000000068F116a894984e2DB1123eB395")
    )
      throw new Error("The NFT settlement target changed.");
    if (current.kind === "approval" && tx.value !== "0")
      throw new Error("An approval cannot send native currency.");
  }
}
