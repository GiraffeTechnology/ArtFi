import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_FIELDS } from "./bounded-intent.mjs";
import { createAgentBrowserWallet } from "./browser-wallet.mjs";

const wallet = "0x" + "ab".repeat(20);
const executor = "0x" + "cd".repeat(20);
const bytes32 = "0x" + "12".repeat(32);
const sig = "0x" + "34".repeat(65);
const txHash = "0x" + "AB".repeat(32);
const intent = Object.fromEntries(
  INTENT_FIELDS.map(({ name, type }) => [
    name,
    type === "address" ? wallet : type === "bytes32" ? bytes32 : "1",
  ]),
);
intent.intentId = bytes32;
intent.principal = wallet;
intent.wallet = wallet;
const draft = {
  mode: "TEST_ONLY_NO_REAL_VALUE",
  operationId: bytes32,
  domain: {
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: "560048",
    verifyingContract: executor,
  },
  intent,
};

function fixture({
  chainId = "0x88bb0",
  rejectSign = false,
  accounts = [[wallet], [wallet]],
} = {}) {
  const calls = [];
  let accountRead = 0;
  const provider = {
    async request(call) {
      calls.push(structuredClone(call));
      if (call.method === "eth_chainId") return chainId;
      if (call.method === "eth_accounts")
        return accounts[Math.min(accountRead++, accounts.length - 1)];
      if (call.method === "eth_signTypedData_v4") {
        if (rejectSign)
          throw Object.assign(Error("do not expose"), { code: 4001 });
        return sig;
      }
      throw Error("UNEXPECTED_PROVIDER_METHOD");
    },
  };
  return { calls, provider };
}

test("wallet signs the exact bounded intent without requesting accounts or sending a transaction", async () => {
  const f = fixture();
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => {
      throw Error("UNUSED_REVOCATION");
    },
  });
  assert.equal(await adapter.signIntent(draft), sig);
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    [
      "eth_chainId",
      "eth_accounts",
      "eth_signTypedData_v4",
      "eth_chainId",
      "eth_accounts",
    ],
  );
  const [from, encoded] = f.calls[2].params;
  assert.equal(from, wallet);
  const typed = JSON.parse(encoded);
  assert.equal(typed.primaryType, "BoundedIntent");
  assert.equal(typed.domain.chainId, "560048");
  assert.deepEqual(typed.types.BoundedIntent, INTENT_FIELDS);
  assert.deepEqual(typed.message, intent);
});

test("wallet refuses wrong chain before signature", async () => {
  const f = fixture({ chainId: "0x1" });
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => ({ transactionHash: txHash }),
  });
  await assert.rejects(adapter.signIntent(draft), /WALLET_CHAIN_REFUSED/);
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    ["eth_chainId"],
  );
});

test("wallet maps user rejection without exposing provider text", async () => {
  const f = fixture({ rejectSign: true });
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => ({ transactionHash: txHash }),
  });
  await assert.rejects(adapter.signIntent(draft), (error) => {
    assert.equal(error.message, "WALLET_REQUEST_REJECTED");
    assert.doesNotMatch(error.message, /expose/);
    return true;
  });
});

test("wallet refuses an account change after signature", async () => {
  const other = "0x" + "ef".repeat(20);
  const f = fixture({ accounts: [[wallet], [other]] });
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => ({ transactionHash: txHash }),
  });
  await assert.rejects(adapter.signIntent(draft), /WALLET_ACCOUNT_CHANGED/);
});

test("wallet delegates one exact revocation and rechecks identity", async () => {
  const f = fixture();
  let supplied;
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async (value) => {
      supplied = value;
      return { transactionHash: txHash };
    },
  });
  const input = {
    id: bytes32,
    wallet,
    nonce: "1",
    executor,
    chainId: "560048",
  };
  assert.deepEqual(await adapter.revokeNonce(input), {
    transactionHash: txHash.toLowerCase(),
  });
  assert.deepEqual(supplied, input);
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    ["eth_chainId", "eth_accounts", "eth_chainId", "eth_accounts"],
  );
});

test("wallet rejects draft binding drift before provider access", async () => {
  const f = fixture();
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => ({ transactionHash: txHash }),
  });
  await assert.rejects(
    adapter.signIntent({
      ...draft,
      domain: { ...draft.domain, chainId: "1" },
    }),
    /WALLET_DRAFT_INVALID/,
  );
  assert.equal(f.calls.length, 0);
});

test("wallet rejects oversized revocation nonce before provider access", async () => {
  const f = fixture();
  let calls = 0;
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => {
      calls += 1;
      return { transactionHash: txHash };
    },
  });
  await assert.rejects(
    adapter.revokeNonce({
      id: bytes32,
      wallet,
      nonce: (2n ** 256n).toString(),
      executor,
      chainId: "560048",
    }),
    /REVOCATION_REQUEST_INVALID/,
  );
  assert.equal(calls, 0);
  assert.equal(f.calls.length, 0);
});

test("wallet rejects a zero revocation transaction hash", async () => {
  const f = fixture();
  const adapter = createAgentBrowserWallet({
    provider: f.provider,
    sendRevocation: async () => ({ transactionHash: "0x" + "00".repeat(32) }),
  });
  await assert.rejects(
    adapter.revokeNonce({
      id: bytes32,
      wallet,
      nonce: "1",
      executor,
      chainId: "560048",
    }),
    /REVOCATION_RESULT_INVALID/,
  );
});
