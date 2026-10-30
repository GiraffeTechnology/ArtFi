import "server-only";
import { TypedDataEncoder } from "ethers";
import { kernelRequestDigest } from "../../../../../scripts/agent/agent-kernel.mjs";
import {
  prepareNftOperationWithContext,
  reviewNftOperationWithContext,
  submitNftSignatureWithContext,
  reconcileNftOperationWithContext,
  requireExistingListingApproval,
  type NftEngineContext,
} from "./engine";
import { nftRequestHash, type NftOperation } from "./journal";
import {
  NFT_CHAINS,
  equalAddress,
  fail,
  object,
  readNftRequest,
  uint,
  type NftPlan,
  type NftRequest,
  type NftScope,
  type NftTaskBinding,
  type NftTaskPrincipal,
} from "./model";
import { components, validateTypedData, orderHash } from "./validation";

export type NftTaskPurpose = "prepare" | "review" | "publish" | "observe";
/** Output of the installation's authenticated task/grant verifier, not caller input. */
export type VerifiedNftTask = {
  binding: NftTaskBinding;
  actor: NftRequest["account"];
  chainId: number;
  expiresAt: number;
  /** Fixed verifier's earliest quote/policy dispatch deadline in milliseconds.
   * Required before review claim or publication dispatch; never substitutes for order expiry.
   */
  sideEffectDeadlineAtMs?: number;
  intent: {
    kind: "nft-sale";
    direction: "sell";
    standard: "ERC-721" | "ERC-1155";
    contract: NftScope["contract"];
    tokenId: string;
    quantity: string;
  };
};
export type NativeListingReference = {
  schema: "artfi-native-nft-listing-reference/1";
  taskBinding: NftTaskBinding;
  nativeOperationId: string;
  nativePlanId: string;
  reviewDigest: string;
  orderHash: string;
  typedDataDigest: string;
};
export type NativeListingPublication = {
  reference: NativeListingReference;
  status: string;
  orderHash?: string;
  publicationAccepted: boolean;
  saleComplete: false;
  settlement: "NOT_ASSESSED";
};
export type NativeListingRecovery = NativeListingPublication & {
  recoverySnapshot: {
    unsignedPlan: NftPlan;
    walletStarted: boolean;
    signingState:
      "NOT_STARTED" | "STARTED_OUTCOME_UNKNOWN" | "PUBLICATION_RECORDED";
    authority: "READ_ONLY_NOT_SIGNING_AUTHORIZATION";
  };
};
export type NativeNftTaskPort = {
  prepareListing(
    taskBinding: NftTaskBinding,
    request: NftRequest,
  ): Promise<NativeListingReference>;
  reviewListing(
    reference: NativeListingReference,
  ): Promise<{ reference: NativeListingReference; plan: NftPlan }>;
  publishListing(
    reference: NativeListingReference,
    exactSignature: string,
  ): Promise<NativeListingPublication>;
  readPublication(
    reference: NativeListingReference,
  ): Promise<NativeListingRecovery>;
};
export type NativeNftTaskPortDependencies = Pick<
  NftEngineContext,
  "requireTrading" | "scope" | "provider" | "sdk" | "api"
> & {
  /** Fixed server composition. Verify task/grant, executor and current revocation on every call.
   * When plan is present, also run the existing NFT sale terms verifier and the grant's
   * bound valuation/price-at/fee rules. A terms MATCHED result alone is not authorization.
   * observe must authenticate ownership but may observe an expired/revoked grant's record.
   */
  verifyTaskBinding(
    binding: NftTaskBinding,
    context: {
      purpose: NftTaskPurpose;
      request?: NftRequest;
      scope?: NftScope;
      plan?: NftPlan;
    },
  ): Promise<VerifiedNftTask>;
  /** Same durable grant snapshot/lock as the server's revocation path. The verifier
   * must authorize the exact plan and hold its read capability until action settles.
   * For publish this encloses submitted-CAS and dispatch, including intervening awaits.
   * No standalone boolean or check-then-act callback can implement this contract.
   */
  withTaskAuthorization<T>(
    binding: NftTaskBinding,
    purpose: "review" | "publish",
    plan: NftPlan,
    action: (verified: VerifiedNftTask) => Promise<T>,
  ): Promise<T>;
  /** Authenticated INTERNAL task scope, durable CAS and immutable plan binding required.
   * Do not adapt this to the session HTTP journal with a fabricated cookie/session ID.
   * A bridge credential alone cannot establish this principal.
   */
  journal(
    principal: NftTaskPrincipal,
    action: "get" | "create" | "update",
    operation: Partial<NftOperation> & { id: string },
  ): Promise<NftOperation>;
};
const bindingKeys = [
  "taskId",
  "taskDigest",
  "executorDigest",
  "grantReference",
  "grantPolicyVersion",
  "operationId",
].sort();
function binding(value: unknown): NftTaskBinding {
  const x = object(value);
  if (
    Object.keys(x).sort().join() !== bindingKeys.join() ||
    bindingKeys.some((key) => typeof x[key] !== "string") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(x.taskId)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(x.operationId)) ||
    !/^0x[0-9a-f]{64}$/.test(String(x.taskDigest)) ||
    !/^0x[0-9a-f]{64}$/.test(String(x.executorDigest)) ||
    !/^grant:[A-Za-z0-9_-]{1,122}$/.test(String(x.grantReference))
  )
    fail("Invalid NFT task binding.", 403);
  uint(x.grantPolicyVersion, true);
  return Object.freeze(structuredClone(x)) as NftTaskBinding;
}
function sameBinding(a: NftTaskBinding, b: NftTaskBinding) {
  return bindingKeys.every(
    (key) => a[key as keyof NftTaskBinding] === b[key as keyof NftTaskBinding],
  );
}
function principalMatches(plan: NftPlan, principal: NftTaskPrincipal) {
  if (
    plan.sessionId !== undefined ||
    plan.taskPrincipal?.kind !== "task" ||
    !sameBinding(plan.taskPrincipal, principal)
  )
    fail("The NFT operation belongs to another task authorization.", 403);
}
function assertListing(
  task: VerifiedNftTask,
  request: NftRequest,
  scope: NftScope,
  current = true,
) {
  const intent = task.intent;
  if (
    intent?.kind !== "nft-sale" ||
    intent.direction !== "sell" ||
    request.action !== "list" ||
    request.orderHash !== undefined ||
    !equalAddress(task.actor, request.account) ||
    task.chainId !== NFT_CHAINS[scope.chain] ||
    request.collection !== scope.slug ||
    !equalAddress(intent.contract, scope.contract) ||
    scope.standard !==
      ({ "ERC-721": "erc721", "ERC-1155": "erc1155" } as const)[
        intent.standard
      ] ||
    intent.tokenId !== request.tokenId ||
    intent.quantity !== request.quantity ||
    (scope.standard === "erc721" && request.quantity !== "1") ||
    !Number.isSafeInteger(task.expiresAt) ||
    request.expiresAt > task.expiresAt ||
    (current && task.expiresAt <= Math.floor(Date.now() / 1000))
  )
    fail(
      "The listing is outside the authenticated task's exact seller, asset, quantity or expiry.",
      403,
    );
}
function assertActivePlan(task: VerifiedNftTask, plan: NftPlan) {
  principalMatches(plan, { ...task.binding, kind: "task" });
  assertListing(task, plan.request, plan.scope);
  if (plan.expiresAt <= Date.now())
    fail("The native listing review expired.", 409);
  if (
    !Number.isSafeInteger(task.sideEffectDeadlineAtMs) ||
    task.sideEffectDeadlineAtMs! <= Date.now()
  )
    fail(
      "The authenticated listing quote or policy deadline is missing or expired.",
      409,
    );
  const p = validateTypedData(plan.typedData!, plan.request, plan.scope);
  if (orderHash(p) !== plan.orderHash)
    fail("The native listing order changed.", 409);
}
function referenceFor(plan: NftPlan): NativeListingReference {
  if (
    !plan.taskPrincipal ||
    plan.kind !== "signature" ||
    !plan.typedData ||
    !plan.orderHash ||
    plan.transaction
  )
    fail(
      "Existing NFT approval is required; approval transactions are currently unsupported by the task listing port.",
      409,
    );
  if (orderHash(components(plan.typedData.message)) !== plan.orderHash)
    fail(
      "The native listing order hash does not match its canonical terms.",
      409,
    );
  // No wall-clock revalidation here: references must remain readable after expiry.
  const taskBinding = Object.fromEntries(
    bindingKeys.map((key) => [
      key,
      plan.taskPrincipal![key as keyof NftTaskBinding],
    ]),
  );
  return Object.freeze({
    schema: "artfi-native-nft-listing-reference/1",
    taskBinding: binding(taskBinding),
    nativeOperationId: plan.operationId,
    nativePlanId: plan.id,
    reviewDigest: kernelRequestDigest(plan),
    orderHash: plan.orderHash,
    typedDataDigest: TypedDataEncoder.hash(
      plan.typedData.domain,
      plan.typedData.types,
      plan.typedData.message,
    ),
  });
}
// JSON storage may reorder object keys. Match readNftRequest's original field
// projection without re-parsing or revalidating time: expired reviews stay readable.
function persistedRequestHash(request: NftRequest) {
  return nftRequestHash({
    action: request.action,
    collection: request.collection,
    tokenId: request.tokenId,
    account: request.account,
    quantity: request.quantity,
    priceWei: request.priceWei,
    expiresAt: request.expiresAt,
    ...(request.orderHash !== undefined
      ? { orderHash: request.orderHash }
      : {}),
  });
}
function checkReference(
  input: NativeListingReference,
  operation: NftOperation,
  principal: NftTaskPrincipal,
) {
  const actual = referenceFor(operation.plan);
  if (
    Object.keys(input).sort().join() !== Object.keys(actual).sort().join() ||
    operation.id !== input.nativeOperationId ||
    operation.plan.operationId !== operation.id ||
    operation.requestHash !== persistedRequestHash(operation.plan.request) ||
    operation.chainId !== operation.plan.chainId ||
    (operation.orderHash !== undefined &&
      operation.orderHash !== actual.orderHash) ||
    !equalAddress(operation.wallet, operation.plan.request.account) ||
    !sameBinding(input.taskBinding, actual.taskBinding) ||
    (
      [
        "schema",
        "nativeOperationId",
        "nativePlanId",
        "reviewDigest",
        "orderHash",
        "typedDataDigest",
      ] as const
    ).some((key) => input[key] !== actual[key])
  )
    fail(
      "The native listing reference does not match its durable review.",
      409,
    );
  principalMatches(operation.plan, principal);
}
function publication(operation: NftOperation): NativeListingPublication {
  return Object.freeze({
    reference: referenceFor(operation.plan),
    status: operation.status,
    ...(operation.orderHash ? { orderHash: operation.orderHash } : {}),
    publicationAccepted: operation.status === "accepted",
    saleComplete: false,
    settlement: "NOT_ASSESSED",
  });
}

/** No default runtime, HTTP handler, credential or environment-variable escape hatch. */
export function createNativeNftTaskPort(
  input: NativeNftTaskPortDependencies,
): NativeNftTaskPort {
  if (
    !input ||
    [
      input.verifyTaskBinding,
      input.withTaskAuthorization,
      input.journal,
      input.requireTrading,
      input.scope,
      input.provider,
      input.sdk,
      input.api,
    ].some((fn) => typeof fn !== "function")
  )
    fail("The authenticated task listing runtime is not configured.", 503);
  // Pin the composition's functions; later mutation cannot replace its verifier or journal.
  const deps = Object.freeze({ ...input });
  async function authorize(
    raw: NftTaskBinding,
    purpose: NftTaskPurpose,
    plan?: NftPlan,
    request?: NftRequest,
    scope?: NftScope,
  ) {
    const claimed = binding(raw);
    const task = structuredClone(
      await deps.verifyTaskBinding(claimed, {
        purpose,
        ...(plan ? { plan: structuredClone(plan) } : {}),
        ...(request ? { request: structuredClone(request) } : {}),
        ...(scope ? { scope: structuredClone(scope) } : {}),
      }),
    );
    if (!task || !sameBinding(binding(task.binding), claimed))
      fail("The task verifier returned another authorization.", 403);
    return task;
  }
  function context(
    task: VerifiedNftTask,
    purpose: NftTaskPurpose,
  ): NftEngineContext {
    const principal: NftTaskPrincipal = Object.freeze({
      ...binding(task.binding),
      kind: "task",
    });
    return {
      ...deps,
      binding: { taskPrincipal: principal },
      chainId: task.chainId,
      assertRequest: (request, scope) => assertListing(task, request, scope),
      assertPlan: (plan) => {
        principalMatches(plan, principal);
        assertListing(task, plan.request, plan.scope, purpose !== "observe");
      },
      validatePlan: async (plan) => {
        referenceFor(plan); // Reject approvals before they enter the task journal.
        const checked = await authorize(
          task.binding,
          purpose,
          plan,
          plan.request,
          plan.scope,
        );
        assertListing(checked, plan.request, plan.scope);
      },
      beforePublish: requireExistingListingApproval,
      publish: (plan, dispatch) =>
        withAuthorization(task.binding, "publish", plan, (fresh) =>
          dispatch(() => assertActivePlan(fresh, plan)),
        ),
      journal: (action, operation) =>
        deps.journal(principal, action, operation),
    };
  }
  async function withAuthorization<T>(
    claimed: NftTaskBinding,
    purpose: "review" | "publish",
    plan: NftPlan,
    action: (verified: VerifiedNftTask) => Promise<T>,
  ) {
    let entered = false;
    return deps.withTaskAuthorization(
      binding(claimed),
      purpose,
      structuredClone(plan),
      async (fresh) => {
        if (entered)
          fail("The task authorization capability was already consumed.", 409);
        entered = true;
        const verified = structuredClone(fresh);
        if (!sameBinding(binding(verified.binding), claimed))
          fail("The task verifier returned another authorization.", 403);
        assertActivePlan(verified, plan);
        return action(verified);
      },
    );
  }
  async function load(raw: NativeListingReference, purpose: NftTaskPurpose) {
    const reference = structuredClone(raw);
    object(reference);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(reference.nativeOperationId))
      fail("Invalid native listing operation.", 400);
    const task = await authorize(reference.taskBinding, purpose);
    const ctx = context(task, purpose);
    const operation = await ctx.journal("get", {
      id: reference.nativeOperationId,
    });
    checkReference(reference, operation, ctx.binding.taskPrincipal!);
    ctx.assertPlan(operation.plan);
    if (purpose !== "observe") {
      const checked = await authorize(
        task.binding,
        purpose,
        operation.plan,
        operation.plan.request,
        operation.plan.scope,
      );
      assertListing(checked, operation.plan.request, operation.plan.scope);
    }
    return { operation, ctx, reference };
  }
  return Object.freeze({
    async prepareListing(rawBinding, rawRequest) {
      const request = readNftRequest(structuredClone(rawRequest));
      const scope = structuredClone(deps.scope(request.collection));
      const task = await authorize(
        rawBinding,
        "prepare",
        undefined,
        request,
        scope,
      );
      const ctx = context(task, "prepare");
      const operationId = `native_${kernelRequestDigest(task.binding)}`;
      const operation = await prepareNftOperationWithContext(
        operationId,
        request,
        scope,
        ctx,
      );
      return referenceFor(operation.plan);
    },
    async reviewListing(rawReference) {
      const { operation, ctx, reference } = await load(rawReference, "review");
      await reviewNftOperationWithContext(operation, ctx);
      const rpc = ctx.provider(operation.plan.scope);
      try {
        await requireExistingListingApproval(operation.plan, rpc);
      } finally {
        rpc.destroy();
      }
      const p = validateTypedData(
        operation.plan.typedData!,
        operation.plan.request,
        operation.plan.scope,
      );
      if (orderHash(p) !== operation.plan.orderHash)
        fail("The listing order hash changed.", 409);
      const started = await withAuthorization(
        reference.taskBinding,
        "review",
        operation.plan,
        () => ctx.journal("update", { ...operation, walletStarted: true }),
      );
      return {
        reference: referenceFor(started.plan),
        plan: structuredClone(started.plan),
      };
    },
    async publishListing(reference, exactSignature) {
      const { operation, ctx } = await load(reference, "publish");
      return publication(
        await submitNftSignatureWithContext(operation, exactSignature, ctx),
      );
    },
    async readPublication(reference) {
      const { operation, ctx } = await load(reference, "observe");
      const current = await reconcileNftOperationWithContext(operation, ctx);
      return Object.freeze({
        ...publication(current),
        recoverySnapshot: Object.freeze({
          unsignedPlan: structuredClone(current.plan),
          walletStarted: Boolean(current.walletStarted),
          signingState:
            current.status !== "awaiting-wallet"
              ? ("PUBLICATION_RECORDED" as const)
              : current.walletStarted
                ? ("STARTED_OUTCOME_UNKNOWN" as const)
                : ("NOT_STARTED" as const),
          authority: "READ_ONLY_NOT_SIGNING_AUTHORIZATION" as const,
        }),
      });
    },
  });
}
