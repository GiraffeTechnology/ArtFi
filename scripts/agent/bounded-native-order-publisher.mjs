// Nonproduction typed publication transport. Existing EOA seller/JWT routes are
// untouched; caller supplies the separate, explicitly configured authenticated port.
export function createBoundedNativeOrderPublisher({
  chain,
  ledger,
  request,
  mode,
}) {
  if (
    !chain ||
    !ledger ||
    typeof request !== "function" ||
    !["OWNER_SESSION", "BOUNDED_SERVICE_RELAY"].includes(mode)
  )
    throw Error("BOUNDED_PUBLICATION_CONFIGURATION_REQUIRED");
  const fail = (code) => {
    throw Error(code);
  };
  const same = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase();
  function own(key) {
    const r = ledger.get(key);
    if (
      !r ||
      !same(r.account, chain.config.account) ||
      !same(r.owner, chain.config.owner) ||
      r.chainId !== chain.config.chainId
    )
      fail("BOUNDED_PUBLICATION_ORDER_NOT_FOUND");
    return r;
  }
  async function lookup(record, signal) {
    const order = record.order,
      path = `/v1/orders/${order.intentHash}?chainId=${order.chainId}&marketAddress=${order.marketAddress}`;
    const response = await request({ method: "GET", path, signal });
    if (response?.status === 404) return null;
    if (response?.status !== 200 || !response.body)
      fail("BOUNDED_PUBLICATION_READ_UNAVAILABLE");
    return response.body;
  }
  return Object.freeze({
    async publish(key, signal) {
      const record = own(key),
        started = ledger.beginPublication(key);
      try {
        const existing = await lookup(record, signal);
        if (existing)
          return {
            kind: "ORDER_PUBLICATION",
            record: ledger.markPublication(key, existing),
            recovered: true,
            settlement: false,
          };
        // A missing readback does not prove a prior request failed. Even though
        // native storage is immutable/idempotent, unknown transport never retries.
        if (!started.firstAttempt)
          return {
            kind: "ORDER_PUBLICATION",
            state: "UNKNOWN",
            reason: "BOUNDED_PUBLICATION_RECONCILIATION_REQUIRED",
            settlement: false,
          };
        // Integration injects the chain verifier's canonical wire digest helper.
        const envelopeSHA256 = chain.envelopeSHA256(record.order);
        const proof = await chain.verifyBoundedOrder(
          {
            order: record.order,
            owner: chain.config.owner,
            runtimeCodeHash: chain.config.accountCodeHash,
            sellRegistry: chain.config.sellRegistry,
            sellRegistryCodeHash: chain.config.sellRegistryCodeHash,
            envelopeSHA256,
          },
          signal,
        );
        await chain.recheckCanonicalBlock(proof.block, signal);
        const path =
          mode === "BOUNDED_SERVICE_RELAY"
            ? "/v1/indexer/bounded-order-relay/v1"
            : "/v1/indexer/bounded-signed-orders";
        const body =
          mode === "BOUNDED_SERVICE_RELAY"
            ? {
                schema: "artfi-bounded-order-relay/1",
                action: "PUBLISH_REGISTERED_ORDER",
                order: record.order,
              }
            : record.order;
        const result = await request({
          method: "POST",
          path,
          body: JSON.stringify(body),
          signal,
        });
        if (![200, 201].includes(result?.status) || !result.body)
          fail("BOUNDED_PUBLICATION_NOT_ACKNOWLEDGED");
        return {
          kind: "ORDER_PUBLICATION",
          record: ledger.markPublication(key, result.body),
          recovered: false,
          settlement: false,
        };
      } catch (error) {
        if (ledger.get(key).publication.state !== "PUBLISHED")
          ledger.unknownPublication(
            key,
            /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
              ? error.message
              : "BOUNDED_PUBLICATION_UNAVAILABLE",
          );
        throw error;
      }
    },
    async recover(key, signal) {
      const record = own(key),
        found = await lookup(record, signal);
      if (!found)
        return {
          kind: "ORDER_PUBLICATION",
          state: "UNKNOWN",
          settlement: false,
        };
      return {
        kind: "ORDER_PUBLICATION",
        record: ledger.markPublication(key, found),
        recovered: true,
        settlement: false,
      };
    },
  });
}
