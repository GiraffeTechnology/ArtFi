import "server-only";
import { readRwaAsset } from "./rwa-catalog-server";
import { rwaAssetIdentity } from "./rwa-catalog";
import { nativeOrderAPIURL } from "./native-order-upstream";
import {
  nativeAnalyticsScope,
  parseNativeMarketAnalytics,
} from "./native-market-analytics";
import { readNativeAnalyticsJSON } from "./native-market-analytics-read";
import { withAdministrationDeadline } from "./administration-transport";

export function readSourceBoundNativeAnalytics(
  slug: string,
  paymentToken: string,
  parent?: AbortSignal,
) {
  return withAdministrationDeadline(async (signal) => {
    const asset = await readRwaAsset(slug);
    signal.throwIfAborted();
    const scope = nativeAnalyticsScope(asset, paymentToken);
    const data = await readNativeAnalyticsJSON(
      nativeOrderAPIURL(
        `/v1/market/native-analytics?${new URLSearchParams(scope)}`,
      ),
      signal,
    );
    signal.throwIfAborted();
    return {
      catalogIdentity: rwaAssetIdentity(asset),
      catalogRevision: asset.revision,
      analytics: parseNativeMarketAnalytics(data, scope),
    };
  }, parent);
}
