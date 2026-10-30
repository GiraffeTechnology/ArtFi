import type { InboxNotice } from "./notification-inbox-state";

export type NotificationViewFilter = Readonly<{
  read: "all" | "unread" | "read";
  source: "all" | InboxNotice["sourceKind"];
  search: string;
}>;

export const notificationPageSize = 10;

/** A view over the received current inbox only, never a history query or an
 * acknowledgement. Preserve authoritative source order and notice identity. */
export function notificationInboxView(
  notices: readonly InboxNotice[],
  filter: NotificationViewFilter,
  requestedPage: number,
) {
  const query = filter.search.trim().toLocaleLowerCase("en-US");
  const matches = notices.filter((notice) => {
    if (filter.read !== "all" && notice.read !== (filter.read === "read"))
      return false;
    if (filter.source !== "all" && notice.sourceKind !== filter.source)
      return false;
    const terms = [
      notice.id,
      notice.sourceKey,
      notice.state,
      notice.event?.eventName,
      notice.event?.transactionHash,
      notice.event?.contractAddress,
      notice.event?.blockNumber,
      // A withdrawn notice never contributes its previous message.
      notice.state === "withdrawn" ? null : notice.text,
    ];
    return (
      !query ||
      terms.some((term) => term?.toLocaleLowerCase("en-US").includes(query))
    );
  });
  const pageCount = Math.ceil(matches.length / notificationPageSize);
  const page = Math.min(
    Number.isSafeInteger(requestedPage) && requestedPage >= 0
      ? requestedPage
      : 0,
    Math.max(0, pageCount - 1),
  );
  const start = page * notificationPageSize;
  return Object.freeze({
    items: Object.freeze(matches.slice(start, start + notificationPageSize)),
    receivedCount: notices.length,
    matchCount: matches.length,
    page,
    pageCount,
    first: matches.length ? start + 1 : 0,
    last: Math.min(start + notificationPageSize, matches.length),
  });
}
