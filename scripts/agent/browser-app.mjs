import { mountAgentConsole } from "./agent-console.mjs";
import { createAgentBrowserWallet } from "./browser-wallet.mjs";
import { createAgentHttpApi } from "./http-api.mjs";

const fail = (code) => {
  throw Error(code);
};

export function mountAgentBrowserApp(
  root,
  {
    fetchImpl,
    basePath,
    provider,
    sendRevocation,
    requestTimeoutMs,
    maxResponseBytes,
    clock = Date.now,
    maxObservationAgeMs = 30000,
    revocationStorage,
  } = {},
) {
  if (
    !root ||
    typeof root.replaceChildren !== "function" ||
    typeof root.append !== "function" ||
    typeof root.ownerDocument?.createElement !== "function"
  )
    fail("BROWSER_APP_ROOT_INVALID");
  const api = createAgentHttpApi({
    fetchImpl,
    basePath,
    requestTimeoutMs,
    maxResponseBytes,
  });
  const wallet = createAgentBrowserWallet({ provider, sendRevocation });
  return mountAgentConsole(root, {
    api,
    wallet,
    clock,
    maxObservationAgeMs,
    revocationStorage,
  });
}
