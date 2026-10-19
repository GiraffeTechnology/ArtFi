import { isAddress } from "viem";
import { decodeNativeOrder, type NativeOrder } from "./native-order";

const allowedFilters = new Set([
  "kind",
  "chainId",
  "marketAddress",
  "assetAddress",
  "tokenId",
  "sellerAddress",
  "page",
  "pageSize",
]);
const uint256Max = (1n << 256n) - 1n;

export function validNativeOrderQuery(query: URLSearchParams) {
  for (const key of query.keys()) {
    const values = query.getAll(key);
    if (!allowedFilters.has(key) || values.length !== 1 || !values[0])
      return false;
    const value = values[0];
    if (key.endsWith("Address") && !isAddress(value)) return false;
    if (key === "chainId" && value !== "560048") return false;
    if (key === "kind" && !["whole", "fraction"].includes(value)) return false;
    if (
      key === "tokenId" &&
      (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > uint256Max)
    )
      return false;
    if (
      ["page", "pageSize"].includes(key) &&
      (!/^[1-9][0-9]*$/.test(value) ||
        Number(value) > (key === "pageSize" ? 100 : 1000000))
    )
      return false;
  }
  return true;
}

export type NativeOrderPage = {
  data: NativeOrder[];
  total: number;
  page: number;
  pageSize: number;
};

/** Admit the native index response for the requested page and sale scope.
 * Published terms are observations, not proof that a sale can settle. */
export function readNativeOrderPage(
  value: unknown,
  query: URLSearchParams,
): NativeOrderPage {
  const invalid = () =>
    new Error(
      "The order list response does not match the requested page or sale scope.",
    );
  if (
    !validNativeOrderQuery(query) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw invalid();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    keys.length !== 4 ||
    !["data", "total", "page", "pageSize"].every((key) =>
      Object.hasOwn(row, key),
    )
  )
    throw invalid();
  const page = Number(query.get("page") ?? "1");
  const pageSize = Number(query.get("pageSize") ?? "20");
  if (
    row.page !== page ||
    row.pageSize !== pageSize ||
    typeof row.total !== "number" ||
    !Number.isSafeInteger(row.total) ||
    row.total < 0 ||
    !Array.isArray(row.data) ||
    row.data.length > pageSize
  )
    throw invalid();
  const seen = new Set<string>();
  const matchesAddress = (key: string, actual: string) =>
    !query.has(key) || query.get(key)!.toLowerCase() === actual.toLowerCase();
  const data = row.data.map((value) => {
    const decoded = decodeNativeOrder(value);
    const order = decoded.order;
    const asset =
      decoded.kind === "whole"
        ? decoded.intent.collection
        : decoded.intent.assetToken;
    if (
      (query.has("kind") && query.get("kind") !== order.kind) ||
      (query.has("chainId") &&
        query.get("chainId") !== String(order.chainId)) ||
      !matchesAddress("marketAddress", order.marketAddress) ||
      !matchesAddress("assetAddress", asset) ||
      !matchesAddress("sellerAddress", decoded.intent.seller) ||
      (query.has("tokenId") &&
        (decoded.kind !== "whole" ||
          query.get("tokenId") !== String(decoded.intent.tokenId)))
    )
      throw invalid();
    const identity = `${order.chainId}:${order.marketAddress.toLowerCase()}:${order.intentHash.toLowerCase()}`;
    if (seen.has(identity)) throw invalid();
    seen.add(identity);
    return order;
  });
  // COUNT and SELECT are separate native queries; a concurrent publication can
  // increase the returned rows after the count. Do not invent snapshot semantics.
  return { data, total: row.total, page, pageSize };
}
