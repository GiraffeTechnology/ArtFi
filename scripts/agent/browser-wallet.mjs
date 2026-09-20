import { INTENT_FIELDS } from "./bounded-intent.mjs";

const CHAIN_ID = "560048";
const CHAIN_HEX = "0x88bb0";
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const address = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  !/^0x0{40}$/i.test(value);
const signature = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
const uint = (value) =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  BigInt(value) < 2n ** 256n;
const bytes32 = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/.test(value) &&
  !/^0x0{64}$/.test(value);
const hash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const fail = (code) => {
  throw Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();

function clone(value, code) {
  try {
    return structuredClone(value);
  } catch {
    fail(code);
  }
}

function providerFailure(error) {
  if (String(error?.code) === "4001") fail("WALLET_REQUEST_REJECTED");
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")) throw error;
  fail("WALLET_DEPENDENCY_UNAVAILABLE");
}

export function createAgentBrowserWallet({ provider, sendRevocation }) {
  if (
    typeof provider?.request !== "function" ||
    typeof sendRevocation !== "function"
  )
    fail("WALLET_ADAPTER_CONFIGURATION_INVALID");

  async function request(method, params = []) {
    try {
      return await provider.request({ method, params });
    } catch (error) {
      providerFailure(error);
    }
  }

  async function identity(expectedWallet) {
    if (expectedWallet !== undefined && !address(expectedWallet))
      fail("WALLET_ACCOUNT_REFUSED");
    const chain = await request("eth_chainId");
    if (typeof chain !== "string" || chain.toLowerCase() !== CHAIN_HEX)
      fail("WALLET_CHAIN_REFUSED");
    const accounts = await request("eth_accounts");
    const active = accounts?.[0];
    if (!Array.isArray(accounts) || !address(active))
      fail("WALLET_ACCOUNT_REFUSED");
    if (expectedWallet !== undefined && !same(active, expectedWallet))
      fail("WALLET_ACCOUNT_REFUSED");
    return active.toLowerCase();
  }

  return Object.freeze({
    async signIntent(draft) {
      const value = clone(draft, "WALLET_DRAFT_INVALID");
      const intent = value?.intent;
      const domain = value?.domain;
      if (
        value?.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
        !id(value.operationId) ||
        value.operationId !== intent?.intentId ||
        !domain ||
        domain.name !== "ArtFi Bounded Intent" ||
        domain.version !== "1" ||
        String(domain.chainId) !== CHAIN_ID ||
        !address(domain.verifyingContract) ||
        !intent ||
        Object.keys(intent).length !== INTENT_FIELDS.length ||
        INTENT_FIELDS.some(({ name, type }) => {
          if (!Object.hasOwn(intent, name)) return true;
          if (type === "uint256") return !uint(intent[name]);
          if (type === "bytes32") return !bytes32(intent[name]);
          if (type === "address") return !address(intent[name]);
          return true;
        }) ||
        !same(intent.wallet, intent.principal)
      )
        fail("WALLET_DRAFT_INVALID");
      const wallet = await identity(intent.wallet);
      const typedData = {
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: CHAIN_ID,
          verifyingContract: domain.verifyingContract,
        },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          BoundedIntent: INTENT_FIELDS.map(({ name, type }) => ({
            name,
            type,
          })),
        },
        primaryType: "BoundedIntent",
        message: intent,
      };
      const result = await request("eth_signTypedData_v4", [
        wallet,
        JSON.stringify(typedData),
      ]);
      if (!signature(result)) fail("WALLET_SIGNATURE_INVALID");
      if ((await identity()) !== wallet) fail("WALLET_ACCOUNT_CHANGED");
      return result;
    },

    async revokeNonce(input) {
      const value = clone(input, "REVOCATION_REQUEST_INVALID");
      if (
        !value ||
        Object.keys(value).length !== 5 ||
        !id(value.id) ||
        !address(value.wallet) ||
        typeof value.nonce !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(value.nonce) ||
        !address(value.executor) ||
        String(value.chainId) !== CHAIN_ID
      )
        fail("REVOCATION_REQUEST_INVALID");
      const wallet = await identity(value.wallet);
      let result;
      try {
        result = clone(
          await sendRevocation(clone(value, "REVOCATION_REQUEST_INVALID")),
          "REVOCATION_RESULT_INVALID",
        );
      } catch (error) {
        providerFailure(error);
      }
      if (!hash(result?.transactionHash)) fail("REVOCATION_RESULT_INVALID");
      if ((await identity()) !== wallet) fail("WALLET_ACCOUNT_CHANGED");
      return { transactionHash: result.transactionHash.toLowerCase() };
    },
  });
}
