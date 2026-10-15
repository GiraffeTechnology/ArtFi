export type NotificationIdentity = Readonly<{
  address: string;
  chainId: number;
  sessionId: string;
  expiresAt: number;
}>;

export type InboxEvent = Readonly<{
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  blockNumber: string;
}>;

export type InboxNotice = Readonly<{
  id: string;
  sourceKey: string;
  sourceKind: "chain_event" | "system_notice";
  sourceRevision: string;
  state: "pending" | "confirmed" | "removed" | "published" | "withdrawn";
  read: boolean;
  readAt: string | null;
  messageCode:
    "event_pending" | "event_confirmed" | "event_removed" | "service_notice";
  event: InboxEvent | null;
  text: string | null;
}>;

export type NotificationPreferences = Readonly<{
  revision: string;
  transactionAlerts: boolean;
  systemMessageAlerts: boolean;
}>;

export type InboxPage = Readonly<{
  address: string;
  chainId: number;
  notifications: readonly InboxNotice[];
  preferences: NotificationPreferences;
  chainEventsAvailable: boolean;
}>;

const addressPattern = /^0x[0-9a-f]{40}$/;
const idPattern = /^[0-9a-f]{32}$/;
const revisionPattern = /^(0|[1-9][0-9]{0,19})$/;
const maximumRevision = 18446744073709551615n;
const transactionPattern = /^0x[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid notification response.");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Error("Unsupported notification fields.");
}

function revision(value: unknown, allowZero = false): value is string {
  return (
    typeof value === "string" &&
    revisionPattern.test(value) &&
    BigInt(value) <= maximumRevision &&
    (allowZero || value !== "0")
  );
}

function chain(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function notificationIdentity(
  input: NotificationIdentity,
  now: number,
): NotificationIdentity {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !addressPattern.test(input.address) ||
    !chain(input.chainId) ||
    !idPattern.test(input.sessionId) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= now
  )
    throw new Error("An active matching wallet session is required.");
  return Object.freeze({
    address: input.address,
    chainId: input.chainId,
    sessionId: input.sessionId,
    expiresAt: input.expiresAt,
  });
}

export function parseNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const input = record(value);
  exact(input, ["revision", "transactionAlerts", "systemMessageAlerts"]);
  if (
    !revision(input.revision, true) ||
    typeof input.transactionAlerts !== "boolean" ||
    typeof input.systemMessageAlerts !== "boolean"
  )
    throw new Error("Invalid notification preferences.");
  return Object.freeze({
    revision: input.revision,
    transactionAlerts: input.transactionAlerts,
    systemMessageAlerts: input.systemMessageAlerts,
  });
}

function parseEvent(value: unknown): InboxEvent {
  const input = record(value);
  exact(input, [
    "transactionHash",
    "logIndex",
    "contractAddress",
    "eventName",
    "blockNumber",
  ]);
  if (
    typeof input.transactionHash !== "string" ||
    !transactionPattern.test(input.transactionHash) ||
    !Number.isInteger(input.logIndex) ||
    (input.logIndex as number) < 0 ||
    (input.logIndex as number) > 4294967295 ||
    typeof input.contractAddress !== "string" ||
    !addressPattern.test(input.contractAddress) ||
    typeof input.eventName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(input.eventName) ||
    typeof input.blockNumber !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(input.blockNumber) ||
    BigInt(input.blockNumber) >= 1n << 256n
  )
    throw new Error("Invalid notification event.");
  return Object.freeze({
    transactionHash: input.transactionHash,
    logIndex: input.logIndex as number,
    contractAddress: input.contractAddress,
    eventName: input.eventName,
    blockNumber: input.blockNumber,
  });
}

function parseNotice(value: unknown, chainId: number): InboxNotice {
  const input = record(value);
  exact(input, [
    "id",
    "sourceKey",
    "sourceKind",
    "sourceRevision",
    "state",
    "read",
    "readAt",
    "messageCode",
    "event",
    "text",
  ]);
  if (
    typeof input.id !== "string" ||
    !idPattern.test(input.id) ||
    !revision(input.sourceRevision) ||
    typeof input.read !== "boolean" ||
    (input.readAt !== null &&
      (typeof input.readAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(
          input.readAt,
        ) ||
        !Number.isFinite(Date.parse(input.readAt)))) ||
    input.read !== (input.readAt !== null)
  )
    throw new Error("Invalid notification identity or read state.");
  let event: InboxEvent | null = null;
  let text: string | null = null;
  if (input.sourceKind === "chain_event") {
    event = parseEvent(input.event);
    if (
      input.sourceKey !==
        `${chainId}:${event.transactionHash}:${event.logIndex}` ||
      !["pending", "confirmed", "removed"].includes(input.state as string) ||
      input.messageCode !== `event_${input.state}` ||
      input.text !== null
    )
      throw new Error("Notification event provenance does not match.");
  } else if (input.sourceKind === "system_notice") {
    if (
      input.sourceKey !== "platform:service_notice" ||
      !["published", "withdrawn"].includes(input.state as string) ||
      input.messageCode !== "service_notice" ||
      input.event !== null
    )
      throw new Error("Invalid published notice provenance.");
    if (input.state === "published") {
      if (
        typeof input.text !== "string" ||
        Array.from(input.text).length < 1 ||
        Array.from(input.text).length > 500 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)
      )
        throw new Error("Invalid public notice text.");
      text = input.text;
    } else if (input.text !== null || input.read || input.readAt !== null) {
      throw new Error("Withdrawn notices must not expose prior text.");
    }
  } else {
    throw new Error("Unsupported notification source.");
  }
  return Object.freeze({
    id: input.id,
    sourceKey: input.sourceKey as string,
    sourceKind: input.sourceKind,
    sourceRevision: input.sourceRevision,
    state: input.state as InboxNotice["state"],
    read: input.read,
    readAt: input.readAt as string | null,
    messageCode: input.messageCode as InboxNotice["messageCode"],
    event,
    text,
  });
}

export function parseNotificationPage(
  value: unknown,
  identity: NotificationIdentity,
): InboxPage {
  const input = record(value);
  exact(input, [
    "address",
    "chainId",
    "notifications",
    "preferences",
    "chainEventsAvailable",
  ]);
  if (
    input.address !== identity.address ||
    input.chainId !== identity.chainId ||
    !Array.isArray(input.notifications) ||
    input.notifications.length > 100 ||
    typeof input.chainEventsAvailable !== "boolean"
  )
    throw new Error("Notification response does not match the session.");
  const notifications = input.notifications.map((item) =>
    parseNotice(item, identity.chainId),
  );
  if (
    new Set(notifications.map((item) => item.id)).size !==
      notifications.length ||
    new Set(notifications.map((item) => `${item.sourceKind}:${item.sourceKey}`))
      .size !== notifications.length ||
    (!input.chainEventsAvailable &&
      notifications.some((item) => item.sourceKind === "chain_event"))
  )
    throw new Error("Inconsistent notification source inventory.");
  return Object.freeze({
    address: identity.address,
    chainId: identity.chainId,
    notifications: Object.freeze(notifications),
    preferences: parseNotificationPreferences(input.preferences),
    chainEventsAvailable: input.chainEventsAvailable,
  });
}

function sameNoticeSource(left: InboxNotice, right: InboxNotice): boolean {
  return (
    left.id === right.id &&
    left.sourceKey === right.sourceKey &&
    left.sourceKind === right.sourceKind &&
    left.sourceRevision === right.sourceRevision &&
    left.state === right.state &&
    left.messageCode === right.messageCode &&
    left.text === right.text &&
    JSON.stringify(left.event) === JSON.stringify(right.event)
  );
}

export class NotificationRequestError extends Error {
  constructor(public readonly status: number) {
    super("Notification request was rejected.");
  }
}

export type NotificationTransport = {
  list: (
    identity: NotificationIdentity,
    signal: AbortSignal,
  ) => Promise<unknown>;
  markRead: (
    identity: NotificationIdentity,
    input: { id: string; expectedSourceRevision: string },
    key: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  savePreferences: (
    identity: NotificationIdentity,
    input: NotificationPreferences,
    key: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export type NotificationInboxState = Readonly<{
  identity: NotificationIdentity | null;
  status:
    "signed_out" | "loading" | "ready" | "error" | "reconcile" | "expired";
  page: InboxPage | null;
  pending: boolean;
}>;

// No browser persistence, token custody, optimistic acknowledgement or automatic
// mutation replay. An unknown write result requires a fresh authoritative read.
export function createNotificationInbox(
  transport: NotificationTransport,
  options: { now: () => number; requestKey: () => string },
) {
  let generation = 0;
  let sequence = 0;
  let active: AbortController | null = null;
  let state: NotificationInboxState = Object.freeze({
    identity: null,
    status: "signed_out",
    page: null,
    pending: false,
  });
  const listeners = new Set<() => void>();
  const publish = (next: NotificationInboxState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const clear = (status: "signed_out" | "expired") => {
    generation++;
    sequence++;
    active?.abort();
    active = null;
    publish({ identity: null, status, page: null, pending: false });
  };
  const current = (captured: number, request: number) => {
    if (captured !== generation || request !== sequence || !state.identity)
      return false;
    const now = options.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      state.identity.expiresAt <= now
    ) {
      clear("expired");
      return false;
    }
    return true;
  };
  const begin = () => {
    if (!state.identity) return null;
    const captured = generation;
    const request = ++sequence;
    if (!current(captured, request)) return null;
    active?.abort();
    const abort = new AbortController();
    active = abort;
    return { captured, request, identity: state.identity, abort };
  };
  const failure = (error: unknown, write: boolean) => {
    if (error instanceof NotificationRequestError && error.status === 401) {
      clear("signed_out");
      return;
    }
    publish({
      ...state,
      page: null,
      status:
        write ||
        (error instanceof NotificationRequestError && error.status === 409)
          ? "reconcile"
          : "error",
      pending: false,
    });
  };
  const refresh = async () => {
    // A deliberate refresh reconciles an unknown result; it never resends it.
    if (state.pending) return;
    const operation = begin();
    if (!operation) return;
    publish({ ...state, status: "loading", page: null });
    try {
      const value = await transport.list(
        operation.identity,
        operation.abort.signal,
      );
      if (!current(operation.captured, operation.request)) return;
      const page = parseNotificationPage(value, operation.identity);
      publish({ ...state, page, status: "ready", pending: false });
    } catch (error) {
      if (current(operation.captured, operation.request)) failure(error, false);
    }
  };
  const mutate = async (
    apply: (
      identity: NotificationIdentity,
      key: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    validate: (page: InboxPage) => boolean,
  ) => {
    if (state.pending || state.status !== "ready" || !state.page) return;
    const operation = begin();
    if (!operation) return;
    let key: string;
    try {
      key = options.requestKey();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
        throw new Error("Invalid request key.");
    } catch {
      publish({ ...state, status: "error", page: null, pending: false });
      return;
    }
    publish({ ...state, pending: true });
    try {
      const value = await apply(
        operation.identity,
        key,
        operation.abort.signal,
      );
      if (!current(operation.captured, operation.request)) return;
      const page = parseNotificationPage(value, operation.identity);
      if (!validate(page))
        throw new Error("Mutation acknowledgement does not match.");
      publish({ ...state, page, status: "ready", pending: false });
    } catch (error) {
      if (current(operation.captured, operation.request)) failure(error, true);
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setIdentity: (identity: NotificationIdentity | null) => {
      clear("signed_out");
      if (!identity) return;
      try {
        const validated = notificationIdentity(identity, options.now());
        publish({
          identity: validated,
          status: "loading",
          page: null,
          pending: false,
        });
      } catch {
        clear("expired");
      }
    },
    refresh,
    markRead: async (id: string, expectedSourceRevision: string) => {
      const notice = state.page?.notifications.find((item) => item.id === id);
      if (
        !notice ||
        notice.read ||
        notice.state === "withdrawn" ||
        notice.sourceRevision !== expectedSourceRevision
      )
        return;
      await mutate(
        (identity, key, signal) =>
          transport.markRead(
            identity,
            { id, expectedSourceRevision },
            key,
            signal,
          ),
        (page) =>
          page.notifications.some(
            (item) => sameNoticeSource(item, notice) && item.read,
          ),
      );
    },
    savePreferences: async (input: NotificationPreferences) => {
      let preferences: NotificationPreferences;
      try {
        preferences = parseNotificationPreferences(input);
      } catch {
        return;
      }
      if (state.page?.preferences.revision !== preferences.revision) return;
      await mutate(
        (identity, key, signal) =>
          transport.savePreferences(identity, preferences, key, signal),
        (page) =>
          BigInt(page.preferences.revision) ===
            BigInt(preferences.revision) + 1n &&
          page.preferences.transactionAlerts ===
            preferences.transactionAlerts &&
          page.preferences.systemMessageAlerts ===
            preferences.systemMessageAlerts,
      );
    },
    dispose: () => {
      clear("signed_out");
      listeners.clear();
    },
  };
}
