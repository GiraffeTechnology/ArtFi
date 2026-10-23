import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeOrderAPIURL, boundedOrderText } from "../native-order-upstream";
import {
  NftError,
  NFT_CHAINS,
  equalAddress,
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
  // Keep the original readNftRequest wire order after MySQL JSON key normalization.
  // Values and expired review terms are retained, never reauthorized or rewritten.
  const required = [
    "action", "collection", "tokenId", "account", "quantity", "priceWei", "expiresAt",
  ];
  if (
    required.some((key) => !Object.hasOwn(request, key)) ||
    Object.keys(request).some((key) => ![...required, "orderHash"].includes(key))
  )
    throw new NftError(503, "The NFT journal request fields changed.");
  const ordered: NftRequest = {
    action: request.action,
    collection: request.collection,
    tokenId: request.tokenId,
    account: request.account,
    quantity: request.quantity,
    priceWei: request.priceWei,
    expiresAt: request.expiresAt,
    ...(Object.hasOwn(request, "orderHash") ? { orderHash: request.orderHash } : {}),
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
const journalStatuses = new Set([
  "awaiting-wallet",
  "submitted",
  "pending",
  "accepted",
  "cancelled",
  "rejected",
  "failed",
  "confirmed",
]);
const journalKeys = [
  "id",
  "wallet",
  "chainId",
  "requestHash",
  "revision",
  "status",
  "walletStarted",
  "plan",
  "transactionHash",
  "orderHash",
  "updatedAt",
];
const prohibitedJournalKeys = new Set([
  "privatekey",
  "seedphrase",
  "mnemonic",
  "rawtransaction",
  "signedtransaction",
  "rawsignedtransaction",
  "signedrawtransaction",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "capability",
  "password",
  "secret",
]);
function journalObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function unsignedJournal(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(unsignedJournal);
  if (journalObject(value))
    return Object.entries(value).every(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        !normalized.includes("signature") &&
        !prohibitedJournalKeys.has(normalized) &&
        unsignedJournal(child)
      );
    });
  return true;
}
function checkedJournalResult(
  value: unknown,
  action: "get" | "create" | "update",
  submitted: Partial<NftOperation> & { id: string },
): NftOperation {
  const refuse = (): never => {
    throw new NftError(
      503,
      "The NFT journal returned an invalid or changed operation. Read its durable state before retrying.",
    );
  };
  if (!journalObject(value)) return refuse();
  const row = value as unknown as NftOperation;
  const plan = row.plan;
  if (
    Object.keys(value).some((key) => !journalKeys.includes(key)) ||
    row.id !== submitted.id ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(row.id) ||
    !Number.isSafeInteger(row.chainId) ||
    ![1, 8453].includes(row.chainId) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !journalStatuses.has(row.status) ||
    typeof row.walletStarted !== "boolean" ||
    typeof row.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.requestHash) ||
    typeof row.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      row.updatedAt,
    ) ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    new Date(row.updatedAt).toISOString().slice(0, 19) !==
      row.updatedAt.slice(0, 19) ||
    !journalObject(plan) ||
    plan.operationId !== row.id ||
    plan.chainId !== row.chainId ||
    typeof plan.id !== "string" ||
    !plan.id ||
    typeof plan.sessionId !== "string" ||
    !plan.sessionId ||
    "taskPrincipal" in plan ||
    !["signature", "approval", "transaction"].includes(plan.kind) ||
    !journalObject(plan.request) ||
    !equalAddress(plan.request.account, row.wallet) ||
    !journalObject(plan.scope) ||
    !Object.hasOwn(NFT_CHAINS, plan.scope.chain) ||
    NFT_CHAINS[plan.scope.chain] !== row.chainId ||
    plan.request.collection !== plan.scope.slug ||
    nftRequestHash(plan.request) !== row.requestHash ||
    (row.transactionHash !== undefined &&
      (typeof row.transactionHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(row.transactionHash))) ||
    (row.orderHash !== undefined &&
      (typeof row.orderHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(row.orderHash))) ||
    !unsignedJournal(row)
  )
    refuse();
  if (
    action !== "get" &&
    (!equalAddress(row.wallet, submitted.wallet) ||
      row.chainId !== submitted.chainId ||
      row.requestHash !== submitted.requestHash ||
      (action === "update" &&
        (row.revision !== Number(submitted.revision) + 1 ||
          row.status !== submitted.status ||
          row.walletStarted !== submitted.walletStarted ||
          !isDeepStrictEqual(row.plan, submitted.plan) ||
          row.transactionHash !== submitted.transactionHash ||
          row.orderHash !== submitted.orderHash)))
  )
    refuse();
  // A create may return an existing record. Its original plan/session/revision
  // must survive same-wallet recovery; only an update requires exact new CAS.
  return structuredClone(row);
}

export async function nftJournal(
  action: "get" | "create" | "update",
  operation: Partial<NftOperation> & { id: string },
  accessToken: string,
): Promise<NftOperation> {
  const secret = process.env.ARTFI_USER_AUTH_BRIDGE_TOKEN?.trim();
  if (!secret || secret.length < 32)
    throw new NftError(503, "The NFT operation journal is unavailable.");
  // Capture exactly the JSON sent, so a caller cannot change its identity while awaiting a response.
  const submitted = JSON.parse(
    JSON.stringify(operation),
  ) as Partial<NftOperation> & { id: string };
  let response: Response;
  try {
    response = await fetch(nativeOrderAPIURL("/v1/nft/operations"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ action, accessToken, operation: submitted }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    throw new NftError(
      503,
      "The NFT journal outcome is unavailable or unknown. Read its durable state before retrying.",
      { cause: error },
    );
  }
  if (!response.ok) {
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      /* Preserve the known refusal status. */
    }
    throw new NftError(
      [401, 403, 404, 409].includes(response.status) ? response.status : 503,
      "The NFT operation could not be verified. Refresh before continuing.",
    );
  }
  try {
    return checkedJournalResult(
      JSON.parse(await boundedOrderText(response.body, 65536)),
      action,
      submitted,
    );
  } catch (error) {
    if (error instanceof NftError) throw error;
    throw new NftError(
      503,
      "The NFT journal outcome is unavailable or unknown. Read its durable state before retrying.",
      { cause: error },
    );
  }
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
