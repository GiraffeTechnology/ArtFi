import { pathToFileURL } from "node:url";
import { loadConfig, stableCode, bridgeToken } from "./config.mjs";
import { createSessionAuthenticator } from "./auth.mjs";
import { createRuntimeController } from "./composition.mjs";
import { createAgentHTTPServer } from "./transport.mjs";

export async function startAgentServer({
  config,
  environment = process.env,
  onState,
}) {
  const controller = createRuntimeController({ config, onState });
  const authenticate = createSessionAuthenticator({
    apiURL: config.authentication.apiURL,
    userAuthBridgeToken: bridgeToken(environment.ARTFI_USER_AUTH_BRIDGE_TOKEN),
    agentBridgeToken: bridgeToken(environment.ARTFI_AGENT_BRIDGE_TOKEN),
    webOrigin: config.webOrigin,
    allowedChainIds: config.authentication.allowedChainIds,
  });
  const server = createAgentHTTPServer({
    authenticate,
    getRuntimeStatus: controller.getStatus,
    getService: controller.getService,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const abort = new AbortController();
  const work = controller.run({ signal: abort.signal });
  let closing = false;
  return Object.freeze({
    address: server.address(),
    status: controller.getStatus,
    async close() {
      if (closing) return;
      closing = true;
      abort.abort();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      await work;
      await controller.close();
    },
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = await loadConfig(process.env.ARTFI_AGENT_CONFIG_FILE);
    let previous = "";
    const server = await startAgentServer({
      config,
      onState: (state) => {
        const identity = JSON.stringify({
          state: state.state,
          reason: state.reason,
        });
        if (identity !== previous) {
          previous = identity;
          process.stdout.write(
            JSON.stringify({ event: "AGENT_RUNTIME_STATE", ...state }) + "\n",
          );
        }
      },
    });
    process.stdout.write(
      JSON.stringify({
        event: "AGENT_RUNTIME_LISTENING",
        mode: config.mode,
        host: config.listen.host,
        port: server.address.port,
        productionReady: false,
      }) + "\n",
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        event: "AGENT_RUNTIME_START_REFUSED",
        code: stableCode(error, "AGENT_RUNTIME_CONFIGURATION_UNAVAILABLE"),
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
