import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { verifyHoodiVaultFractions } from "../release/lib/hoodi-vault-fraction-receipts.mjs";
const { Interface, AbiCoder, id, keccak256, ZeroAddress, ZeroHash } =
  createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "ethers",
  );
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const Q = (n) => "0x" + BigInt(n).toString(16);
// Independent fixture ABI declarations transcribed from the contract source, not exported verifier helpers.
const abi = {
  factory: new Interface([
    "event VaultCreated(bytes32 indexed requestId,address indexed vault,address indexed collection,uint256 tokenId,string vaultName)",
    "function vaultForRequest(bytes32) view returns(address)",
    "function vaultByAsset(bytes32) view returns(address)",
  ]),
  vault: new Interface([
    "event NFTDeposited(address indexed collection,uint256 indexed tokenId,address indexed owner)",
    "event Fractionalized(address indexed token,address indexed recipient,uint256 supply)",
    "function collection() view returns(address)",
    "function tokenId() view returns(uint256)",
    "function tokenAdmin() view returns(address)",
    "function vaultName() view returns(string)",
    "function originalOwner() view returns(address)",
    "function deposited() view returns(bool)",
    "function fractionalToken() view returns(address)",
    "function fractionalSupply() view returns(uint256)",
    "function hasRole(bytes32,address) view returns(bool)",
  ]),
  nft: new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
    "function ownerOf(uint256) view returns(address)",
    "function supportsInterface(bytes4) view returns(bool)",
  ]),
  fraction: new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
    "function name() view returns(string)",
    "function symbol() view returns(string)",
    "function decimals() view returns(uint8)",
    "function totalSupply() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
    "function hasRole(bytes32,address) view returns(bool)",
  ]),
};
function fixture({ tokenId = "1" } = {}) {
  const code = "0x6001600055",
    codeHash = keccak256(code);
  const identity = (n) => ({ address: A(n), runtimeCodeHash: codeHash });
  const m = {
    schema: "artfi-hoodi-vault-fraction-receipts/v1",
    chainId: 560048,
    namespace: "TESTNET-AI-HOODI-FIXTURE",
    testAssetMarkers: ["TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"],
    contracts: {
      collection: identity(10),
      factory: identity(11),
      vault: identity(12),
      fraction: identity(13),
    },
    roles: {
      admin: identity(20),
      pauser: identity(21),
      fractionalizer: identity(22),
    },
    asset: { tokenId, originalOwner: A(30) },
    vault: { requestId: H(7), name: "TESTNET vault" },
    fraction: {
      name: "TESTNET fraction",
      symbol: "TST",
      supply: "1000000000000000000",
      recipient: A(30),
    },
    transactions: { create: H(1), deposit: H(2), fractionalize: H(3) },
  };
  const fixed = structuredClone(m),
    receipts = new Map(),
    transactions = new Map(),
    counters = new Map();
  const f = {
    m,
    receipts,
    transactions,
    calls: [],
    overrides: {},
    codeOverrides: {},
    notFinal: false,
    noncanonical: false,
    changeCanonical: false,
    changeReceipt: false,
    changeTransaction: false,
    unsupported: false,
  };
  function event(which, name, args, address) {
    return {
      address,
      ...abi[which].encodeEventLog(abi[which].getEvent(name), args),
    };
  }
  const records = [
    [
      1,
      333,
      [
        event(
          "factory",
          "VaultCreated",
          [m.vault.requestId, A(12), A(10), BigInt(tokenId), m.vault.name],
          A(11),
        ),
      ],
    ],
    [
      2,
      334,
      [
        event("nft", "Transfer", [A(30), A(12), BigInt(tokenId)], A(10)),
        event("vault", "NFTDeposited", [A(10), BigInt(tokenId), A(30)], A(12)),
      ],
    ],
    [
      3,
      335,
      [
        event(
          "fraction",
          "Transfer",
          [ZeroAddress, A(30), BigInt(m.fraction.supply)],
          A(13),
        ),
        event(
          "vault",
          "Fractionalized",
          [A(13), A(30), BigInt(m.fraction.supply)],
          A(12),
        ),
      ],
    ],
  ];
  for (const [id, number, events] of records) {
    const txid = H(id),
      blockHash = H(1000 + number),
      base = {
        transactionHash: txid,
        blockHash,
        blockNumber: Q(number),
        transactionIndex: "0x0",
      };
    receipts.set(txid, {
      ...base,
      status: "0x1",
      from: A(31),
      to: A(40),
      logs: events.map((e, i) => ({
        ...e,
        ...base,
        logIndex: Q(i),
        removed: false,
      })),
    });
    transactions.set(txid, {
      hash: txid,
      ...base,
      from: A(31),
      to: A(40),
      input: "0x1234",
      value: "0x0",
      nonce: Q(id),
    });
  }
  function block(number) {
    const tx = [...receipts.values()]
      .filter((r) => BigInt(r.blockNumber) === number)
      .map((r) => r.transactionHash);
    return {
      hash: H(1000n + number),
      number: Q(number),
      timestamp: Q(1800000000n + number),
      transactions: tx,
    };
  }
  const state = {
    "factory.vaultForRequest": A(12),
    "factory.vaultByAsset": A(12),
    "nft.ownerOf": A(12),
    "nft.supportsInterface": true,
    "vault.collection": A(10),
    "vault.tokenId": BigInt(tokenId),
    "vault.tokenAdmin": A(20),
    "vault.vaultName": fixed.vault.name,
    "vault.originalOwner": A(30),
    "vault.deposited": true,
    "vault.fractionalToken": A(13),
    "vault.fractionalSupply": BigInt(fixed.fraction.supply),
    "vault.hasRole": true,
    "fraction.name": fixed.fraction.name,
    "fraction.symbol": fixed.fraction.symbol,
    "fraction.decimals": 18n,
    "fraction.totalSupply": BigInt(fixed.fraction.supply),
    "fraction.balanceOf": BigInt(fixed.fraction.supply),
    "fraction.hasRole": true,
  };
  const byAddress = new Map([
    [A(10), "nft"],
    [A(11), "factory"],
    [A(12), "vault"],
    [A(13), "fraction"],
  ]);
  f.rpc = async (method, params) => {
    f.calls.push({ method, params: structuredClone(params) });
    const counterKey =
      method + ":" + (typeof params[0] === "string" ? params[0] : "");
    const n = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, n);
    if (method === "eth_chainId") return f.chain ?? Q(560048);
    if (method === "eth_getBlockByNumber") {
      const number =
        params[0] === "finalized"
          ? f.notFinal
            ? 334n
            : 350n
          : BigInt(params[0]);
      const b = block(number);
      if (
        params[0] !== "finalized" &&
        (f.noncanonical || (f.changeCanonical && n > 1))
      )
        b.hash = H(9999);
      return b;
    }
    if (method === "eth_getBlockByHash") {
      const b = [...receipts.values()].find((r) => r.blockHash === params[0]);
      return b ? block(BigInt(b.blockNumber)) : null;
    }
    if (method === "eth_getTransactionReceipt") {
      const r = structuredClone(receipts.get(params[0]) ?? null);
      if (r && f.changeReceipt && n > 1) r.logs[0].data += "00";
      return r;
    }
    if (method === "eth_getTransactionByHash") {
      const tx = structuredClone(transactions.get(params[0]) ?? null);
      if (tx && f.changeTransaction && n > 1) tx.input = "0xabcd";
      return tx;
    }
    if (method === "eth_getCode" || method === "eth_call") {
      assert.equal(typeof params[1], "object");
      assert.equal(params[1].requireCanonical, true);
      assert.match(params[1].blockHash, /^0x[0-9a-f]{64}$/);
      if (f.unsupported) throw Error("EIP-1898 unsupported synthetic fixture");
      if (method === "eth_getCode") return f.codeOverrides[params[0]] ?? code;
      const input = params[0],
        type = byAddress.get(input.to.toLowerCase());
      assert.ok(type);
      const parsed = abi[type].parseTransaction({ data: input.data });
      const key = type + "." + parsed.name;
      assert.ok(Object.hasOwn(state, key), key);
      if (key === "factory.vaultForRequest")
        assert.equal(parsed.args[0].toLowerCase(), fixed.vault.requestId);
      if (key === "factory.vaultByAsset")
        assert.equal(
          parsed.args[0].toLowerCase(),
          keccak256(
            AbiCoder.defaultAbiCoder().encode(
              ["address", "uint256"],
              [A(10), fixed.asset.tokenId],
            ),
          ),
        );
      if (key === "nft.ownerOf")
        assert.equal(parsed.args[0], BigInt(fixed.asset.tokenId));
      if (key === "nft.supportsInterface")
        assert.equal(parsed.args[0], "0x80ac58cd");
      if (key === "fraction.balanceOf")
        assert.equal(parsed.args[0].toLowerCase(), fixed.fraction.recipient);
      if (parsed.name === "hasRole") {
        const allowed =
          type === "vault"
            ? [
                [ZeroHash, A(20)],
                [id("PAUSER_ROLE"), A(21)],
                [id("FRACTIONALIZER_ROLE"), A(22)],
              ]
            : [[ZeroHash, A(20)]];
        assert.ok(
          allowed.some(
            ([role, who]) =>
              role === parsed.args[0].toLowerCase() &&
              who === parsed.args[1].toLowerCase(),
          ),
          "Role call must bind its exact kind and principal",
        );
      }
      const value = Object.hasOwn(f.overrides, key)
        ? f.overrides[key]
        : state[key];
      return abi[type].encodeFunctionResult(parsed.name, [value]);
    }
    throw Error("Unexpected RPC method in synthetic fixture");
  };
  f.bundle = () => {
    const first = receipts.get(H(1)),
      combined = [...receipts.values()].flatMap((r) => r.logs);
    first.logs = combined.map((l, i) => ({
      ...l,
      transactionHash: H(1),
      blockHash: first.blockHash,
      blockNumber: first.blockNumber,
      transactionIndex: "0x0",
      logIndex: Q(i),
    }));
    receipts.delete(H(2));
    receipts.delete(H(3));
    m.transactions.deposit = H(1);
    m.transactions.fractionalize = H(1);
  };
  return f;
}
test("missing inputs produce NOT_RUN without an RPC or invented identity", async () => {
  let called = false;
  const r = await verifyHoodiVaultFractions(undefined, () => {
    called = true;
  });
  assert.equal(r.status, "NOT_RUN");
  assert.ok(r.missingInputs.length);
  assert.equal(called, false);
});
test("missing original RPC remains NOT_RUN", async () => {
  const f = fixture();
  assert.equal((await verifyHoodiVaultFractions(f.m)).status, "NOT_RUN");
});
test("verifies the separate completed event/state chain with explicit acceptance limits", async () => {
  const f = fixture(),
    r = await verifyHoodiVaultFractions(f.m, f.rpc);
  assert.equal(r.status, "VERIFIED_RECEIPTS_ONLY");
  assert.equal(r.scope, "vault-fraction-receipts-only");
  for (const k of [
    "transactionSent",
    "transactionAuthorityVerified",
    "sourceAuthenticityVerified",
    "registryHoldershipVerified",
    "safeGovernanceVerified",
    "assetGenerationVerified",
    "metadataContentVerified",
    "UIAcceptance",
    "wholeProductAccepted",
  ])
    assert.equal(r[k], false);
  assert.ok(
    f.calls.every(
      (c) => !/send|sign|personal|wallet|debug|trace/i.test(c.method),
    ),
  );
});
test("ordered same-transaction stages do not invent separate transaction hashes", async () => {
  const f = fixture();
  f.bundle();
  assert.equal(
    (await verifyHoodiVaultFractions(f.m, f.rpc)).status,
    "VERIFIED_RECEIPTS_ONLY",
  );
});
test("keeps full-width token identity", async () => {
  const id = ((1n << 256n) - 1n).toString(),
    f = fixture({ tokenId: id });
  assert.equal((await verifyHoodiVaultFractions(f.m, f.rpc)).tokenId, id);
});
test("later recipient transfers do not erase the initial mint event", async () => {
  const f = fixture();
  f.overrides["fraction.balanceOf"] = 0n;
  const r = await verifyHoodiVaultFractions(f.m, f.rpc);
  assert.equal(r.recipientBalanceAtStateBlock, "0");
});
test("rejects a different chain", async () => {
  const f = fixture();
  f.chain = Q(11155111);
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /CHAIN_MISMATCH/);
});
test("rejects nonfinal and noncanonical observations", async () => {
  const f = fixture();
  f.notFinal = true;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /NOT_FINALIZED/);
  f.notFinal = false;
  f.noncanonical = true;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /NONCANONICAL/);
});
test("rejects a failed receipt rather than claiming the stage completed", async () => {
  const f = fixture();
  f.receipts.get(H(2)).status = "0x0";
  await assert.rejects(
    verifyHoodiVaultFractions(f.m, f.rpc),
    /RECEIPT_UNSUCCESSFUL/,
  );
});
test("rejects changed receipt or transaction readbacks", async () => {
  const f = fixture();
  f.changeReceipt = true;
  await assert.rejects(
    verifyHoodiVaultFractions(f.m, f.rpc),
    /RECEIPT_CHANGED/,
  );
  const g = fixture();
  g.changeTransaction = true;
  await assert.rejects(
    verifyHoodiVaultFractions(g.m, g.rpc),
    /TRANSACTION_CHANGED/,
  );
});
test("rejects canonical-block disagreement after the state reads", async () => {
  const f = fixture();
  f.changeCanonical = true;
  await assert.rejects(
    verifyHoodiVaultFractions(f.m, f.rpc),
    /CANONICAL_BLOCK_CHANGED/,
  );
});
test("rejects removed, rebound or duplicate-index logs", async () => {
  const f = fixture();
  f.receipts.get(H(2)).logs[0].removed = true;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /LOG_BINDING/);
  const g = fixture();
  g.receipts.get(H(2)).logs[0].blockHash = H(99);
  await assert.rejects(verifyHoodiVaultFractions(g.m, g.rpc), /LOG_BINDING/);
  const h = fixture();
  h.receipts.get(H(2)).logs[1].logIndex = "0x0";
  await assert.rejects(verifyHoodiVaultFractions(h.m, h.rpc), /LOG_BINDING/);
});
test("rejects an absent factory provenance event", async () => {
  const f = fixture();
  f.receipts.get(H(1)).logs = [];
  await assert.rejects(
    verifyHoodiVaultFractions(f.m, f.rpc),
    /CREATE_EVENT_COUNT/,
  );
});
test("rejects reversed token transfer and deposit notification order", async () => {
  const f = fixture();
  const logs = f.receipts.get(H(2)).logs;
  logs.reverse();
  logs.forEach((l, i) => {
    l.logIndex = Q(i);
  });
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /EVENT_ORDER/);
});
test("rejects mismatched runtime or missing role contract code", async () => {
  const f = fixture();
  f.codeOverrides[A(12)] = "0x6000";
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /RUNTIME_CODE/);
  const g = fixture();
  g.codeOverrides[A(20)] = "0x";
  await assert.rejects(verifyHoodiVaultFractions(g.m, g.rpc), /RUNTIME_CODE/);
});
test("rejects unsupported block-hash reads without falling back to latest", async () => {
  const f = fixture();
  f.unsupported = true;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /unsupported/);
  assert.ok(
    f.calls
      .filter((c) => c.method === "eth_getCode")
      .every((c) => typeof c.params[1] === "object"),
  );
});
test("does not treat an ERC1155 collection as ERC721 custody", async () => {
  const f = fixture();
  f.overrides["nft.supportsInterface"] = false;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /NOT_ERC721/);
});
test("rejects lost custody or a different factory binding", async () => {
  const f = fixture();
  f.overrides["nft.ownerOf"] = A(30);
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /CUSTODY/);
  const g = fixture();
  g.overrides["factory.vaultForRequest"] = A(99);
  await assert.rejects(
    verifyHoodiVaultFractions(g.m, g.rpc),
    /FACTORY_MAPPING/,
  );
});
test("rejects changed Vault identity, deposit state or fractional supply", async () => {
  for (const [key, value] of [
    ["vault.tokenAdmin", A(99)],
    ["vault.deposited", false],
    ["vault.fractionalSupply", 1n],
  ]) {
    const f = fixture();
    f.overrides[key] = value;
    await assert.rejects(
      verifyHoodiVaultFractions(f.m, f.rpc),
      /VAULT_(?:IDENTITY|STATE)_MISMATCH/,
    );
  }
});
test("rejects role and fractional token state mismatch", async () => {
  const f = fixture();
  f.overrides["vault.hasRole"] = false;
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /ROLE_MISMATCH/);
  const g = fixture();
  g.overrides["fraction.totalSupply"] = 2n;
  await assert.rejects(verifyHoodiVaultFractions(g.m, g.rpc), /FRACTION_STATE/);
});
test("refuses accessors without invoking them", async () => {
  let touched = false;
  const value = {
    get schema() {
      touched = true;
      return "wrong";
    },
  };
  await assert.rejects(
    verifyHoodiVaultFractions(value, () => {}),
    /JSON_ACCESSOR/,
  );
  assert.equal(touched, false);
});
test("captures the expected manifest before asynchronous RPC callbacks", async () => {
  const f = fixture(),
    pending = verifyHoodiVaultFractions(f.m, f.rpc);
  f.m.contracts.vault.address = A(99);
  assert.equal((await pending).status, "VERIFIED_RECEIPTS_ONLY");
});
test("refuses invalid, numeric or overflow token IDs and zero transactions", async () => {
  for (const id of ["01", 1, (1n << 256n).toString()]) {
    const f = fixture();
    f.m.asset.tokenId = id;
    await assert.rejects(
      verifyHoodiVaultFractions(f.m, f.rpc),
      /DECIMAL_UINT256/,
    );
  }
  const g = fixture();
  g.m.transactions.create = "0x" + "0".repeat(64);
  await assert.rejects(verifyHoodiVaultFractions(g.m, g.rpc), /HASH/);
});
test("refuses mismatched hashes for the same shared role address", async () => {
  const f = fixture();
  f.m.roles.pauser.address = f.m.roles.admin.address;
  f.m.roles.pauser.runtimeCodeHash = H(999);
  await assert.rejects(verifyHoodiVaultFractions(f.m, f.rpc), /RUNTIME_CODE/);
});
