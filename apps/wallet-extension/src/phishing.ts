const blockedSuffixes = [".invalid", ".example-phish.test"];

export function assertSafeOrigin(
  value: string,
  extraBlockedHosts: readonly string[] = [],
): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "localhost")
  ) {
    throw new Error(
      "wallet origins must use HTTPS, except localhost development",
    );
  }
  const hostname = origin.hostname.toLowerCase();
  if (
    hostname.startsWith("xn--") ||
    hostname.split(".").some((label) => label.startsWith("xn--"))
  ) {
    throw new Error(
      "internationalized hostnames require manual security review",
    );
  }
  const blocked = [
    ...blockedSuffixes,
    ...extraBlockedHosts.map((host) => host.toLowerCase()),
  ];
  if (
    blocked.some(
      (suffix) =>
        hostname === suffix.replace(/^\./, "") || hostname.endsWith(suffix),
    )
  ) {
    throw new Error("origin is blocked by phishing policy");
  }
  return origin.origin;
}
