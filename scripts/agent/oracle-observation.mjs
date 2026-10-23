// Trusted optional composition. Inject Oracle's SDK verifier; never treat
// projection finality or D1 mint authority as an attestation-validity verdict.
export function createOracleObservation({
  mode,
  observe,
  resolveRequiredAttestation,
  verifyOracleAttestation,
  attestationService,
  clock = () => new Date(),
}) {
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    [observe, resolveRequiredAttestation, verifyOracleAttestation, clock].some(
      (fn) => typeof fn !== "function",
    ) ||
    typeof attestationService?.verify !== "function"
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
      const result = await verifyOracleAttestation(
        attestationService,
        structuredClone(attestation),
        structuredClone(expectedSubject),
        now,
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
    subject.chainId !== request?.execution?.chainId ||
    subject.contract.toLowerCase() !== request?.sale?.nft?.toLowerCase() ||
    subject.tokenId !== request?.sale?.tokenId
  )
    throw Error("ORACLE_EVIDENCE_IDENTITY_INVALID");
}
