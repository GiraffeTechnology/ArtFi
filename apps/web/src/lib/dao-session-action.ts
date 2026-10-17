import { isAddress, type Address } from "viem";
import {
  authenticatedSession,
  type UserSession,
} from "./user-session-client-state";

/** Platform authentication is separate from token membership and contract permission. */
export async function runDaoSessionAction<T>({
  account,
  chainId,
  assertSession,
  isCurrent,
  prepare,
  execute,
}: {
  account: Address;
  chainId: number;
  assertSession: (account: string, chainId: number) => Promise<UserSession>;
  isCurrent: () => boolean;
  prepare: () => Promise<unknown>;
  execute: () => Promise<T>;
}): Promise<T> {
  if (!isAddress(account) || /^0x0{40}$/i.test(account) || chainId !== 560048)
    throw Error("Connect the corresponding holder wallet on Hoodi.");
  const current = () => {
    if (!isCurrent())
      throw Error("The wallet session or DAO action changed. Review it again.");
  };
  const authenticated = async () => {
    current();
    const session = await assertSession(account, chainId);
    current();
    if (
      !authenticatedSession(session, {
        address: account,
        chainId,
        status: "connected",
      })
    )
      throw Error("Sign in with the corresponding holder wallet to continue.");
  };
  await authenticated();
  await prepare();
  current();
  await authenticated();
  current();
  // This is the first place a wallet prompt may open. A submitted result still
  // belongs to the original operation even if the user navigates afterwards.
  return execute();
}
