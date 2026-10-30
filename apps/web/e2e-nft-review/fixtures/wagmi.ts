// TEST_ONLY callbacks. No provider, RPC, key material, signature or broadcast.
import { useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
export const account = "0x1111111111111111111111111111111111111111" as Address;
const wallet = { address: account, chainId: 1, status: "connected" as const };
export const fixture = {
  mode: "normal",
  signs: 0,
  sends: 0,
  reads: 0,
  async address() {
    this.reads++;
    return [account];
  },
  dump() {
    return { signs: this.signs, sends: this.sends, reads: this.reads };
  },
  setMode(mode: string) {
    this.mode = mode;
  },
};
const client = {
  chain: { id: 1 },
  getAddresses: async () => fixture.address(),
  getChainId: async () => 1,
  signTypedData: async () => {
    fixture.signs++;
    if (fixture.mode === "wallet-unknown")
      throw Error("TEST_ONLY uncertain wallet response");
    return `0x${"01".repeat(65)}` as Hex;
  },
  sendTransaction: async () => {
    fixture.sends++;
    if (fixture.mode === "wallet-unknown")
      throw Error("TEST_ONLY uncertain wallet response");
    return `0x${"ab".repeat(32)}` as Hex;
  },
};
export function useAccount() {
  return useSyncExternalStore(
    () => () => undefined,
    () => wallet,
    () => wallet,
  );
}
export function useWalletClient() {
  return { data: client };
}
export function useSignMessage() {
  return {
    signMessageAsync: async () => {
      throw Error("TEST_ONLY unexpected login signing");
    },
  };
}
