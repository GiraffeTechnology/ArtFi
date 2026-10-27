import "server-only";
import {
  createWholeReceiptExecutionComposition,
  type ReceiptExecutionCompositionOptions,
} from "./whole-receipt-execution-composition";
import {
  NFT_TASK_JOURNAL_PATH,
  nftTaskJournalDigest,
} from "./nft/task-journal";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";

type CompositionOptions = ReceiptExecutionCompositionOptions;
type ConnectedAuthority = NonNullable<
  CompositionOptions["runtime"]["authority"]
>;
type JournalConfig = CompositionOptions["journalConfig"];

/** Original Wallet authorization port. The original implementation proves store
 * independence and supplies the real held preparation/execution contexts. */
export type ReceiptInstallationAuthority = ConnectedAuthority & {
  readState(claimed: CompositionOptions["claimed"]): Promise<unknown>;
  assertIndependentStore(store: object): void;
};
export type ReceiptInstallationRuntime = CompositionOptions["runtime"] & {
  connectAuthorization(authority: ReceiptInstallationAuthority): unknown;
  withCapability: JournalConfig["withCapability"];
  consumeCapability(request: unknown, authenticatedPeerId: string): unknown;
  stop(): void;
};
export type ReceiptRuntimeFactory = (options: {
  store: object;
  journalStore: object;
  peerId: string;
  consumerPeerId: string;
  digest: typeof nftTaskJournalDigest;
  nativeDigest: typeof kernelRequestDigest;
  now: () => number;
}) => ReceiptInstallationRuntime;
export type ReceiptInstallationOptions = {
  /** Fixed, trusted installed Wallet implementation; never request-selected. */
  createTaskReceiptRuntime: ReceiptRuntimeFactory;
  createProviderHandler: CompositionOptions["createProviderHandler"];
  store: object;
  journalStore: object;
  consumerPeerId: string;
  /** Original executor identity, validated by Wallet's auth-options composer. */
  taskExecutorIdentity: unknown;
  provider: CompositionOptions["provider"];
  journal: Omit<JournalConfig, "withCapability">;
  now?: () => number;
};

export class ReceiptInstallationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReceiptInstallationError";
  }
}
function fail(code = "RECEIPT_INSTALLATION_CONFIG_REFUSED"): never {
  throw new ReceiptInstallationError(code);
}
function fields(raw: unknown, required: string[], optional: string[] = []) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        ![...required, ...optional].includes(key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    fail();
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value]),
  ) as Record<string, unknown>;
}
/** Copy all own JSON data before installing it; never execute an accessor or
 * retain a caller-mutable policy/identity. Wallet still validates its schema. */
function snapshot(raw: unknown, depth = 0): unknown {
  if (depth > 16) fail();
  if (raw === null || typeof raw === "string" || typeof raw === "boolean")
    return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (!raw || typeof raw !== "object") fail();
  const array = Array.isArray(raw);
  if (
    Object.getPrototypeOf(raw) !==
      (array ? Array.prototype : Object.prototype) ||
    Object.getOwnPropertySymbols(raw).length
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (array) {
    const length = descriptors.length!.value as number;
    if (Object.keys(descriptors).length !== length + 1) fail();
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        fail();
      result.push(snapshot(descriptor.value, depth + 1));
    }
    return Object.freeze(result);
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      fail();
    result[key] = snapshot(descriptor.value, depth + 1);
  }
  return Object.freeze(result);
}

/** Installation-owned connection of the existing Wallet receipt runtime to the
 * existing ArtFi execution/native-journal composition. This registers no HTTP
 * route, imports no configurable module, creates no store/provider/signer, and
 * supplies no grant or alternate authorization. Installers pass authOptions to
 * the original auth-service composer, then connect that service's original
 * receipt authority exactly once. */
export function createWholeReceiptInstallation(
  raw: ReceiptInstallationOptions,
) {
  const input = fields(
    raw,
    [
      "createTaskReceiptRuntime",
      "createProviderHandler",
      "store",
      "journalStore",
      "consumerPeerId",
      "taskExecutorIdentity",
      "provider",
      "journal",
    ],
    ["now"],
  );
  const factory = input.createTaskReceiptRuntime as ReceiptRuntimeFactory;
  const createProviderHandler =
    input.createProviderHandler as CompositionOptions["createProviderHandler"];
  const store = input.store as object,
    journalStore = input.journalStore as object;
  const now = (input.now ?? Date.now) as () => number;
  const providerInput = input.provider as CompositionOptions["provider"];
  const journalInput = fields(input.journal, ["url", "peerId", "transport"]);
  if (
    typeof factory !== "function" ||
    typeof createProviderHandler !== "function" ||
    !store ||
    typeof store !== "object" ||
    !journalStore ||
    typeof journalStore !== "object" ||
    store === journalStore ||
    typeof now !== "function" ||
    typeof providerInput?.request !== "function" ||
    typeof journalInput.url !== "string" ||
    typeof journalInput.peerId !== "string" ||
    typeof journalInput.transport !== "function" ||
    typeof input.consumerPeerId !== "string"
  )
    fail();
  let endpoint: URL;
  try {
    endpoint = new URL(journalInput.url as string);
  } catch {
    fail();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.pathname !== NFT_TASK_JOURNAL_PATH ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail();
  // The wire digest and native-operation identity have different contracts.
  // Keep the existing implementations; neither is the preapproval commitment.
  const authOptions = Object.freeze({
    taskReceiptHandlerId: "artfi:whole-receipt:v1" as const,
    taskExecutorIdentity: snapshot(input.taskExecutorIdentity),
  });
  const provider = Object.freeze({
    request: providerInput.request.bind(providerInput),
  });
  const transport = (journalInput.transport as JournalConfig["transport"]).bind(
    input.journal,
  );
  let stopped = false,
    connectionAttempted = false,
    connected = false;
  let stopRuntime = () => {};
  const runtime = factory({
    store,
    journalStore,
    peerId: journalInput.peerId,
    consumerPeerId: input.consumerPeerId,
    digest: nftTaskJournalDigest,
    nativeDigest: kernelRequestDigest,
    now,
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopRuntime();
  };
  if (
    runtime?.state !== "configured" ||
    runtime.authority !== null ||
    typeof runtime.connectAuthorization !== "function" ||
    typeof runtime.inHeldGate !== "function" ||
    typeof runtime.withCapability !== "function" ||
    typeof runtime.consumeCapability !== "function" ||
    typeof runtime.stop !== "function"
  ) {
    // An unexpected/shared runtime has not been claimed by this installation.
    // Refuse it without stopping another owner's already-connected runtime.
    fail("RECEIPT_INSTALLATION_RUNTIME_REFUSED");
  }
  stopRuntime = runtime.stop.bind(runtime);
  const connect = runtime.connectAuthorization.bind(runtime);
  const consume = runtime.consumeCapability.bind(runtime);
  const journalConfig: JournalConfig = Object.freeze({
    url: journalInput.url,
    peerId: journalInput.peerId,
    transport,
    // Do not add a stopped check here: an accepted send must retain the original
    // runtime's capability journal while it drains and records its known hash.
    withCapability: runtime.withCapability.bind(runtime),
  });
  const active = () => {
    if (stopped) fail("RECEIPT_INSTALLATION_STOPPED");
    if (!connected) fail("RECEIPT_INSTALLATION_AUTHORIZATION_NOT_CONNECTED");
  };
  return Object.freeze({
    authOptions,
    connectAuthorization(authority: ReceiptInstallationAuthority) {
      if (stopped) fail("RECEIPT_INSTALLATION_STOPPED");
      if (connectionAttempted) fail("RECEIPT_INSTALLATION_ALREADY_CONNECTED");
      connectionAttempted = true;
      try {
        connect(authority);
        const installedAuthority =
          runtime.authority as ConnectedAuthority | null;
        if (
          typeof installedAuthority?.withPreparation !== "function" ||
          typeof installedAuthority?.withAuthorization !== "function"
        )
          fail("RECEIPT_INSTALLATION_RUNTIME_REFUSED");
        connected = true;
      } catch (error) {
        stop();
        throw error;
      }
    },
    /** Original registry/peer validation, for the existing authenticated server
     * consumer only. This function is not an endpoint or a bearer-only bridge. */
    consumeCapability(request: unknown, authenticatedPeerId: string) {
      if (!connected) fail("RECEIPT_INSTALLATION_AUTHORIZATION_NOT_CONNECTED");
      // The original registry decides whether a stopped runtime is still
      // draining an accepted send. Do not revoke its in-flight consume here.
      return consume(request, authenticatedPeerId);
    },
    operation(rawOperation: Pick<CompositionOptions, "task" | "claimed">) {
      active();
      const selected = fields(rawOperation, ["task", "claimed"]);
      const composition = createWholeReceiptExecutionComposition({
        runtime,
        createProviderHandler,
        provider,
        now,
        journalConfig,
        task: snapshot(selected.task) as CompositionOptions["task"],
        claimed: snapshot(selected.claimed) as CompositionOptions["claimed"],
      });
      return Object.freeze({
        operationId: composition.operationId,
        async create(...args: Parameters<typeof composition.create>) {
          active();
          return composition.create(...args);
        },
        async read(...args: Parameters<typeof composition.read>) {
          active();
          return composition.read(...args);
        },
        async execute(...args: Parameters<typeof composition.execute>) {
          active();
          // No post-await stop fence: Wallet owns reservation cutoff/drain.
          return composition.execute(...args);
        },
      });
    },
    stop,
  });
}
