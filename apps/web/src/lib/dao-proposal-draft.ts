/** Unsigned M4 proposal drafts. Importing a draft grants no voting or execution authority. */
import { isAddress } from "viem";

export type DaoDraftActionType =
  | "market"
  | "warehouse"
  | "auction"
  | "sale"
  | "custodian"
  | "failure"
  | "buyout30"
  | "buyout10";
export type DaoDraftContext = {
  chainId: string;
  governor: string;
  token: string;
  vault: string;
  actionRegistry: string;
};
export type DaoDraftForm = {
  actionType: DaoDraftActionType;
  description: string;
  marketName: string;
  evidenceHash: string;
  evidenceURI: string;
  amountWei: string;
  t0: string;
  observationStart: string;
  tradeCount: string;
  dueDate: string;
};
type DraftAction = {
  type: DaoDraftActionType;
  description: string;
  evidenceHash: string;
  evidenceURI: string;
  marketName?: string;
  amountWei?: string;
  t0?: string;
  observationStart?: string;
  tradeCount?: string;
  dueDate?: string;
};
export type DaoProposalDraft = Readonly<{
  schema: "artfi-dao-draft/1";
  context: Readonly<DaoDraftContext>;
  action: Readonly<DraftAction>;
}>;
export const daoDraftMaxBytes = 16_384;
const types: readonly string[] = [
  "market",
  "warehouse",
  "auction",
  "sale",
  "custodian",
  "failure",
  "buyout30",
  "buyout10",
];
const common = ["type", "description", "evidenceHash", "evidenceURI"];
const contextKeys = [
  "chainId",
  "governor",
  "token",
  "vault",
  "actionRegistry",
] as const;
function refuse(message: string): never {
  throw new Error(message);
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refuse("The draft must contain plain JSON objects.");
  const entries = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(entries).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(entries, key) || !Object.hasOwn(entries[key]!, "value"),
    )
  )
    refuse("The draft has missing or unsupported fields.");
  return Object.fromEntries(keys.map((key) => [key, entries[key]!.value]));
}
function text(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    refuse("A draft text field is invalid or too long.");
  return value;
}
function uint(value: unknown, bits: number, positive = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    refuse("Draft quantities must be canonical decimal strings.");
  const number = BigInt(value);
  if (number < (positive ? 1n : 0n) || number >= 1n << BigInt(bits))
    refuse("A draft quantity is outside its contract range.");
  return value;
}
function context(value: unknown): DaoDraftContext {
  const raw = fields(value, contextKeys);
  const chainId = uint(raw.chainId, 256, true);
  if (chainId !== "560048")
    refuse(
      "This DAO draft workspace supports the configured Hoodi deployment.",
    );
  const address = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !isAddress(value) ||
      /^0x0{40}$/i.test(value)
    )
      refuse("The complete DAO deployment must be configured.");
    return value.toLowerCase();
  };
  return {
    chainId,
    governor: address(raw.governor),
    token: address(raw.token),
    vault: address(raw.vault),
    actionRegistry: address(raw.actionRegistry),
  };
}
function actionKeys(type: string): string[] {
  if (type === "market") return [...common, "marketName"];
  if (type === "failure") return [...common, "amountWei", "dueDate"];
  if (type === "buyout30" || type === "buyout10")
    return [...common, "amountWei", "t0", "observationStart", "tradeCount"];
  return common;
}
function normalize(
  value: unknown,
  expected: DaoDraftContext,
): DaoProposalDraft {
  const root = fields(value, ["schema", "context", "action"]);
  if (root.schema !== "artfi-dao-draft/1")
    refuse("This draft version is not supported.");
  const target = context(root.context),
    installed = context(expected);
  if (contextKeys.some((key) => target[key] !== installed[key]))
    refuse("The draft belongs to a different chain or DAO deployment.");
  if (!root.action || typeof root.action !== "object")
    refuse("The draft action is missing.");
  const descriptor = Object.getOwnPropertyDescriptor(root.action, "type");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    !types.includes(descriptor.value)
  )
    refuse("The draft action is not supported.");
  const type = descriptor.value as DaoDraftActionType;
  const raw = fields(root.action, actionKeys(type));
  const evidenceHash = text(raw.evidenceHash, 66, 66);
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(evidenceHash) ||
    /^0x0{64}$/i.test(evidenceHash)
  )
    refuse("A nonzero evidence hash is required.");
  const evidenceURI = text(raw.evidenceURI, 1, 512);
  if (new TextEncoder().encode(evidenceURI).length > 512)
    refuse("The evidence URI exceeds the contract byte limit.");
  let uri: URL;
  try {
    uri = new URL(evidenceURI);
  } catch {
    refuse("Evidence must use an absolute HTTPS or IPFS URI.");
  }
  if (
    !["https:", "ipfs:"].includes(uri.protocol) ||
    !uri.hostname ||
    uri.username ||
    uri.password
  )
    refuse(
      "Evidence must use an absolute HTTPS or IPFS URI without credentials.",
    );
  const result: DraftAction = {
    type,
    description: text(raw.description, 12, 1000),
    evidenceHash: evidenceHash.toLowerCase(),
    evidenceURI,
  };
  if (type === "market") result.marketName = text(raw.marketName, 2, 128);
  if (type === "failure") {
    result.amountWei = uint(raw.amountWei, 256, true);
    result.dueDate = uint(raw.dueDate, 48, true);
  }
  if (type === "buyout30" || type === "buyout10") {
    result.amountWei = uint(raw.amountWei, 256, true);
    result.t0 = uint(raw.t0, 48);
    result.observationStart = uint(raw.observationStart, 48);
    result.tradeCount = uint(raw.tradeCount, 32, true);
    if (
      type === "buyout30"
        ? BigInt(result.t0) < 2_592_000n ||
          BigInt(result.observationStart) !== BigInt(result.t0) - 2_592_000n
        : result.observationStart !== "0" || result.tradeCount !== "10"
    )
      refuse(
        "The pricing window and actual trade count do not match the selected rule.",
      );
  }
  return Object.freeze({
    schema: "artfi-dao-draft/1",
    context: Object.freeze(target),
    action: Object.freeze(result),
  });
}
export function createDaoProposalDraft(
  expected: DaoDraftContext,
  form: DaoDraftForm,
): DaoProposalDraft {
  const action: Record<string, string> = {
    type: form.actionType,
    description: form.description.trim(),
    evidenceHash: form.evidenceHash.trim(),
    evidenceURI: form.evidenceURI.trim(),
  };
  for (const key of actionKeys(form.actionType).filter(
    (key) => !common.includes(key),
  ))
    action[key] = form[key as keyof DaoDraftForm].trim();
  return normalize(
    { schema: "artfi-dao-draft/1", context: expected, action },
    expected,
  );
}
export function parseDaoProposalDraft(
  raw: string,
  expected: DaoDraftContext,
): DaoProposalDraft {
  if (
    typeof raw !== "string" ||
    raw.length > daoDraftMaxBytes ||
    new TextEncoder().encode(raw).length > daoDraftMaxBytes
  )
    refuse("The draft exceeds the import size limit.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    refuse("The draft is not valid JSON.");
  }
  return normalize(decoded, expected);
}
export function serializeDaoProposalDraft(
  draft: DaoProposalDraft,
  expected: DaoDraftContext,
): string {
  return JSON.stringify(normalize(draft, expected), null, 2) + "\n";
}
export function daoDraftForm(draft: DaoProposalDraft): DaoDraftForm {
  const a = draft.action;
  return {
    actionType: a.type,
    description: a.description,
    evidenceHash: a.evidenceHash,
    evidenceURI: a.evidenceURI,
    marketName: a.marketName ?? "",
    amountWei: a.amountWei ?? "",
    dueDate: a.dueDate ?? "",
    t0: a.t0 ?? "",
    observationStart: a.observationStart ?? "",
    tradeCount: a.tradeCount ?? "",
  };
}
