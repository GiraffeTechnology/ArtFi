"use client";
import { useState } from "react";
import type { InboxNotice } from "@/lib/notification-inbox-state";
import {
  notificationInboxView,
  type NotificationViewFilter,
} from "@/lib/notification-inbox-view";
import styles from "./notification-inbox.module.css";

export function NotificationInboxBrowser({
  notifications,
  pending,
  markRead,
}: {
  notifications: readonly InboxNotice[];
  pending: boolean;
  markRead: (id: string, revision: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<NotificationViewFilter>({
    read: "all",
    source: "all",
    search: "",
  });
  const [requestedPage, setPage] = useState(0);
  const view = notificationInboxView(notifications, filter, requestedPage);
  const changeFilter = (next: NotificationViewFilter) => {
    setFilter(next);
    setPage(0);
  };
  return (
    <div>
      <div
        className="product-actions"
        role="search"
        aria-label="Search current notifications"
      >
        <label>
          Search notifications{" "}
          <input
            type="search"
            maxLength={200}
            value={filter.search}
            placeholder="Message, event, address or transaction"
            onChange={(event) =>
              changeFilter({ ...filter, search: event.target.value })
            }
          />
        </label>
        <label>
          Read status{" "}
          <select
            value={filter.read}
            onChange={(event) => {
              const read = event.target.value;
              if (read === "all" || read === "unread" || read === "read")
                changeFilter({ ...filter, read });
            }}
          >
            <option value="all">All read states</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </label>
        <label>
          Notification type{" "}
          <select
            value={filter.source}
            onChange={(event) => {
              const source = event.target.value;
              if (
                source === "all" ||
                source === "chain_event" ||
                source === "system_notice"
              )
                changeFilter({ ...filter, source });
            }}
          >
            <option value="all">All types</option>
            <option value="chain_event">Transaction alerts</option>
            <option value="system_notice">System messages</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            changeFilter({ read: "all", source: "all", search: "" })
          }
        >
          Reset filters
        </button>
      </div>
      <p role="status" aria-live="polite">
        Showing {view.first}–{view.last} of {view.matchCount} matching
        notifications from {view.receivedCount} received current records.
      </p>
      <p>
        Search and pages apply only to this received inbox. They do not fetch
        older history, change delivery preferences or mark a notification read.
      </p>
      {view.matchCount === 0 ? (
        <p>No notifications match these filters within the current inbox.</p>
      ) : (
        <ul className={styles.list} aria-label="Current notifications">
          {view.items.map((item) => (
            <li key={item.id} className={styles.notice}>
              <div className={styles.heading}>
                <h3>
                  {item.sourceKind === "system_notice"
                    ? "System message"
                    : "Transaction alert"}
                </h3>
                <span>{item.read ? "Read" : "Unread"}</span>
              </div>
              {item.sourceKind === "chain_event" && item.event ? (
                <>
                  <p>
                    {item.state === "removed"
                      ? "This indexed event was removed. A prior acknowledgement does not establish finality."
                      : item.state === "confirmed"
                        ? "The indexed event is confirmed."
                        : "The indexed event is pending confirmation."}
                  </p>
                  <dl
                    className={styles.details}
                    data-no-translate
                    data-translation-skip
                  >
                    <dt>Event</dt>
                    <dd>{item.event.eventName}</dd>
                    <dt>Transaction</dt>
                    <dd>
                      <code>{item.event.transactionHash}</code>
                    </dd>
                    <dt>Contract</dt>
                    <dd>
                      <code>{item.event.contractAddress}</code>
                    </dd>
                    <dt>Log / block</dt>
                    <dd>
                      {item.event.logIndex} / {item.event.blockNumber}
                    </dd>
                    <dt>Source / revision</dt>
                    <dd>
                      <code>{item.sourceKey}</code> / {item.sourceRevision}
                    </dd>
                  </dl>
                </>
              ) : item.state === "withdrawn" ? (
                <p>
                  This system message was withdrawn. Its prior text is no longer
                  displayed.
                </p>
              ) : (
                <p
                  className={styles.message}
                  data-no-translate
                  data-translation-skip
                >
                  {item.text}
                </p>
              )}
              {item.readAt && (
                <p>
                  Read at{" "}
                  <time
                    dateTime={item.readAt}
                    data-no-translate
                    data-translation-skip
                  >
                    {item.readAt}
                  </time>
                </p>
              )}
              {!item.read && item.state !== "withdrawn" && (
                <button
                  type="button"
                  className="wallet-button"
                  disabled={pending}
                  onClick={() => void markRead(item.id, item.sourceRevision)}
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.pageCount > 1 && (
        <nav
          className="product-actions"
          aria-label="Current notification pages"
        >
          <button
            type="button"
            disabled={view.page === 0}
            onClick={() => setPage(view.page - 1)}
          >
            Previous notifications
          </button>
          <span>
            Page {view.page + 1} of {view.pageCount}
          </span>
          <button
            type="button"
            disabled={view.page + 1 >= view.pageCount}
            onClick={() => setPage(view.page + 1)}
          >
            Next notifications
          </button>
        </nav>
      )}
    </div>
  );
}
