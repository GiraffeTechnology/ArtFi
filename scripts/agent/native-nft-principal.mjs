const fields = [
  "kind",
  "taskId",
  "taskDigest",
  "executorDigest",
  "grantReference",
  "grantPolicyVersion",
  "operationId",
];
const scopedId = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value) =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);

// Preserve the existing native task-journal principal. This is identity
// validation, not a task/grant verifier, signer or authorization capability.
export function readNativeNftTaskPrincipal(value) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    value.kind !== "task" ||
    !scopedId(value.taskId) ||
    !scopedId(value.operationId) ||
    !digest(value.taskDigest) ||
    !digest(value.executorDigest) ||
    typeof value.grantReference !== "string" ||
    !/^grant:[A-Za-z0-9_-]{1,122}$/.test(value.grantReference) ||
    typeof value.grantPolicyVersion !== "string" ||
    !/^[1-9][0-9]{0,77}$/.test(value.grantPolicyVersion) ||
    BigInt(value.grantPolicyVersion) >= 2n ** 256n
  )
    throw Error("NATIVE_NFT_TASK_PRINCIPAL_INVALID");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, value[field]])),
  );
}

// A task-bound compiled leg, dispatch and trusted observation/recovery result
// must carry the same full principal. Legacy session plans remain separate.
export function nativeNftTaskPrincipalMatches(leg, observed) {
  const expected = leg.nativeTaskPrincipal;
  const dispatched = leg.dispatch?.args?.taskPrincipal;
  if (expected === undefined)
    return dispatched === undefined && observed === undefined;
  try {
    const principal = readNativeNftTaskPrincipal(expected);
    const dispatch = readNativeNftTaskPrincipal(dispatched);
    const evidence = readNativeNftTaskPrincipal(observed);
    return fields.every(
      (field) =>
        principal[field] === dispatch[field] &&
        principal[field] === evidence[field],
    );
  } catch {
    return false;
  }
}
