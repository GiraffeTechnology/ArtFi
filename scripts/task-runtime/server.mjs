/** Fixed internal ArtFi/Wallet product composition. No configurable code loader. */
import "server-only";
import * as ethers from "ethers";
import { OpenSeaSDK, OpenSeaAPI } from "@opensea/sdk";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport.js";
import { EIP_712_ORDER_TYPE } from "@opensea/seaport-js/lib/constants.js";
import { createNativeNftTaskPort } from "../../apps/web/src/lib/nft/task-port.ts";
import {
  createNftTaskJournal,
  nftTaskJournalDigest,
} from "../../apps/web/src/lib/nft/task-journal.ts";
import * as validation from "../../apps/web/src/lib/nft/validation.ts";
import {
  NFT_CHAINS,
  NftError,
  readNftRequest,
} from "../../apps/web/src/lib/nft/model.ts";
import { ReadOnlyNftProvider } from "../../apps/web/src/lib/nft/recorder.ts";
import { SEAPORT } from "../../apps/web/src/lib/nft/config.ts";
import { venueFetch } from "../../apps/web/src/lib/nft/venue.ts";
import { kernelRequestDigest } from "../agent/agent-kernel.mjs";
import { createNftSaleTermsVerifier } from "../agent/nft-sale-terms.mjs";
import { createListedOrderObserver } from "../agent/listed-order-observer.mjs";
import { NFT_SALE_NATIVE_POLICY } from "../agent/nft-sale-evidence.mjs";

export {
  createNativeNftTaskPort,
  createNftTaskJournal,
  nftTaskJournalDigest,
  ethers,
  validation,
  readNftRequest,
  kernelRequestDigest,
  createNftSaleTermsVerifier,
  createListedOrderObserver,
};
const refuse = (ok, code = "ARTFI_LISTING_CONFIGURATION_INVALID") => {
  if (!ok) throw new NftError(503, code);
};
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function json(value, depth = 0) {
  refuse(depth <= 12);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    refuse(Number.isSafeInteger(value));
    return;
  }
  const array = Array.isArray(value);
  refuse(
    array ? Object.getPrototypeOf(value) === Array.prototype : plain(value),
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    const length = descriptors.length.value;
    refuse(length <= 10000 && Object.keys(descriptors).length === length + 1);
    for (let index = 0; index < length; index++)
      refuse(Object.hasOwn(descriptors, String(index)));
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    refuse(
      Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable &&
        !["__proto__", "constructor", "prototype"].includes(key),
    );
    json(descriptor.value, depth + 1);
  }
  refuse(Object.getOwnPropertySymbols(value).length === 0);
}
function keys(value, required, optional = []) {
  refuse(
    plain(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
  );
}
const count = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const address = (value) =>
  typeof value === "string" &&
  ethers.isAddress(value) &&
  value !== ethers.ZeroAddress;
const hash = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/i.test(value) &&
  value !== ethers.ZeroHash;

/** Pure strict JSON preflight; does not read credentials, contact RPC, or authorize a task. */
export function validateServerListingConfig(input) {
  json(input);
  refuse(Buffer.byteLength(JSON.stringify(input)) <= 65536);
  const config = structuredClone(input);
  keys(config, [
    "schema",
    "chainId",
    "executionZone",
    "tradingEnabled",
    "collections",
    "rpc",
    "sdkTimeoutMs",
    "observation",
  ]);
  refuse(
    config.schema === "artfi-server-listing-config/1" &&
      ["1", "8453"].includes(config.chainId) &&
      config.executionZone === "sin" &&
      typeof config.tradingEnabled === "boolean" &&
      config.sdkTimeoutMs === 12000,
  );
  refuse(
    Array.isArray(config.collections) &&
      config.collections.length >= 1 &&
      config.collections.length <= 100,
  );
  const slugs = new Set();
  for (const collection of config.collections) {
    keys(collection, [
      "slug",
      "chain",
      "contract",
      "standard",
      "label",
      "charity",
    ]);
    refuse(
      typeof collection.slug === "string" &&
        /^[a-z0-9][a-z0-9-]{0,99}$/.test(collection.slug) &&
        !slugs.has(collection.slug) &&
        Object.hasOwn(NFT_CHAINS, collection.chain) &&
        String(NFT_CHAINS[collection.chain]) === config.chainId &&
        address(collection.contract) &&
        ["erc721", "erc1155"].includes(collection.standard) &&
        typeof collection.label === "string" &&
        collection.label.trim().length >= 1 &&
        collection.label.length <= 160 &&
        typeof collection.charity === "boolean",
    );
    slugs.add(collection.slug);
  }
  keys(config.rpc, ["url", "sourceId", "timeoutMs"]);
  refuse(
    typeof config.rpc.url === "string" &&
      config.rpc.url.length <= 2048 &&
      id(config.rpc.sourceId) &&
      count(config.rpc.timeoutMs, 100, 12000),
  );
  let url;
  try {
    url = new URL(config.rpc.url);
  } catch {
    refuse(false);
  }
  refuse(
    !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
  );
  config.rpc.url = url.toString();
  keys(config.observation, ["policyId", "allowedDeployments", "scanPolicy"]);
  refuse(id(config.observation.policyId));
  const deployments = config.observation.allowedDeployments;
  refuse(
    Array.isArray(deployments) &&
      deployments.length >= 1 &&
      deployments.length <= 32,
  );
  const deploymentKeys = new Set();
  for (const deployment of deployments) {
    keys(
      deployment,
      [
        "chainId",
        "address",
        "runtimeCodeHash",
        "proxyOrUpgradeAllowed",
        "reviewEvidenceSha256",
      ],
      ["nativeConsiderationPolicy"],
    );
    const key = `${deployment.chainId}:${String(deployment.address).toLowerCase()}`;
    refuse(
      deployment.chainId === config.chainId &&
        address(deployment.address) &&
        deployment.address.toLowerCase() === SEAPORT.toLowerCase() &&
        !deploymentKeys.has(key) &&
        hash(deployment.runtimeCodeHash) &&
        deployment.proxyOrUpgradeAllowed === false &&
        /^[0-9a-f]{64}$/i.test(deployment.reviewEvidenceSha256) &&
        (deployment.nativeConsiderationPolicy === undefined ||
          deployment.nativeConsiderationPolicy === NFT_SALE_NATIVE_POLICY),
    );
    deploymentKeys.add(key);
  }
  const scan = config.observation.scanPolicy;
  keys(scan, [
    "fromBlock",
    "throughBlock",
    "blocksPerPage",
    "maxPagesPerRun",
    "maxLogsPerPage",
    "maxCandidatesPerRun",
  ]);
  refuse(
    count(scan.fromBlock, 1, Number.MAX_SAFE_INTEGER - 1) &&
      count(scan.throughBlock, scan.fromBlock, Number.MAX_SAFE_INTEGER - 1) &&
      count(scan.blocksPerPage, 1, 10000) &&
      count(scan.maxPagesPerRun, 1, 100) &&
      count(scan.maxLogsPerPage, 1, 10000) &&
      count(scan.maxCandidatesPerRun, 1, 1000),
  );
  return freeze(config);
}

/** Only trusted in-process journal/clock functions are injectable. Authority is supplied by Wallet. */
export function createServerListingDependencies(
  input,
  { journal, now = Date.now } = {},
) {
  const config = validateServerListingConfig(input);
  refuse(
    typeof journal === "function" && typeof now === "function",
    "ARTFI_LISTING_ADAPTER_REQUIRED",
  );
  apiKey();
  const scopes = new Map(
    config.collections.map((scope) => [scope.slug, scope]),
  );
  const provider = new ReadOnlyNftProvider(
    Object.assign(new ethers.FetchRequest(config.rpc.url), {
      timeout: config.rpc.timeoutMs,
    }),
    undefined,
    { batchMaxCount: 1, cacheTimeout: -1 },
  );
  function scope(slug) {
    const selected = scopes.get(slug);
    if (!selected)
      throw new NftError(404, "This digital NFT collection is not configured.");
    return selected;
  }
  function boundScope(value) {
    const selected = scope(value?.slug);
    refuse(
      kernelRequestDigest(value) === kernelRequestDigest(selected),
      "ARTFI_LISTING_SCOPE_INVALID",
    );
    return selected;
  }
  function apiKey() {
    const key = process.env.OPENSEA_API_KEY?.trim();
    refuse(Boolean(key), "ARTFI_LISTING_OPENSEA_UNCONFIGURED");
    return key;
  }
  const readMethods = new Set([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getLogs",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getCode",
  ]);
  const readOnlyProvider = Object.freeze({
    sourceId: config.rpc.sourceId,
    async request({ method, params = [] }) {
      refuse(
        readMethods.has(method) && Array.isArray(params),
        "ARTFI_LISTING_RPC_WRITE_FORBIDDEN",
      );
      return structuredClone(
        await provider.send(method, structuredClone(params)),
      );
    },
  });
  return Object.freeze({
    nativeDependencies: Object.freeze({
      requireTrading() {
        refuse(config.tradingEnabled, "ARTFI_LISTING_TRADING_DISABLED");
        apiKey();
      },
      scope,
      provider(value) {
        boundScope(value);
        return provider;
      },
      sdk(recorder, value) {
        return new OpenSeaSDK(
          recorder,
          {
            chain: validation.sdkChain(boundScope(value)),
            apiKey: apiKey(),
            fetch: venueFetch("prepare"),
          },
          () => undefined,
        );
      },
      api(value, mode = "read") {
        refuse(
          ["read", "prepare", "submit"].includes(mode),
          "ARTFI_LISTING_VENUE_MODE_INVALID",
        );
        return new OpenSeaAPI({
          chain: validation.sdkChain(boundScope(value)),
          apiKey: apiKey(),
          fetch: venueFetch(mode),
        });
      },
      journal,
    }),
    observationDependencies: Object.freeze({
      ethers,
      orderTypes: freeze(structuredClone(EIP_712_ORDER_TYPE)),
      seaportABI: freeze(structuredClone(SeaportABI)),
      allowedDeployments: config.observation.allowedDeployments,
      scanPolicy: config.observation.scanPolicy,
      policyId: config.observation.policyId,
      readOnlyProvider,
    }),
    canonicalReader: readOnlyProvider,
  });
}
