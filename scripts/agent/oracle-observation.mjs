// Trusted optional composition. Runtime callers inject Oracle's application API
// verifier. Direct SDK injection remains only for the explicit synthetic
// compatibility test. Projection finality and D1 mint authority never become
// an attestation-validity verdict.
export function createOracleApiVerifier({ mode, verifyUrl, fetchImpl }) {
  let endpoint;
  try {
    endpoint = new URL(verifyUrl);
  } catch {
    throw Error("ORACLE_API_CONFIGURATION_INVALID");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    typeof fetchImpl !== "function" ||
    endpoint.pathname !== "/v1/rwa/attestations/verify" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback.has(endpoint.hostname)))
  )
    throw Error("ORACLE_API_CONFIGURATION_INVALID");

  return async (attestation, expectedSubject, _now, signal) => {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ attestation, expectedSubject }),
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const code = safeCode(error?.code ?? error?.message);
      throw Error(code.startsWith("SOURCE_") ? code : "SOURCE_UNAVAILABLE");
    }
    signal?.throwIfAborted();
    if (!response || typeof response.status !== "number")
      throw Error("SOURCE_UNAVAILABLE");
    if (response.redirected === true)
      throw Error("ATTESTATION_VERIFICATION_FAILED");
    if (!response.ok) {
      if (response.status === 429) throw Error("SOURCE_RATE_LIMITED");
      if ([502, 503, 504].includes(response.status))
        throw Error("SOURCE_UNAVAILABLE");
      throw Error("ATTESTATION_VERIFICATION_FAILED");
    }
    if (typeof response.json !== "function")
      throw Error("ATTESTATION_VERIFICATION_FAILED");
    let result;
    try {
      result = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw Error("ATTESTATION_VERIFICATION_FAILED");
    }
    signal?.throwIfAborted();
    if (
      typeof result?.valid !== "boolean" ||
      (result.valid === true && result.errorCode !== null) ||
      (result.valid === false &&
        (typeof result.errorCode !== "string" ||
          safeCode(result.errorCode) !== result.errorCode))
    )
      throw Error("ATTESTATION_VERIFICATION_FAILED");
    return { valid: result.valid, errorCode: result.errorCode };
  };
}

export function createOracleObservation({
  mode,
  observe,
  resolveRequiredAttestation,
  verifyAttestation,
  verifyOracleAttestation,
  attestationService,
  clock = () => new Date(),
}) {
  const verifier =
    typeof verifyAttestation === "function"
      ? verifyAttestation
      : typeof verifyOracleAttestation === "function" &&
          typeof attestationService?.verify === "function"
        ? (attestation, expectedSubject, now, signal) =>
            verifyOracleAttestation(
              attestationService,
              attestation,
              expectedSubject,
              now,
              signal,
            )
        : null;
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    [observe, resolveRequiredAttestation, clock].some(
      (fn) => typeof fn !== "function",
    ) ||
    verifier === null
  )
    throw Error("ORACLE_ADAPTER_CONFIGURATION_INVALID");
  return async (request, signal) => {
    signal?.throwIfAborted();
    let observation = {};
    let optional = false;
    let identity = {};
    try {
      const required = await resolveRequiredAttestation(
        structuredClone(request),
        signal,
      );
      signal?.throwIfAborted();
      // A trusted policy resolver, never caller JSON, selects required flows.
      if (required === null) {
        optional = true;
        return await observe(structuredClone(request), signal);
      }
      observation = structuredClone(
        await observe(structuredClone(request), signal),
      );
      signal?.throwIfAborted();
      const { attestation, expectedSubject } = required ?? {};
      if (
        !attestation ||
        !expectedSubject ||
        ["assetId", "chainId", "contract", "tokenId", "purpose"].some(
          (key) =>
            typeof expectedSubject[key] !== "string" || !expectedSubject[key],
        )
      )
        throw Error("EXPECTED_SUBJECT_INCOMPLETE");
      const subject = Object.fromEntries(
        ["assetId", "chainId", "contract", "tokenId", "purpose"].map((key) => [
          key,
          expectedSubject[key],
        ]),
      );
      const attestationId = attestation.envelope?.attestationId;
      assertOracleIdentity(
        { attestationId, expectedSubject: subject },
        request,
      );
      identity = { attestationId, expectedSubject: subject };
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw Error("ORACLE_CLOCK_INVALID");
      const result = await verifier(
        structuredClone(attestation),
        structuredClone(expectedSubject),
        now,
        signal,
      );
      signal?.throwIfAborted();
      const valid = result?.valid === true && result.errorCode === null;
      const errorCode = valid ? null : safeCode(result?.errorCode);
      return {
        ...observation,
        ...(errorCode?.startsWith("SOURCE_")
          ? { available: false, current: false }
          : {}),
        groundingCurrent: valid && observation.groundingCurrent !== false,
        ...(errorCode === "REVOKED" ? { assetRestricted: true } : {}),
        oracleAttestation: {
          valid,
          errorCode,
          checkedAt: now.toISOString(),
          ...identity,
        },
      };
    } catch (error) {
      if (optional) throw error;
      signal?.throwIfAborted();
      return {
        ...observation,
        available: false,
        current: false,
        groundingCurrent: false,
        oracleAttestation: {
          ...identity,
          valid: false,
          errorCode: safeCode(error?.code ?? error?.message),
        },
      };
    }
  };
}
function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : "ATTESTATION_VERIFICATION_FAILED";
}

export function assertOracleIdentity(value, request) {
  const subject = value?.expectedSubject;
  const keys = ["assetId", "chainId", "contract", "tokenId", "purpose"];
  if (
    typeof value?.attestationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value?.attestationId ?? "") ||
    !subject ||
    Object.keys(subject).length !== keys.length ||
    keys.some(
      (key) =>
        typeof subject[key] !== "string" ||
        subject[key].length < 1 ||
        subject[key].length > 128,
    ) ||
    !/^0x[0-9a-fA-F]{40}$/.test(subject.contract) ||
    !/^(0|[1-9][0-9]{0,77})$/.test(subject.tokenId) ||
    BigInt(subject.tokenId) > (1n << 256n) - 1n ||
    subject.chainId !== request?.execution?.chainId ||
    subject.contract.toLowerCase() !== request?.sale?.nft?.toLowerCase() ||
    subject.tokenId !== request?.sale?.tokenId
  )
    throw Error("ORACLE_EVIDENCE_IDENTITY_INVALID");
}
