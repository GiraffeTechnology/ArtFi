import {
  administrationText,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "./administration-transport";
import { NativeAnalyticsError } from "./native-market-analytics";
export const nativeAnalyticsByteLimit = 196_608;

/** Shared bounded read only. No identity, cookies, credentials or mutation. */
export function readNativeAnalyticsJSON(
  url: URL | string,
  parent?: AbortSignal,
): Promise<unknown> {
  return withAdministrationDeadline(async (signal) => {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (signal.aborted) {
      discardAdministrationBody(response);
      signal.throwIfAborted();
    }
    try {
      if (
        !response.ok ||
        response.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new NativeAnalyticsError("unavailable");
      return JSON.parse(
        await administrationText(response, nativeAnalyticsByteLimit, signal),
      ) as unknown;
    } finally {
      if (!response.bodyUsed) discardAdministrationBody(response);
    }
  }, parent);
}
