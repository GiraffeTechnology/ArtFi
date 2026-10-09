export type ModerationCase = {
  id: string;
  reporter: string;
  target: string;
  category: string;
  details: string;
  status: "open" | "reviewing" | "resolved" | "appealed";
  decision: "none" | "no_action" | "content_warning";
  decisionReason: string;
  publicNotice: string;
  revision: number;
  appealStatus: "none" | "pending" | "upheld" | "rejected";
  appealStatement: string;
  appealResponse: string;
  createdAt: string;
  updatedAt: string;
};
export type PlatformConfiguration = {
  revision: number;
  noticeEnabled: boolean;
  noticeText: string;
  updatedAt: string;
};
export type ModerationNotice = {
  id: string;
  target: string;
  notice: string;
  updatedAt: string;
};
export type AdministrationPage<T> = {
  data: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};
export type AdministrationAudit = {
  id: string;
  occurredAt: string;
  action: string;
  resourceType: string;
  requestId: string;
  metadata: {
    actor: string;
    resourceId: string;
    previousRevision: number;
    snapshot: unknown;
  };
};

export class AdministrationRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdministrationRequestError";
  }
}

/** Private calls are bound to the currently displayed wallet, not just its cookie. */
export async function administrationRequest<T>(
  path: string,
  session?: { address: string; chainId: number },
  options: {
    method?: "POST" | "PUT";
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) {
    headers["x-artfi-wallet"] = session.address;
    headers["x-artfi-chain"] = String(session.chainId);
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key) headers["idempotency-key"] = options.key;
  const response = await fetch(`/api/administration/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: options.signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new AdministrationRequestError(
      response.status,
      result.detail ||
        "No result was confirmed. Refresh or retry the same request.",
    );
  return result as T;
}

/** Retry an unchanged mutation with the same key, including after an uncertain response. */
export function administrationKey(
  keys: Map<string, string>,
  path: string,
  body: unknown,
  create: () => string = () => crypto.randomUUID(),
) {
  const fingerprint = `${path}\n${JSON.stringify(body)}`;
  let key = keys.get(fingerprint);
  if (!key) {
    key = create();
    keys.set(fingerprint, key);
  }
  return key;
}

export function administrationRoute(path: string[], method: string) {
  const joined = path.join("/");
  const id = "[a-f0-9]{32}";
  if (
    method === "GET" &&
    ["platform/config", "moderation/notices"].includes(joined)
  )
    return { upstream: `/v1/${joined}`, private: false };
  if (
    (method === "GET" &&
      /^(admin\/(session|audit|config)|(?:admin|user)\/moderation\/cases)$/.test(
        joined,
      )) ||
    (method === "GET" &&
      new RegExp(`^(admin|user)/moderation/cases/${id}$`).test(joined)) ||
    (method === "POST" && joined === "user/moderation/cases") ||
    (method === "POST" &&
      new RegExp(`^user/moderation/cases/${id}/appeals$`).test(joined)) ||
    (method === "POST" &&
      new RegExp(`^admin/moderation/cases/${id}/decisions$`).test(joined)) ||
    (method === "PUT" && joined === "admin/config")
  )
    return { upstream: `/v1/${joined}`, private: true };
  return undefined;
}
