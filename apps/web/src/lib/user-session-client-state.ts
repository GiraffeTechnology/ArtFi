import type { Address } from "viem";

export type UserSession = {
  id: string;
  address: Address;
  chainId: number;
  expiresAt: number;
  accessExpiresAt: number;
};
export type UserWalletStatus =
  "connected" | "disconnected" | "connecting" | "reconnecting";
export type SessionWallet = {
  address?: string;
  chainId?: number;
  status: UserWalletStatus;
};
export type UserSessionState = {
  session: UserSession | null;
  authenticated: boolean;
  walletStatus: UserWalletStatus;
  revision: number;
  busy: boolean;
  signingIn: boolean;
  signOutPending: boolean;
  detail: string;
};
export function sameWallet(
  session: { address: string; chainId: number },
  address?: string,
  chainId?: number,
) {
  return Boolean(
    address &&
    session.address.toLowerCase() === address.toLowerCase() &&
    session.chainId === chainId,
  );
}
export function authenticatedSession(
  session: UserSession | null,
  wallet: SessionWallet,
) {
  return Boolean(
    session &&
    wallet.status === "connected" &&
    sameWallet(session, wallet.address, wallet.chainId) &&
    session.expiresAt > Date.now(),
  );
}
export const initialUserSessionState: UserSessionState = {
  session: null,
  authenticated: false,
  walletStatus: "disconnected",
  revision: 0,
  busy: false,
  signingIn: false,
  signOutPending: false,
  detail: "",
};
