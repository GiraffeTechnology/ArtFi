# Whole-receipt installation composition

The server entry exports `createWholeReceiptInstallation` alongside the existing
whole-receipt execution and native-journal compositions. It connects those
existing product ports to an installation's fixed Wallet receipt implementation.
It does not create an authorization service, signer, provider, store or HTTP
endpoint.

## Installation sequence

1. Supply the installed Wallet `createTaskReceiptRuntime` and
   `createReceiptProviderHandler` functions as trusted server-owned functions.
   These inputs must never come from a browser, task JSON, module name or URL.
2. Supply the original grant store, the independent original journal store,
   the original executor identity, the selected original provider and the
   authenticated native-journal transport and workload identities.
3. Pass the returned `authOptions` as the `artfi` channel of the original Wallet
   `composeTaskAuthOptions`, preserving all other configured channels.
4. Construct the original authorization service with those composed options.
   Connect its original `taskReceiptAuthorization` port exactly once with
   `connectAuthorization`. The original authority checks store independence.
5. Bind `consumeCapability` only to the existing authenticated server consumer.
   Pass the genuine authenticated peer identity separately from request data.
   This function delegates the exact original registry semantics; calling it
   does not create an endpoint or authenticate a peer.
6. Obtain the original server-validated task and receipt claim, then call
   `operation({ task, claimed })`. Use the returned `create`, `read` and
   `execute` methods with the existing unsigned native plan and exact wire.
7. Call `stop` during original service shutdown. New operations are fenced,
   while accepted sends retain the original Wallet reservation and journal
   capabilities until their known outcome has drained.

The journal configuration accepts only `url`, `peerId` and `transport`.
Its capability callback is always the installed receipt runtime's callback.
There is no second grant gate, request-selected provider or capability callback.

The wire/request digest remains `nftTaskJournalDigest`; native operation
identity remains `kernelRequestDigest`. The preapproval receipt phase
commitments retain their existing separate namespace. No digest is substituted
for another and no source, asset or execution authority is derived from matching
content alone.

## Outcomes and recovery

The returned operation uses the original ArtFi execution composition, including
durable compare-and-swap before a single provider dispatch, complete task
principal and receipt bindings, and known-hash acknowledgement. A lost send or
journal reply requires reconciliation of the same operation. Constructing another
operation object does not grant another attempt.

A failed authorization connection stops that new installation and cannot be
retried through it. An unexpected already-connected runtime is refused without
stopping that shared runtime. Shutdown is idempotent and delegates the accepted
send cutoff and drain to the original Wallet runtime. The capability consumer
does not impose an extra shutdown fence on an already accepted send.

The structural tests use explicitly marked test-only authority, transport and
store ports. They verify composition behavior; they do not establish real grant,
peer, database persistence, chain execution or installed-product acceptance.
Actual installation and end-to-end acceptance require the original configured
authority, independent stores, authenticated transport and exact installed
versions. Missing installation bindings remain explicit; the existence of this
factory alone is not a deployment or acceptance result.
