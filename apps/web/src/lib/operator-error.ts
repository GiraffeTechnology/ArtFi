/** Wallet libraries include full calldata in Error.message. Keep the visible explanation concise. */
export function operatorErrorText(
  error: unknown,
  fallback = "The operator action could not be completed.",
) {
  if (
    error &&
    typeof error === "object" &&
    "shortMessage" in error &&
    typeof error.shortMessage === "string" &&
    error.shortMessage.trim()
  )
    return error.shortMessage.trim();
  return error instanceof Error ? error.message : fallback;
}
