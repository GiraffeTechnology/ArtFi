import { createIntentAuthorizer, INTENT_TYPES } from "./bounded-intent.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { SALE_TYPES } from "./buy-receipt.mjs";
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validTransactionHash = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{64}$/.test(value) &&
  !/^0x0{64}$/i.test(value);

// Transport-independent service. session is supplied ONLY by authenticated
// middleware, not JSON/body/query input. No sign/broadcast endpoint is exposed.
export function createAgentService({
  mode,
  ethers: e,
  store,
  policy,
  planFor,
  observe,
  inspectRevocation,
  clock = Date.now,
  sourceObservationTimeoutMs = 3000,
}) {
  if (mode !== "TEST_ONLY_NO_REAL_VALUE") fail("SERVICE_CONFIGURATION_INVALID");
  if (
    !Number.isSafeInteger(sourceObservationTimeoutMs) ||
    sourceObservationTimeoutMs < 10 ||
    sourceObservationTimeoutMs > 30000
  )
    fail("SERVICE_CONFIGURATION_INVALID");
  const fixed = structuredClone(policy);
  const policyHashes = [
    "allowedCounterpartyPolicy",
    "allowedVenuePolicy",
    "jurisdictionPolicy",
    "settlementPolicy",
  ];
  if (
    !fixed ||
    typeof fixed !== "object" ||
    Arra