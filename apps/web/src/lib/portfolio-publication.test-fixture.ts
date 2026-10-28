import type { Address } from "viem";
import {
  nativeOrderFromAuthorization,
  type NativeOrderKind,
} from "./native-order";

export const publicationSeller =
  "0x1000000000000000000000000000000000000001" as Address;
export const publicationAsset =
  "0x1000000000000000000000000000000000000002" as Address;
export const publicationMarket =
  "0x1000000000000000000000000000000000000003" as Address;

/** TEST_ONLY unsigned-format publication data, not a grant or executable sale. */
export function publicationOrder({
  kind = "whole",
  salt = "1",
  seller = publicationSeller,
}: { kind?: NativeOrderKind; salt?: string; seller?: Address } = {}) {
  return {
    ...nativeOrderFromAuthorization(
      kind,
      JSON.stringify({
        intent: {
          seller,
          paymentToken: publicationAsset,
          buyer: "0x0000000000000000000000000000000000000000",
          salt,
          startsAt: 1000,
          endsAt: 2000,
          epoch: "0",
          ...(kind === "whole"
            ? {
                collection: publicationAsset,
                tokenId: "7",
                price: "900719925474099300000001",
              }
            : {
                assetToken: publicationAsset,
                maxAmount: "900719925474099300000001",
                unitPrice: "41",
              }),
        },
        signature: "0x",
      }),
      publicationMarket,
    ),
    createdAt: "2026-10-28T00:00:00Z",
  };
}
export function publicationPage() {
  return { data: [publicationOrder()], total: 1, page: 1, pageSize: 10 };
}
