import type { Page, Request } from "@playwright/test";

/** Bind evidence to a completed request, not headers from a canceled mount. */
export async function waitForFinishedJson(
  page: Pick<Page, "waitForEvent">,
  predicate: (request: Request) => boolean,
) {
  const request = await page.waitForEvent("requestfinished", { predicate });
  const response = await request.response();
  if (!response) throw new Error("Completed request has no response.");
  return { status: response.status(), body: await response.json() };
}
