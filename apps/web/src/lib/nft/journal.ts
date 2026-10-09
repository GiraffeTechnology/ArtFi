import "server-only";
import { createHash } from "node:crypto";
import { nativeOrderAPIURL, boundedOrderText } from "../native-order-upstream";
import {
  NftError,
  type NftPlan,
  type NftRequest,
  type NftOperationHistory,
} from "./model";
export type NftOperation = {
  id: string;
  wallet: string;
  chainId: number;
  requestHash: string;
  revision: number;
  status: string;
  walletStarted?: boolean;
  plan: NftPlan;
  transactionHash?: string;
  orderHash?: string;
  updatedAt: string;
};
export function nftRequestHash(request: NftRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
export async function nftJournal(
  action: "get" | "create" | "update",
  operation: Partial<NftOperation> & { id: string },
  accessToken: string,
): Promise<NftOperation> {
  const secret = process.env.ARTFI_USER_AUTH_BRIDGE_TOKEN?.trim();
  if (!secret || secret.length < 32)
    throw new NftError(503, "The NFT operation journal is unavailable.");
  const response = await fetch(nativeOrderAPIURL("/v1/nft/operations"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ action, accessToken, operation }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new NftError(
      [401, 403, 404, 409].includes(response.status) ? response.status : 503,
      "The NFT operation could not be verified. Refresh before continuing.",
    );
  }
  const result = JSON.parse(
    await boundedOrderText(response.body, 65536),
  ) as NftOperation;
  if (
    result.id !== operation.id ||
    !result.plan ||
    result.plan.operationId !== result.id ||
    result.plan.chainId !== result.chainId
  )
    throw new NftError(503, "The NFT operation journal returned invalid data.");
  return result;
}

export async function nftOperationHistory(
  accessToken: string,
  page: number,
): Promise<NftOperationHistory> {
  const secret = process.env.ARTFI_USER_AUTH_BRIDGE_TOKEN?.trim();
  if (!secret || secret.length < 32)
    throw new NftError(503, "The NFT operation journal is unavailable.");
  const response = await fetch(
    nativeOrderAPIURL("/v1/nft/operations/history"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ accessToken, page }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new NftError(
      [400, 401, 403].includes(response.status) ? response.status : 503,
      "Private NFT operation history is unavailable.",
    );
  }
  const result = JSON.parse(
    await boundedOrderText(response.body, 131072),
  ) as NftOperationHistory;
  if (
    !Array.isArray(result.data) ||
    result.data.length > 25 ||
    result.page !== page ||
    result.pageSize !== 25 ||
    typeof result.hasMore !== "boolean"
  )
    throw new NftError(503, "The NFT history returned an invalid page.");
  return result;
}
