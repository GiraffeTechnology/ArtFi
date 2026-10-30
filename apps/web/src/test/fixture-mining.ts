/** TEST_ONLY mined inclusion ledger. A submitted transaction is not a receipt. */
export function fixtureMining(blockHash: string, minedBlock = "0x64") {
  const mined = new Set<string>();
  return {
    observeReceipt(hash: string) {
      mined.add(hash.toLowerCase());
    },
    inclusion(hash: string) {
      const included = mined.has(hash.toLowerCase());
      return {
        blockHash: included ? blockHash : null,
        blockNumber: included ? minedBlock : null,
        transactionIndex: included ? "0x0" : null,
      };
    },
    block(tag: unknown, latest: number) {
      if (tag === "pending") return { number: null, hash: null };
      if (tag === "latest" || tag === undefined)
        return { number: `0x${latest.toString(16)}`, hash: blockHash };
      if (tag === "earliest") return { number: "0x0", hash: blockHash };
      if (typeof tag === "string" && /^0x[\da-f]+$/i.test(tag))
        return { number: `0x${BigInt(tag).toString(16)}`, hash: blockHash };
      throw new Error("Unsupported TEST_ONLY block tag");
    },
  };
}
