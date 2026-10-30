// TEST_ONLY child-owned loopback listener handshake. Never probes/reuses an existing port.
export function waitForOwnedListener(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exited);
      child.off("error", failed);
    };
    const finish = (error, value) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const exited = () => finish(Error("ISOLATED_SERVER_EXITED_BEFORE_READY"));
    const failed = () => finish(Error("ISOLATED_SERVER_SPAWN_FAILED"));
    const message = (value) => {
      if (value?.type !== "ARTFI_TEST_OWNED_LISTENER") return;
      if (
        !child.connected ||
        !Number.isSafeInteger(child.pid) ||
        child.pid <= 0 ||
        value.pid !== child.pid ||
        value.host !== "127.0.0.1" ||
        !Number.isSafeInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535
      ) {
        finish(Error("ISOLATED_LISTENER_OWNERSHIP_INVALID"));
        return;
      }
      finish(null, `http://127.0.0.1:${value.port}`);
    };
    child.on("message", message);
    child.once("exit", exited);
    child.once("error", failed);
    timer = setTimeout(
      () => finish(Error("ISOLATED_SERVER_START_TIMEOUT")),
      timeoutMs,
    );
    if (child.exitCode !== null || child.signalCode !== null) exited();
  });
}
