import { createRequire } from "node:module";
const { Interface, AbiCoder, keccak256, toUtf8Bytes, ZeroAddress, ZeroHash } =
  createRequire(new URL("../../../apps/web/package.json", import.meta.url))(
    "ethers",
  );

const factoryABI = new Interface([
  "event VaultCreated(bytes32 indexed requestId,address indexed vault,address indexed collection,uint256 tokenId,string vaultName)",
  "function vaultForRequest(bytes32) view returns(address)",
  "function vaultByAsset(bytes32) view returns(address)",
]);
const vaultABI = new Interface([
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
]);
const nftABI = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "function ownerOf(uint256) view returns(address)",
  "function supportsInterface(bytes4) view returns(bool)",
]);
const fractionABI = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function name() view returns(string)",
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
]);
const MARKERS = ["TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"];
const FROZEN = "0xec7d57e6f91fe1d1ee1ec0cb1df8e869088de104";
const coder = AbiCoder.defaultAbiCoder();
const check = (value, code) => {
  if (!value) throw Error(code);
};
function keys(value, wanted, code) {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") === [...wanted].sort().join("\0"),
    code,
  );
}
function snapshot(value) {
  let budget = 50000;
  const copy = (v, depth) => {
    check(--budget >= 0 && depth <= 16, "JSON_LIMIT");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      check(v.length <= 131072, "JSON_LIMIT");
      return v;
    }
    if (typeof v === "number") {
      check(Number.isSafeInteger(v), "JSON_NUMBER");
      return v;
    }
    check(v && typeof v === "object", "JSON_TYPE");
    const ds = Object.getOwnPropertyDescriptors(v),
      own = Reflect.ownKeys(ds);
    if (Array.isArray(v)) {
      check(
        Object.getPrototypeOf(v) === Array.prototype &&
          own.length === v.length + 1,
        "JSON_ARRAY",
      );
      return Array.from({ length: v.length }, (_, i) => {
        const d = ds[String(i)];
        check(d && Object.hasOwn(d, "value"), "JSON_ACCESSOR");
        return copy(d.value, depth + 1);
      });
    }
    check(Object.getPrototypeOf(v) === Object.prototype, "JSON_OBJECT");
    return Object.fromEntries(
      own.map((k) => {
        const d = ds[k];
        check(
          typeof k === "string" && d.enumerable && Object.hasOwn(d, "value"),
          "JSON_ACCESSOR",
        );
        return [k, copy(d.value, depth + 1)];
      }),
    );
  };
  return copy(value, 0);
}
function address(value) {
  check(
    typeof value === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value) &&
      value.toLowerCase() !== ZeroAddress,
    "ADDRESS",
  );
  return value.toLowerCase();
}
function hash(value, nonzero = true) {
  check(
    typeof value === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(value) &&
      (!nonzero || value.toLowerCase() !== ZeroHash),
    "HASH",
  );
  return value.toLowerCase();
}
function bytes(value) {
  check(
    typeof value === "string" &&
      /^0x(?:[0-9a-fA-F]{2})*$/.test(value) &&
      value.length <= 131074,
    "BYTES",
  );
  return value.toLowerCase();
}
function quantity(value) {
  check(
    typeof value === "string" &&
      /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) &&
      value.length <= 66,
    "RPC_QUANTITY",
  );
  return BigInt(value);
}
function decimal(value) {
  check(
    typeof value === "string" &&
      /^(?:0|[1-9][0-9]{0,77})$/.test(value) &&
      BigInt(value) < 1n << 256n,
    "DECIMAL_UINT256",
  );
  return BigInt(value);
}
function text(value, max) {
  check(
    typeof value === "string" &&
      Buffer.byteLength(value) >= 2 &&
      Buffer.byteLength(value) <= max,
    "TEXT",
  );
  return value;
}
const hex = (n) => "0x" + n.toString(16);
function expectations(input) {
  const m = snapshot(input);
  keys(
    m,
    [
      "schema",
      "chainId",
      "namespace",
      "testAssetMarkers",
      "contracts",
      "roles",
      "asset",
      "vault",
      "fraction",
      "transactions",
    ],
    "MANIFEST_FIELDS",
  );
  check(
    m.schema === "artfi-hoodi-vault-fraction-receipts/v1" &&
      m.chainId === 560048 &&
      typeof m.namespace === "string" &&
      /^TESTNET-AI-HOODI-[A-Z0-9-]{1,64}$/.test(m.namespace) &&
      Array.isArray(m.testAssetMarkers) &&
      m.testAssetMarkers.length === 3 &&
      MARKERS.every((x) => m.testAssetMarkers.includes(x)),
    "ISOLATION",
  );
  keys(
    m.contracts,
    ["collection", "factory", "vault", "fraction"],
    "CONTRACT_FIELDS",
  );
  for (const c of Object.values(m.contracts)) {
    keys(c, ["address", "runtimeCodeHash"], "CONTRACT_IDENTITY");
    c.address = address(c.address);
    c.runtimeCodeHash = hash(c.runtimeCodeHash);
  }
  check(
    new Set(Object.values(m.contracts).map((c) => c.address)).size === 4 &&
      m.contracts.collection.address !== FROZEN,
    "CONTRACT_COLLISION",
  );
  keys(m.roles, ["admin", "pauser", "fractionalizer"], "ROLE_FIELDS");
  for (const c of Object.values(m.roles)) {
    keys(c, ["address", "runtimeCodeHash"], "ROLE_IDENTITY");
    c.address = address(c.address);
    c.runtimeCodeHash = hash(c.runtimeCodeHash);
    check(
      !Object.values(m.contracts).some((p) => p.address === c.address),
      "ROLE_COLLISION",
    );
  }
  keys(m.asset, ["tokenId", "originalOwner"], "ASSET_FIELDS");
  decimal(m.asset.tokenId);
  m.asset.originalOwner = address(m.asset.originalOwner);
  keys(m.vault, ["requestId", "name"], "VAULT_FIELDS");
  m.vault.requestId = hash(m.vault.requestId);
  text(m.vault.name, 80);
  keys(
    m.fraction,
    ["name", "symbol", "supply", "recipient"],
    "FRACTION_FIELDS",
  );
  text(m.fraction.name, 80);
  text(m.fraction.symbol, 12);
  const supply = decimal(m.fraction.supply);
  check(supply >= 10n ** 18n && supply <= 10n ** 30n, "FRACTION_SUPPLY");
  m.fraction.recipient = address(m.fraction.recipient);
  keys(
    m.transactions,
    ["create", "deposit", "fractionalize"],
    "TRANSACTION_FIELDS",
  );
  for (const name of Object.keys(m.transactions))
    m.transactions[name] = hash(m.transactions[name]);
  return m;
}
const limits = {
  transactionAuthorityVerified: false,
  sourceAuthenticityVerified: false,
  registryHoldershipVerified: false,
  safeGovernanceVerified: false,
  assetGenerationVerified: false,
  metadataContentVerified: false,
  UIAcceptance: false,
  wholeProductAccepted: false,
};
const notRun = (missing) => ({
  status: "NOT_RUN",
  scope: "vault-fraction-receipts-only",
  missingInputs: missing,
  transactionSent: false,
  ...limits,
});
function boundReceipt(raw, txid) {
  check(
    raw && raw.status === "0x1" && hash(raw.transactionHash) === txid,
    "RECEIPT_UNSUCCESSFUL_OR_MISSING",
  );
  const blockHash = hash(raw.blockHash),
    blockNumber = quantity(raw.blockNumber),
    transactionIndex = quantity(raw.transactionIndex);
  check(Array.isArray(raw.logs) && raw.logs.length <= 256, "RECEIPT_LOG_LIMIT");
  let prior = -1n;
  const logs = raw.logs.map((l) => {
    const index = quantity(l.logIndex);
    check(
      index > prior &&
        l.removed === false &&
        hash(l.transactionHash) === txid &&
        hash(l.blockHash) === blockHash &&
        quantity(l.blockNumber) === blockNumber &&
        quantity(l.transactionIndex) === transactionIndex &&
        Array.isArray(l.topics) &&
        l.topics.length >= 1 &&
        l.topics.length <= 4,
      "LOG_BINDING",
    );
    prior = index;
    return {
      address: address(l.address),
      topics: l.topics.map((t) => hash(t, false)),
      data: bytes(l.data),
      index: index.toString(),
    };
  });
  return {
    transactionHash: txid,
    blockHash,
    blockNumber: blockNumber.toString(),
    transactionIndex: transactionIndex.toString(),
    from: address(raw.from),
    to: address(raw.to),
    logs,
  };
}
function boundTransaction(raw, receipt) {
  check(
    raw &&
      hash(raw.hash) === receipt.transactionHash &&
      hash(raw.blockHash) === receipt.blockHash &&
      quantity(raw.blockNumber).toString() === receipt.blockNumber &&
      quantity(raw.transactionIndex).toString() === receipt.transactionIndex &&
      address(raw.from) === receipt.from &&
      address(raw.to) === receipt.to &&
      quantity(raw.value) === 0n,
    "TRANSACTION_BINDING",
  );
  return {
    hash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    input: bytes(raw.input),
    value: "0",
    nonce: quantity(raw.nonce).toString(),
  };
}
function block(raw) {
  check(raw && raw.hash, "BLOCK_MISSING");
  return {
    hash: hash(raw.hash),
    number: quantity(raw.number),
    timestamp: quantity(raw.timestamp),
  };
}
function events(receipt, emitter, iface, name) {
  const topic = iface.getEvent(name).topicHash.toLowerCase();
  return receipt.logs
    .filter((l) => l.address === emitter && l.topics[0] === topic)
    .map((l) => ({
      args: iface.parseLog(l).args,
      position: [
        BigInt(receipt.blockNumber),
        BigInt(receipt.transactionIndex),
        BigInt(l.index),
      ],
    }));
}
function single(values, code) {
  check(values.length === 1, code);
  return values[0];
}
function before(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Observe completed ERC-721 custody/fraction events and state. Never grants or replays authority. */
export async function verifyHoodiVaultFractions(input, rpc) {
  if (input === undefined || input === null)
    return notRun([
      "independently selected expected identities and completed transaction hashes",
      "original approved read-only RPC",
    ]);
  const m = expectations(input);
  if (typeof rpc !== "function")
    return notRun(["original approved read-only RPC"]);
  async function call(method, params) {
    let timer;
    try {
      return snapshot(
        await Promise.race([
          Promise.resolve().then(() => rpc(method, params)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("RPC_TIMEOUT")), 15000);
          }),
        ]),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  check(quantity(await call("eth_chainId", [])) === 560048n, "CHAIN_MISMATCH");
  const finalized = block(
    await call("eth_getBlockByNumber", ["finalized", false]),
  );
  const receipts = new Map(),
    transactions = new Map(),
    checkedBlocks = new Map(),
    checkedCode = new Set();
  for (const txid of new Set(Object.values(m.transactions))) {
    const r = boundReceipt(
      await call("eth_getTransactionReceipt", [txid]),
      txid,
    );
    check(BigInt(r.blockNumber) <= finalized.number, "NOT_FINALIZED");
    const observed = await call("eth_getBlockByHash", [r.blockHash, false]),
      b = block(observed);
    check(
      b.hash === r.blockHash &&
        b.number.toString() === r.blockNumber &&
        Array.isArray(observed.transactions) &&
        observed.transactions.length <= 4096 &&
        observed.transactions[
          Number(BigInt(r.transactionIndex))
        ]?.toLowerCase() === txid,
      "BLOCK_TRANSACTION_BINDING",
    );
    const canonical = block(
      await call("eth_getBlockByNumber", [hex(b.number), false]),
    );
    check(canonical.hash === b.hash, "NONCANONICAL_BLOCK");
    checkedBlocks.set(b.number.toString(), b);
    receipts.set(txid, r);
    transactions.set(
      txid,
      boundTransaction(await call("eth_getTransactionByHash", [txid]), r),
    );
  }
  const create = receipts.get(m.transactions.create),
    deposit = receipts.get(m.transactions.deposit),
    fraction = receipts.get(m.transactions.fractionalize);
  async function code(identity, receipt) {
    const key =
      identity.address +
      ":" +
      identity.runtimeCodeHash +
      ":" +
      receipt.blockHash;
    if (checkedCode.has(key)) return;
    const data = bytes(
      await call("eth_getCode", [
        identity.address,
        { blockHash: receipt.blockHash, requireCanonical: true },
      ]),
    );
    check(
      data !== "0x" && keccak256(data) === identity.runtimeCodeHash,
      "RUNTIME_CODE_MISMATCH",
    );
    checkedCode.add(key);
  }
  for (const [r, names] of [
    [create, ["collection", "factory", "vault"]],
    [deposit, ["collection", "vault"]],
    [fraction, ["collection", "factory", "vault", "fraction"]],
  ])
    for (const name of names) await code(m.contracts[name], r);
  for (const identity of Object.values(m.roles)) await code(identity, fraction);
  const c = single(
    events(create, m.contracts.factory.address, factoryABI, "VaultCreated"),
    "CREATE_EVENT_COUNT",
  );
  check(
    c.args[0].toLowerCase() === m.vault.requestId &&
      address(c.args[1]) === m.contracts.vault.address &&
      address(c.args[2]) === m.contracts.collection.address &&
      c.args[3] === decimal(m.asset.tokenId) &&
      c.args[4] === m.vault.name,
    "CREATE_EVENT_MISMATCH",
  );
  const transfer = single(
    events(deposit, m.contracts.collection.address, nftABI, "Transfer").filter(
      (e) => e.args[2] === decimal(m.asset.tokenId),
    ),
    "NFT_TRANSFER_COUNT",
  );
  check(
    address(transfer.args[0]) === m.asset.originalOwner &&
      address(transfer.args[1]) === m.contracts.vault.address,
    "NFT_TRANSFER_MISMATCH",
  );
  const d = single(
    events(deposit, m.contracts.vault.address, vaultABI, "NFTDeposited"),
    "DEPOSIT_EVENT_COUNT",
  );
  check(
    address(d.args[0]) === m.contracts.collection.address &&
      d.args[1] === decimal(m.asset.tokenId) &&
      address(d.args[2]) === m.asset.originalOwner,
    "DEPOSIT_EVENT_MISMATCH",
  );
  const mint = single(
    events(fraction, m.contracts.fraction.address, fractionABI, "Transfer"),
    "FRACTION_MINT_COUNT",
  );
  check(
    mint.args[0].toLowerCase() === ZeroAddress &&
      address(mint.args[1]) === m.fraction.recipient &&
      mint.args[2] === decimal(m.fraction.supply),
    "FRACTION_MINT_MISMATCH",
  );
  const f = single(
    events(fraction, m.contracts.vault.address, vaultABI, "Fractionalized"),
    "FRACTION_EVENT_COUNT",
  );
  check(
    address(f.args[0]) === m.contracts.fraction.address &&
      address(f.args[1]) === m.fraction.recipient &&
      f.args[2] === decimal(m.fraction.supply),
    "FRACTION_EVENT_MISMATCH",
  );
  check(
    before(c.position, transfer.position) &&
      before(transfer.position, d.position) &&
      before(d.position, mint.position) &&
      before(mint.position, f.position),
    "EVENT_ORDER",
  );
  async function read(iface, target, name, args = []) {
    const encoded = iface.encodeFunctionData(name, args);
    const data = bytes(
      await call("eth_call", [
        { to: target, data: encoded },
        { blockHash: fraction.blockHash, requireCanonical: true },
      ]),
    );
    return iface.decodeFunctionResult(name, data)[0];
  }
  const nft = m.contracts.collection.address,
    vault = m.contracts.vault.address,
    token = m.contracts.fraction.address,
    factory = m.contracts.factory.address;
  check(
    (await read(nftABI, nft, "supportsInterface", ["0x80ac58cd"])) === true,
    "UNDERLYING_NOT_ERC721",
  );
  check(
    address(await read(nftABI, nft, "ownerOf", [m.asset.tokenId])) === vault,
    "CUSTODY_MISMATCH",
  );
  check(
    address(
      await read(factoryABI, factory, "vaultForRequest", [m.vault.requestId]),
    ) === vault &&
      address(
        await read(factoryABI, factory, "vaultByAsset", [
          keccak256(
            coder.encode(["address", "uint256"], [nft, m.asset.tokenId]),
          ),
        ]),
      ) === vault,
    "FACTORY_MAPPING_MISMATCH",
  );
  for (const [name, expected] of [
    ["collection", nft],
    ["tokenAdmin", m.roles.admin.address],
    ["originalOwner", m.asset.originalOwner],
    ["fractionalToken", token],
  ])
    check(
      address(await read(vaultABI, vault, name)) === expected,
      "VAULT_IDENTITY_MISMATCH",
    );
  check(
    (await read(vaultABI, vault, "tokenId")) === decimal(m.asset.tokenId) &&
      (await read(vaultABI, vault, "vaultName")) === m.vault.name &&
      (await read(vaultABI, vault, "deposited")) === true &&
      (await read(vaultABI, vault, "fractionalSupply")) ===
        decimal(m.fraction.supply),
    "VAULT_STATE_MISMATCH",
  );
  for (const [role, identity] of [
    [ZeroHash, m.roles.admin],
    [keccak256(toUtf8Bytes("PAUSER_ROLE")), m.roles.pauser],
    [keccak256(toUtf8Bytes("FRACTIONALIZER_ROLE")), m.roles.fractionalizer],
  ])
    check(
      (await read(vaultABI, vault, "hasRole", [role, identity.address])) ===
        true,
      "VAULT_ROLE_MISMATCH",
    );
  check(
    (await read(fractionABI, token, "name")) === m.fraction.name &&
      (await read(fractionABI, token, "symbol")) === m.fraction.symbol &&
      (await read(fractionABI, token, "decimals")) === 18n &&
      (await read(fractionABI, token, "totalSupply")) ===
        decimal(m.fraction.supply) &&
      (await read(fractionABI, token, "hasRole", [
        ZeroHash,
        m.roles.admin.address,
      ])) === true,
    "FRACTION_STATE_MISMATCH",
  );
  const recipientBalance = await read(fractionABI, token, "balanceOf", [
    m.fraction.recipient,
  ]);
  check(
    recipientBalance <= decimal(m.fraction.supply),
    "FRACTION_BALANCE_RANGE",
  );
  // The initial mint event proves delivery. A later transfer in the same block is not a failed mint.
  for (const [txid, receipt] of receipts) {
    check(
      JSON.stringify(
        boundReceipt(await call("eth_getTransactionReceipt", [txid]), txid),
      ) === JSON.stringify(receipt),
      "RECEIPT_CHANGED",
    );
    check(
      JSON.stringify(
        boundTransaction(
          await call("eth_getTransactionByHash", [txid]),
          receipt,
        ),
      ) === JSON.stringify(transactions.get(txid)),
      "TRANSACTION_CHANGED",
    );
  }
  for (const b of checkedBlocks.values())
    check(
      block(await call("eth_getBlockByNumber", [hex(b.number), false])).hash ===
        b.hash,
      "CANONICAL_BLOCK_CHANGED",
    );
  check(
    block(await call("eth_getBlockByNumber", [hex(finalized.number), false]))
      .hash === finalized.hash &&
      block(await call("eth_getBlockByNumber", ["finalized", false])).number >=
        finalized.number &&
      quantity(await call("eth_chainId", [])) === 560048n,
    "FINAL_ANCHOR_CHANGED",
  );
  return {
    status: "VERIFIED_RECEIPTS_ONLY",
    scope: "vault-fraction-receipts-only",
    chainId: 560048,
    namespace: m.namespace,
    transactions: m.transactions,
    stateBlockHash: fraction.blockHash,
    stateBlockNumber: fraction.blockNumber,
    tokenId: m.asset.tokenId,
    fractionSupply: m.fraction.supply,
    recipientBalanceAtStateBlock: recipientBalance.toString(),
    finalizedAtStart: {
      number: finalized.number.toString(),
      hash: finalized.hash,
    },
    transactionSent: false,
    ...limits,
  };
}
