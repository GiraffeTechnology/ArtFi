# Single held receipt action composition

The existing Wallet `createReceiptProviderHandler` opens `authorization.withAuthorization` from inside `sendTransaction`. Its actual `createTaskReceiptRuntime` composes that same callback with the journal registry's `withHeld`. Opening another grant gate around an ArtFi journal action would re-enter the serialized grant store; doing the journal CAS before the provider's gate would leave it outside the receipt held context.

`createWholeReceiptHeldAction` is an ArtFi-side installation composer for these **existing method shapes**. A trusted installer supplies the already configured receipt runtime, the exact fixed Wallet provider-handler factory, its existing provider, frozen task, full phase claim and clock. Nothing is loaded from an HTTP request, module path or environment fallback. The returned `authorize` matches the existing ArtFi executor's task/plan/action/request callback shape.

Sequence:

1. Validate the complete native plan/principal and exact five-field request. Create the existing Wallet handler with a narrowly interposed authorization method.
2. Let that handler construct its existing exact phase wire. Compare native business terms to its frozen task before spending an attempt, then call the **real runtime authority once**.
3. Inside the real held callback, recheck task/executor/phase/nonce/commitment/deadline bindings and business terms. Pass the ArtFi executor callback an immutable lease whose wallet can invoke only the handler's captured original provider callback, once, for the exact request. The pinned Wallet handler retains its identity, runtime code, nonce, fee, simulation and provider confirmation checks.
4. The existing executor must perform its authenticated journal reads/CAS before calling this lease. A consumer rejection or failed CAS throws before provider dispatch. The composer does not manufacture a CAS receipt or accept a browser claim that it happened.
5. Return the exact known provider hash to the existing Wallet authority so it can durably record its attempt. If the ArtFi callback fails after a known dispatch, let Wallet record that hash, then propagate the ArtFi failure. A lost Wallet acknowledgement is also an error. No native success is returned before the real gate settles.

The lease burns its dispatch flag before awaiting the provider. An already started dispatch is drained before the held callback exits, including when the ArtFi callback fails before awaiting its send. A provider throw/timeout, malformed hash, stopped/expired context, changed request, callback duplication or unknown persistence result never opens a retry. The composer instance is single-attempt. Reconciliation reads the existing durable operation/attempt; it does not reconstruct a fresh instance as permission to resend.

Integration boundaries remain explicit:

- This is initial source composition, not an installed execution path. The factory must be the reviewed Wallet source, not the synthetic test factory. The runtime's grant store and native journal store remain independent, with real mTLS/one-use capabilities and unchanged principal/full-plan/request digests.
- Non-send journal create/review/recovery must use the existing runtime authority's `withPreparation` with its exact purpose rules. This composer does not call `readState` or reopen that gate from inside a held send. The initial read in the old executor must be composed through that preparation context by the integration owner; it is not silently made authoritative here.
- The business comparison retains `planDigest` and `journalBindingHash` as opaque commitments. It does not resolve their source-owned encoding contract. The submitted Go consumer's unsupported-receipt rejection stays closed until that exact contract and immutable row/recovery bindings are implemented and independently accepted. Pure comparison is not an approval verdict.
- No Wallet code, credentials, signer, HTTP endpoint, provider fallback, policy scope, deployment, production journal or submitted consumer file is changed. No mainnet/real-value or human-signature bypass is enabled.

Regression source uses a synthetic gate and a factory with the pinned method shape to inspect sequencing, one-shot behavior, consumer refusal, unknown provider/Wallet acknowledgements, known-hash preservation, lease expiry, changed identity/request, re-entry and callback duplication. It is not real Wallet/native DB/mTLS/Kit or on-chain acceptance. Ordinary Linux tests, typecheck, real exact-source integration and all post-submission repairs belong to the independent acceptance owner.
