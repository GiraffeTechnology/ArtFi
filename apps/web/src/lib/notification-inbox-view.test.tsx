import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxNotice } from "./notification-inbox-state";
import {
  notificationInboxView,
  type NotificationViewFilter,
} from "./notification-inbox-view";
import { NotificationInboxBrowser } from "../components/notification-inbox-browser";

const all: NotificationViewFilter = { read: "all", source: "all", search: "" };
const account = "0x" + "a".repeat(40);
const tx = "0x" + "b".repeat(64);
function notice(index: number, change: Partial<InboxNotice> = {}): InboxNotice {
  return Object.freeze({
    id: index.toString(16).padStart(32, "0"),
    sourceKey: `560048:${tx}:${index}`,
    sourceKind: "chain_event",
    sourceRevision: "3",
    state: "confirmed",
    read: false,
    readAt: null,
    messageCode: "event_confirmed",
    event: Object.freeze({
      transactionHash: tx,
      logIndex: index,
      contractAddress: account,
      eventName: "Transfer",
      blockNumber: "721",
    }),
    text: null,
    ...change,
  });
}
const records = Object.freeze(
  Array.from({ length: 25 }, (_, index) => notice(index)),
);
describe("received notification view", () => {
  it("pages the authoritative source order without mutations", () => {
    const before = JSON.stringify(records);
    const page = notificationInboxView(records, all, 1);
    expect(page.items).toEqual(records.slice(10, 20));
    expect(page.items[0]).toBe(records[10]);
    expect(page).toMatchObject({
      receivedCount: 25,
      matchCount: 25,
      page: 1,
      pageCount: 3,
      first: 11,
      last: 20,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(JSON.stringify(records)).toBe(before);
  });
  it("clamps an old page when a refresh or filter shrinks the received set", () => {
    expect(notificationInboxView(records, all, 999)).toMatchObject({
      page: 2,
      first: 21,
      last: 25,
    });
    expect(notificationInboxView(records.slice(0, 3), all, 2)).toMatchObject({
      page: 0,
      first: 1,
      last: 3,
    });
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "uses the first page for invalid page %s",
    (page) => {
      expect(notificationInboxView(records, all, page).page).toBe(0);
    },
  );
  it("represents no matches as zero records without inventing a history page", () => {
    expect(
      notificationInboxView(records, { ...all, search: "not present" }, 2),
    ).toMatchObject({
      items: [],
      receivedCount: 25,
      matchCount: 0,
      page: 0,
      pageCount: 0,
      first: 0,
      last: 0,
    });
    expect(notificationInboxView([], all, 2).receivedCount).toBe(0);
  });
  it("combines read state, source and message search", () => {
    const read = notice(26, { read: true, readAt: "2026-10-19T19:00:00Z" });
    const system = notice(27, {
      sourceKind: "system_notice",
      sourceKey: "platform:service_notice",
      state: "published",
      messageCode: "service_notice",
      event: null,
      text: "Market maintenance",
    });
    const input = [records[0], read, system];
    expect(
      notificationInboxView(input, { ...all, read: "read" }, 0).items,
    ).toEqual([read]);
    expect(
      notificationInboxView(
        input,
        {
          ...all,
          read: "unread",
          source: "system_notice",
          search: " MAINTENANCE ",
        },
        0,
      ).items,
    ).toEqual([system]);
    expect(
      notificationInboxView(
        input,
        { ...all, read: "read", source: "system_notice" },
        0,
      ).items,
    ).toEqual([]);
  });
  it.each([account.toUpperCase(), tx.toUpperCase(), " transfer ", "721"])(
    "searches exact source metadata case-insensitively: %s",
    (search) => {
      expect(
        notificationInboxView([records[0]], { ...all, search }, 0).items,
      ).toEqual([records[0]]);
    },
  );
  it("preserves removed event and withdrawn notice distinctions", () => {
    const removed = notice(30, {
      state: "removed",
      messageCode: "event_removed",
    });
    const withdrawn = notice(31, {
      sourceKind: "system_notice",
      sourceKey: "platform:service_notice",
      state: "withdrawn",
      messageCode: "service_notice",
      event: null,
      text: null,
    });
    expect(notificationInboxView([removed, withdrawn], all, 0).items).toEqual([
      removed,
      withdrawn,
    ]);
    expect(
      notificationInboxView(
        [removed, withdrawn],
        { ...all, search: "removed" },
        0,
      ).items,
    ).toEqual([removed]);
    expect(
      notificationInboxView(
        [withdrawn],
        { ...all, search: "previous private text" },
        0,
      ).matchCount,
    ).toBe(0);
  });
});

describe("notification browser static render", () => {
  it("shows ten current records, accessible filters and bounded page controls", () => {
    const markRead = vi.fn(async () => {});
    const html = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: records,
        pending: false,
        markRead,
      }),
    );
    expect(html.match(/<li /g)).toHaveLength(10);
    expect(html).toContain('aria-label="Search current notifications"');
    expect(html).toContain("Read status");
    expect(html).toContain("Notification type");
    expect(html).toContain("Showing 1–10 of 25");
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain('disabled="">Previous notifications');
    expect(html).toContain("They do not fetch older history");
    expect(markRead).not.toHaveBeenCalled();
  });
  it("does not render hidden-page records or claim an empty complete history", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: records,
        pending: false,
        markRead: async () => {},
      }),
    );
    expect(html).not.toContain(records[10].sourceKey);
    const empty = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: [],
        pending: false,
        markRead: async () => {},
      }),
    );
    expect(empty).toContain("Showing 0–0 of 0");
    expect(empty).toContain("within the current inbox");
    expect(empty).not.toContain('aria-label="Current notification pages"');
  });
  it("keeps pending mutation acknowledgement disabled while browsing", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: [records[0]],
        pending: true,
        markRead: async () => {},
      }),
    );
    expect(html).toContain('disabled="">Mark read');
    expect(html).not.toContain("Next notifications");
    expect(html).toContain(records[0].sourceKey);
  });
  it("escapes published text and redacts withdrawn messages", () => {
    const published = notice(35, {
      sourceKind: "system_notice",
      sourceKey: "platform:service_notice",
      state: "published",
      messageCode: "service_notice",
      event: null,
      text: "<script>not executable</script>",
    });
    const html = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: [published],
        pending: false,
        markRead: async () => {},
      }),
    );
    expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    const withdrawn = { ...published, state: "withdrawn" as const, text: null };
    const redacted = renderToStaticMarkup(
      createElement(NotificationInboxBrowser, {
        notifications: [withdrawn],
        pending: false,
        markRead: async () => {},
      }),
    );
    expect(redacted).toContain("prior text is no longer displayed");
    expect(redacted).not.toContain("not executable");
    expect(redacted).not.toContain("Mark read");
  });
});
