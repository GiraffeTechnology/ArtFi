// Isolated browser integration fixture only; deliberately outside src/.
// No private key is written or returned. Receipts are synthetic, never live.
import { createServer } from "node:http";
import { actionFixture, syntheticEvidence } from "./action-fixtures.mjs";
import { TEST_ADAPTER_CONTRACT } from "../src/adapter.mjs";
const f = await actionFixture(),
  quote = await f.order(),
  evidence = new Map();
let executeCalls = 0,
  loseNextResponse = false;
const token = process.env.ARTFI_AGENT_TEST_ADAPTER_TOKEN;
if (token !== "TEST_ONLY_LOCAL_BROWSER_ADAPTER_CREDENTIAL")
  throw Error("ISOLATED_FIXTURE_REQUIRED");
const reply = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/test-only/info" && request.method === "GET")
      return reply(response, 200, {
        mode: "TEST_ONLY_NO_REAL_VALUE",
        policy: f.policy,
        quote,
        asset: f.asset,
        payment: f.payment,
        market: f.market,
        executeCalls,
      });
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 131072) throw Error("ISOLATED_BODY_TOO_LARGE");
    }
    const body = JSON.parse(text);
    if (request.headers.authorization !== `Bearer ${token}`)
      return reply(response, 401, {});
    if (request.url === "/test-only/control") {
      loseNextResponse = body.loseNextResponse === true;
      return reply(response, 200, { mode: "TEST_ONLY_NO_REAL_VALUE" });
    }
    if (
      body.contract !== TEST_ADAPTER_CONTRACT ||
      body.mode !== "TEST_ONLY_NO_REAL_VALUE"
    )
      throw Error("ISOLATED_CONTRACT_MISMATCH");
    const { input } = body,
      method = request.url.split("/").at(-1);
    let result;
    if (method === "policy")
      result = {
        ...f.policy,
        collection: f.asset,
        paymentToken: f.payment,
        venue: f.market,
        actionPolicy: f.policy,
      };
    else if (method === "action-observe") {
      const a = input.record.authority;
      result = f.observe(input.leg, {
        authority: {
          wallet: a.intent.wallet,
          nonce: a.intent.nonce,
          intentDigest: a.intentDigest,
          chainId: a.domain.chainId,
          assetScope: a.intent.assetScope,
          revocationRef: a.intent.revocationRef,
        },
      });
    } else if (method === "action-execute") {
      executeCalls++;
      const proof = syntheticEvidence(
        input.leg,
        input.context.operationId,
        input.context.legIndex,
      );
      evidence.set(
        `${input.context.operationId}:${input.context.legIndex}`,
        proof,
      );
      if (loseNextResponse) {
        loseNextResponse = false;
        return reply(response, 503, { code: "TEST_ONLY_LOST_ACKNOWLEDGEMENT" });
      }
      result = { transactionHash: proof.transaction.hash };
    } else if (method === "action-evidence")
      result =
        evidence.get(`${input.record.id}:${input.record.cursor}`) ?? null;
    else if (method === "observe")
      result = { available: false, current: false, observedAt: Date.now() };
    else if (method === "mint-authority")
      result = {
        status: "UNKNOWN",
        reason: "NO_LEGACY_PROOF_IN_BROWSER_FIXTURE",
      };
    else throw Error("ISOLATED_METHOD_UNAVAILABLE");
    reply(response, 200, {
      contract: TEST_ADAPTER_CONTRACT,
      mode: "TEST_ONLY_NO_REAL_VALUE",
      isolated: true,
      result,
    });
  } catch {
    reply(response, 503, { code: "ISOLATED_FIXTURE_UNAVAILABLE" });
  }
});
server.listen(33328, "127.0.0.1", () =>
  console.log("ISOLATED_AGENT_BROWSER_FIXTURE_READY"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
