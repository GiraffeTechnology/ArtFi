import { createRequire } from "node:module";

const { Interface, AbiCoder, keccak256 } = createRequire(
  new URL("../../../apps/web/package.json", import.meta.url),
)("ethers");

export const TEST_MARKERS = Object.freeze([
  "TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT",
]);
export const CHARITY_ABI = [
  "function createSeriesBatch((bytes32 artworkId,bytes32 masterArtworkHash,bytes32 metadataHash,address distributionWallet,string metadataURI)[] inputs) returns (uint256[])",
  "function series(uint256 tokenId) view returns ((bytes32 artworkId,bytes32 masterArtworkHash,bytes32 metadataHash,address distributionWallet,uint64 createdAt,uint64 soldOutAt,uint64 physicalDonationRecordedAt,bytes32 selloutEvidenceHash,bytes32 physicalDonationEvidenceHash,string metadataURI))",
  "function totalSupply(uint256 tokenId) view returns (uint256)",
  "event SeriesCreated(uint256 indexed tokenId,bytes32 indexed artworkId,bytes32 indexed masterArtworkHash,address distributionWallet,bytes32 metadataHash,string metadataURI)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event URI(string value,uint256 indexed id)",
];
export const SAFE_ABI = [
  "function execute(uint256 transactionId) returns (bytes)",
  "function transaction(uint256 transactionId) view returns ((bytes32 requestId,address target,uint256 value,bytes data,uint64 readyAt,uint32 confirmations,bool executed))",
  "function threshold() view returns (uint256)",
  "function delaySeconds() view returns (uint64)",
  "event TransactionExecuted(uint256 indexed transactionId,address indexed executor,bytes32 returndataHash)",
];
const charity = new Interface(CHARITY_ABI);
const safe = new Interface(SAFE_ABI);
const coder = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const ZERO_HASH = "0x" + "0".repeat(64);
// Frozen public release identity. It must never be reused for the isolated payload.
const FROZEN_SEPOLIA_COLLECTION = "0xec7d57e6f91fe1d1ee1ec0cb1df8e869088de104";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function requireThat(value, message) {
  if (!value) throw new Error(message);
}
function keys(value, expected, label) {
  requireThat(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  requireThat(Object.keys(value).sort().join(",") === [...expected].sort().join(","), label + " has unexpected or missing fields");
}
function hash(value, label) {
  requireThat(typeof value === "string" && HASH.test(value) && !same(value, ZERO_HASH), label + " must be a nonzero hash");
}
function address(value, label) {
  requireThat(typeof value === "string" && ADDRESS.test(value) && !same(value, ZERO_ADDRESS), label + " must be a nonzero address");
}
function positiveDecimal(value, label) {
  requireThat(typeof value === "string" && DECIMAL.test(value) && BigInt(value) < 2n ** 256n, label + " must be a canonical positive uint256 string");
}
function quantity(value, label) {
  requireThat(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value), label + " is not a canonical RPC quantity");
  return BigInt(value);
}

export function validateAtomicReceiptManifest(input) {
  // Work on a private snapshot so later caller mutations cannot change an in-flight verification.
  const m = structuredClone(input);
  keys(m, ["schema", "chainId", "namespace", "testAssetMarkers", "deployment", "execution", "series"], "manifest");
  requireThat(m.schema === "artfi-hoodi-charity-atomic-receipt/v1" && m.chainId === 560048, "only the isolated Hoodi receipt schema is supported");
  requireThat(typeof m.namespace === "string" && /^TESTNET-AI-[A-Z0-9-]{1,64}$/.test(m.namespace), "a separate TESTNET-AI namespace is required");
  requireThat(Array.isArray(m.testAssetMarkers) && m.testAssetMarkers.length === 3 && TEST_MARKERS.every(x => m.testAssetMarkers.includes(x)), "all three exact test markers are required");
  keys(m.deployment, ["collection", "runtimeCodeHash", "safe", "safeRuntimeCodeHash"], "deployment");
  address(m.deployment.collection, "collection"); address(m.deployment.safe, "safe");
  hash(m.deployment.runtimeCodeHash, "collection runtime"); hash(m.deployment.safeRuntimeCodeHash, "safe runtime");
  requireThat(!same(m.deployment.collection, m.deployment.safe) && !same(m.deployment.collection, FROZEN_SEPOLIA_COLLECTION), "isolated collection identity is invalid");
  keys(m.execution, ["transactionHash", "safeTransactionId", "requestId"], "execution");
  hash(m.execution.transactionHash, "transaction hash"); hash(m.execution.requestId, "request id");
  positiveDecimal(m.execution.safeTransactionId, "safe transaction id");
  requireThat(Array.isArray(m.series) && m.series.length >= 1 && m.series.length <= 37, "one atomic call requires 1–37 series");
  const ids = new Set(), artworks = new Set(), masters = new Set();
  for (let i = 0; i < m.series.length; i++) {
    const s = m.series[i];
    keys(s, ["tokenId", "artworkId", "masterArtworkHash", "metadataHash", "distributionWallet", "metadataURI"], "series");
    positiveDecimal(s.tokenId, "token id");
    hash(s.artworkId, "artwork id"); hash(s.masterArtworkHash, "master commitment"); hash(s.metadataHash, "metadata commitment");
    address(s.distributionWallet, "distribution wallet");
    requireThat(typeof s.metadataURI === "string" && Buffer.byteLength(s.metadataURI) <= 512 && /^(?:https|ipfs):\/\//.test(s.metadataURI), "metadata URI is invalid");
    let uri; try { uri = new URL(s.metadataURI); } catch { throw new Error("metadata URI is invalid"); }
    requireThat(!uri.username && !uri.password && !uri.hash && !uri.search && uri.hostname && decodeURIComponent(uri.pathname).split("/").includes(m.namespace) && !/ye-yongrun|UNIT-A/i.test(decodeURIComponent(s.metadataURI)), "metadata must use its isolated namespace without the frozen release or credentials");
    requireThat(!ids.has(s.tokenId) && !artworks.has(s.artworkId.toLowerCase()) && !masters.has(s.masterArtworkHash.toLowerCase()), "duplicate batch binding");
    if (i) requireThat(BigInt(s.tokenId) === BigInt(m.series[i-1].tokenId) + 1n, "token ids must be ordered and contiguous");
    ids.add(s.tokenId); artworks.add(s.artworkId.toLowerCase()); masters.add(s.masterArtworkHash.toLowerCase());
  }
  return m;
}

function parsedEvents(receipt, target, iface) {
  return receipt.logs.filter(log => same(log.address, target)).map(log => {
    const event = iface.parseLog(log);
    requireThat(event, "unknown log at bound contract");
    return event;
  });
}
function assertInputs(actual, expected) {
  requireThat(actual.length === expected.length, "batch calldata length mismatch");
  actual.forEach((s, i) => {
    for (const field of ["artworkId", "masterArtworkHash", "metadataHash", "distributionWallet"]) {
      requireThat(same(s[field], expected[i][field]), "batch calldata commitment mismatch");
    }
    requireThat(s.metadataURI === expected[i].metadataURI, "batch calldata URI mismatch");
  });
}

/**
 * send is the existing provider's read-only JSON-RPC method. It must be an independently selected,
 * approved Hoodi route. A successful result is scoped receipt evidence, not a trust attestation
 * for this caller-provided provider, manifest, deployment or AI assets.
 */
export async function verifyHoodiCharityAtomicReceipt(input, send) {
  const m = validateAtomicReceiptManifest(input);
  const rpc = async (method, params) => send(method, params);
  requireThat(quantity(await rpc("eth_chainId", []), "chain") === 560048n, "RPC is not Hoodi");
  const txHash = m.execution.transactionHash;
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  requireThat(receipt && same(receipt.transactionHash, txHash) && receipt.status === "0x1", "missing or unsuccessful transaction receipt");
  hash(receipt.blockHash, "receipt block");
  const height = quantity(receipt.blockNumber, "receipt height");
  requireThat(height > 0n && Array.isArray(receipt.logs), "unmined or malformed receipt");
  const canonical = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  requireThat(canonical && same(canonical.hash, receipt.blockHash) && quantity(canonical.number, "canonical height") === height, "receipt block is not canonical");
  const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
  requireThat(finalized && quantity(finalized.number, "finalized height") >= height, "receipt is not finalized");
  hash(finalized.hash, "finalized block");
  const finalizedCanonical = await rpc("eth_getBlockByNumber", [finalized.number, false]);
  requireThat(finalizedCanonical && same(finalizedCanonical.hash, finalized.hash) && quantity(finalizedCanonical.number, "finalized canonical height") === quantity(finalized.number, "finalized height"), "finalized block disagrees with the canonical chain");
  const tx = await rpc("eth_getTransactionByHash", [txHash]);
  requireThat(tx && same(tx.hash, txHash) && same(tx.blockHash, receipt.blockHash) && tx.blockNumber === receipt.blockNumber && same(tx.to, m.deployment.safe) && same(receipt.to, m.deployment.safe) && quantity(tx.value, "transaction value") === 0n, "execution transaction binding mismatch");
  const outer = safe.parseTransaction({ data: tx.input, value: 0n });
  requireThat(outer?.name === "execute" && outer.args[0] === BigInt(m.execution.safeTransactionId), "transaction does not execute the bound Safe action");
  // EIP-1898 pins all state reads to the same canonical block. Unsupported providers fail closed.
  const block = { blockHash: receipt.blockHash, requireCanonical: true };
  for (const [target, expected] of [[m.deployment.collection, m.deployment.runtimeCodeHash], [m.deployment.safe, m.deployment.safeRuntimeCodeHash]]) {
    const code = await rpc("eth_getCode", [target, block]);
    requireThat(typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && same(keccak256(code), expected), "deployed runtime code hash mismatch");
  }
  async function call(iface, target, name, args = []) {
    const data = await rpc("eth_call", [{ to: target, data: iface.encodeFunctionData(name, args) }, block]);
    return iface.decodeFunctionResult(name, data);
  }
  const [action] = await call(safe, m.deployment.safe, "transaction", [BigInt(m.execution.safeTransactionId)]);
  requireThat(same(action.requestId, m.execution.requestId) && same(action.target, m.deployment.collection) && action.value === 0n && action.executed === true, "stored Safe action mismatch");
  const [threshold] = await call(safe, m.deployment.safe, "threshold");
  const [delay] = await call(safe, m.deployment.safe, "delaySeconds");
  const timestamp = quantity(canonical.timestamp, "block timestamp");
  requireThat(threshold >= 2n && delay > 0n && action.confirmations >= threshold && action.readyAt > 0n && action.readyAt <= timestamp, "Safe threshold/timelock evidence mismatch");
  const inner = charity.parseTransaction({ data: action.data, value: 0n });
  requireThat(inner?.name === "createSeriesBatch", "Safe action is not atomic batch creation");
  assertInputs(inner.args[0], m.series);
  requireThat(same(charity.encodeFunctionData("createSeriesBatch", [inner.args[0]]), action.data), "batch calldata is not canonical");
  requireThat(same(safe.encodeFunctionData("execute", [outer.args[0]]), tx.input), "Safe calldata is not canonical");
  const indexes = new Set();
  for (const log of receipt.logs) {
    requireThat(log && log.removed === false && same(log.transactionHash, txHash) && same(log.blockHash, receipt.blockHash) && log.blockNumber === receipt.blockNumber, "removed or mismatched receipt log");
    const index = quantity(log.logIndex, "log index").toString();
    requireThat(!indexes.has(index), "duplicate receipt log index"); indexes.add(index);
  }
  const events = parsedEvents(receipt, m.deployment.collection, charity);
  requireThat(events.length === m.series.length * 3, "unexpected collection log count");
  const created = events.filter(e => e.name === "SeriesCreated");
  const minted = events.filter(e => e.name === "TransferSingle");
  const uris = events.filter(e => e.name === "URI");
  requireThat(created.length === m.series.length && minted.length === m.series.length && uris.length === m.series.length, "incomplete atomic series event set");
  for (let i = 0; i < m.series.length; i++) {
    const s = m.series[i], id = BigInt(s.tokenId), c = created[i].args, t = minted[i].args, u = uris[i].args;
    requireThat(c.tokenId === id && same(c.artworkId, s.artworkId) && same(c.masterArtworkHash, s.masterArtworkHash) && same(c.distributionWallet, s.distributionWallet) && same(c.metadataHash, s.metadataHash) && c.metadataURI === s.metadataURI, "SeriesCreated does not bind every expected field");
    requireThat(t.id === id && t.value === 100n && same(t.from, ZERO_ADDRESS) && same(t.to, s.distributionWallet) && same(t.operator, m.deployment.safe), "fixed-supply mint event mismatch");
    requireThat(u.id === id && u.value === s.metadataURI, "metadata URI event mismatch");
    const [state] = await call(charity, m.deployment.collection, "series", [id]);
    requireThat(state.createdAt === timestamp && same(state.artworkId, s.artworkId) && same(state.masterArtworkHash, s.masterArtworkHash) && same(state.metadataHash, s.metadataHash) && same(state.distributionWallet, s.distributionWallet) && state.metadataURI === s.metadataURI, "stored series does not match the receipt");
    const [supply] = await call(charity, m.deployment.collection, "totalSupply", [id]);
    requireThat(supply === 100n, "stored supply is not fixed at 100");
  }
  const safeEvents = parsedEvents(receipt, m.deployment.safe, safe);
  requireThat(safeEvents.length === 1 && safeEvents[0].name === "TransactionExecuted" && safeEvents[0].args.transactionId === BigInt(m.execution.safeTransactionId) && same(safeEvents[0].args.executor, tx.from), "Safe execution event mismatch");
  const expectedReturn = keccak256(coder.encode(["uint256[]"], [m.series.map(s => BigInt(s.tokenId))]));
  requireThat(same(safeEvents[0].args.returndataHash, expectedReturn), "Safe return-data hash mismatch");
  // No retry or broadcast. Re-read identity after all awaited calls; reorg or disagreement fails.
  const again = await rpc("eth_getTransactionReceipt", [txHash]);
  const canonicalAgain = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  requireThat(again && JSON.stringify(again) === JSON.stringify(receipt) && canonicalAgain && same(canonicalAgain.hash, receipt.blockHash) && quantity(await rpc("eth_chainId", []), "final chain") === 560048n, "receipt or chain changed during verification");
  return {
    verified: true, scope: "atomic-charity-batch-receipt-only", chainId: 560048,
    namespace: m.namespace, testAssetMarkers: [...TEST_MARKERS],
    transactionHash: txHash, collection: m.deployment.collection, safe: m.deployment.safe,
    blockHash: receipt.blockHash, blockNumber: height.toString(), finalizedAtLeast: finalized.number,
    seriesCount: m.series.length, totalUnits: m.series.length * 100,
    wholeProductAccepted: false, assetGenerationVerified: false, metadataContentVerified: false,
  };
}

