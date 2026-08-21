export function assertSinPublicChainExecution(
  zone = process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE,
): void {
  if (zone?.trim() !== "sin") {
    throw new Error(
      "Public-chain and OpenSea runtime access is restricted to the SIN execution zone.",
    );
  }
}
