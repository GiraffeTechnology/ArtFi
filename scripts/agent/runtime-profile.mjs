// Environment labels do not grant spending authority. A configured runtime
// still needs its concrete supported, independently enforced authority adapter.
export const TEST_MODE = "TEST_ONLY_NO_REAL_VALUE";
export const BOUNDED_MODE = "BOUNDED_SIGNED_AUTHORITY";
export function validRuntimeMode(mode) {
  return mode === TEST_MODE || mode === BOUNDED_MODE;
}
export function validChainId(value) {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
