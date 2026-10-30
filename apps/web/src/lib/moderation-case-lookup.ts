import {
  administrationRequest,
  AdministrationRequestError,
  type ModerationCase,
} from "./administration";
export function moderationCaseID(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new Error("Enter the complete 32-character case ID.");
  return id;
}
const fields = [
  "id",
  "reporter",
  "target",
  "category",
  "details",
  "status",
  "decision",
  "decisionReason",
  "publicNotice",
  "revision",
  "appealStatus",
  "appealStatement",
  "appealResponse",
  "createdAt",
  "updatedAt",
];
function refuse(): never {
  throw new Error(
    "The private case response does not match this request and wallet.",
  );
}
function text(value: unknown, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    [...value].length < min ||
    [...value].length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
  )
    refuse();
  return value;
}
function date(value: unknown): string {
  const result = text(value, 20, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      result,
    ) ||
    !Number.isFinite(Date.parse(result))
  )
    refuse();
  const offset = result.endsWith("Z")
    ? 0
    : (result.at(-6) === "+" ? 1 : -1) *
      (Number(result.slice(-5, -3)) * 60 + Number(result.slice(-2)));
  if (
    (!result.endsWith("Z") &&
      (Number(result.slice(-5, -3)) > 23 || Number(result.slice(-2)) > 59)) ||
    new Date(Date.parse(result) + offset * 60000).toISOString().slice(0, 19) !==
      result.slice(0, 19)
  )
    refuse();
  return result;
}
/** A display DTO, never a grant of moderation or appeal authority. */
export function readPrivateModerationCase(
  value: unknown,
  id: string,
  reporter: string,
): ModerationCase {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    fields.some(
      (key) =>
        !Object.hasOwn(descriptors, key) ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    refuse();
  const row = Object.fromEntries(
    fields.map((key) => [key, descriptors[key]!.value]),
  );
  if (
    row.id !== moderationCaseID(id) ||
    typeof row.reporter !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(row.reporter) ||
    !/^0x[0-9a-fA-F]{40}$/.test(reporter) ||
    row.reporter.toLowerCase() !== reporter.toLowerCase() ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !["open", "reviewing", "resolved", "appealed"].includes(
      row.status as string,
    ) ||
    !["none", "no_action", "content_warning"].includes(
      row.decision as string,
    ) ||
    !["none", "pending", "upheld", "rejected"].includes(
      row.appealStatus as string,
    ) ||
    ![
      "misleading_metadata",
      "inappropriate_content",
      "suspected_fraud",
      "other",
    ].includes(row.category as string)
  )
    refuse();
  return {
    id: row.id as string,
    reporter: row.reporter.toLowerCase(),
    revision: row.revision as number,
    target: text(row.target, 3, 256),
    category: row.category as string,
    details: text(row.details, 10, 4000),
    status: row.status as ModerationCase["status"],
    decision: row.decision as ModerationCase["decision"],
    decisionReason: text(row.decisionReason, 0, 4000),
    publicNotice: text(row.publicNotice, 0, 500),
    appealStatus: row.appealStatus as ModerationCase["appealStatus"],
    appealStatement: text(row.appealStatement, 0, 4000),
    appealResponse: text(row.appealResponse, 0, 4000),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  };
}
type Session = { address: string; chainId: number };
type Load = (
  id: string,
  session: Session,
  signal: AbortSignal,
) => Promise<unknown>;
function cancellable(
  load: Load,
  id: string,
  session: Session,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new Error("Private case read retired."));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error("Private case read retired.");
        return load(id, session, signal);
      })
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (reason) => {
          cleanup();
          reject(reason);
        },
      );
  });
}
const loadCase: Load = (id, session, signal) =>
  administrationRequest<unknown>(`user/moderation/cases/${id}`, session, {
    signal,
  });
/** One session-bound read lifetime. Retiring it never retries or mutates a case. */
export function createPrivateCaseLookup(
  session: Session,
  handlers: {
    record: (value: ModerationCase | undefined) => void;
    busy: (value: boolean) => void;
    error: (value: string) => void;
    denied: () => void;
  },
  load: Load = loadCase,
) {
  const bound = Object.freeze({
    address: session.address,
    chainId: session.chainId,
  });
  let generation = 0,
    retired = false,
    controller: AbortController | undefined;
  const cancel = () => {
    generation++;
    controller?.abort();
    controller = undefined;
  };
  return {
    async open(raw: string) {
      if (retired) return;
      cancel();
      const current = generation,
        attempt = new AbortController();
      controller = attempt;
      handlers.record(undefined);
      handlers.error("");
      let id: string;
      try {
        id = moderationCaseID(raw);
        if (
          !/^0x[0-9a-fA-F]{40}$/.test(bound.address) ||
          !Number.isSafeInteger(bound.chainId) ||
          bound.chainId <= 0
        )
          refuse();
      } catch {
        handlers.error(
          "Enter the complete 32-character case ID using the current signed-in wallet.",
        );
        handlers.busy(false);
        return;
      }
      handlers.busy(true);
      const timer = setTimeout(() => attempt.abort(), 8000);
      const active = () => !retired && generation === current;
      try {
        const value = await cancellable(load, id, bound, attempt.signal);
        if (!active() || attempt.signal.aborted) return;
        handlers.record(readPrivateModerationCase(value, id, bound.address));
      } catch (reason) {
        if (!active()) return;
        if (
          reason instanceof AdministrationRequestError &&
          [401, 403].includes(reason.status)
        ) {
          handlers.record(undefined);
          handlers.denied();
        } else
          handlers.error(
            reason instanceof AdministrationRequestError &&
              reason.status === 404
              ? "The case was not found or is not available to this wallet."
              : "This private case could not be opened. Check your session and retry this read.",
          );
      } finally {
        clearTimeout(timer);
        if (active()) {
          if (attempt.signal.aborted)
            handlers.error(
              "The private case read was cancelled or timed out. Retry this read when available.",
            );
          handlers.busy(false);
          controller = undefined;
        }
      }
    },
    clear() {
      cancel();
      if (!retired) {
        handlers.record(undefined);
        handlers.error("");
        handlers.busy(false);
      }
    },
    retire() {
      cancel();
      retired = true;
    },
  };
}
