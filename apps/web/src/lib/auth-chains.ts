/** Session support is distinct from transaction authority or live availability. */
export const sessionChainIds = [560048, 1, 8453] as const;
export function isSessionChain(value: unknown): value is number {
  return (
    typeof value === "number" &&
    sessionChainIds.some((chain) => chain === value)
  );
}
export function enabledSessionChain(value: unknown) {
  const configured = process.env.ARTFI_USER_AUTH_CHAIN_IDS?.trim() || "560048";
  return (
    isSessionChain(value) &&
    configured
      .split(",")
      .map((item) => item.trim())
      .includes(String(value))
  );
}
