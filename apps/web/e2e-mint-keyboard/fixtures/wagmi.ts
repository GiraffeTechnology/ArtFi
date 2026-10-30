// Disconnected TEST_ONLY hooks. Calling a wallet operation is always a test failure.
export const calls = { sign: 0, write: 0 };
export function useAccount() {
  return { address: undefined, isConnected: false };
}
export function useChainId() {
  return 560048;
}
export function usePublicClient() {
  return undefined;
}
export function useReadContract() {
  return { data: undefined };
}
export function useWriteContract() {
  return {
    writeContractAsync: async () => {
      calls.write++;
      throw Error("Unexpected TEST_ONLY write");
    },
  };
}
export function useSignMessage() {
  return {
    signMessageAsync: async () => {
      calls.sign++;
      throw Error("Unexpected TEST_ONLY signature");
    },
  };
}
