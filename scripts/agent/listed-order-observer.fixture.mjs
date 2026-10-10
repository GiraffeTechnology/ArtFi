import {
  createRequire,
  registerHooks,
  stripTypeScriptTypes,
} from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NFT_SALE_NATIVE_POLICY } from "./nft-sale-evidence.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { createNftSaleTermsVerifier } from "./nft-sale-terms.mjs";

// Entirely synthetic receipts and bytecode, encoded with the installed official
// ABI. No signer, RPC, venue credential, broadcast or real-chain write exists.
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const sourceRoot = new URL("../../apps/web/src/lib/nft/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith(".")
      )
        return next(`${specifier}.ts`, context);
      if (specifier.startsWith("@opensea/"))
        return {
          url: pathToFileURL(require.resolve(specifier)).href,
          shortCircuit: true,
        };
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts"))
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {
          mode: "transform",
        }),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const validation = await import("../../apps/web/src/lib/nft/validation.ts");
const { readNftRequest } = await import("../../apps/web/src/lib/nft/model.ts");
const ethers = require("ethers");
const { SeaportABI } = require("@opensea/seaport-js/lib/abi/Seaport");
const { EIP_712_ORDER_TYPE } = require("@opensea/seaport-js/lib/constants");
const seaport = new ethers.Interface(SeaportABI);
const erc721 = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
const erc1155 = new ethers.Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const addr = (c) => `0x${c.repeat(40)}`;
const hash = (c) => `0x${c.repeat(64)}`;
const ZERO = addr("0"),
  ZERO_HASH = hash("0"),
  seller = addr("1"),
  buyer = addr("2"),
  nft = addr("3"),
  fee1 = addr("4"),
  fee2 = addr("5");
const protocol = "0x0000000000000068F116a894984e2DB1123eB395";
const runtimeCode = "0x6000600055";
const item = (itemType, token, identifierOrCriteria, amount, recipient) => ({
  itemType,
  token,
  identifierOrCriteria,
  startAmount: amount,
  endAmount: amount,
  ...(recipient ? { recipient } : {}),
});

function fixture({
  standard = "erc721",
  chainId = "1",
  method = "fulfillOrder",
  size = standard === "erc721" ? "1" : "4",
  requested = size,
  fill = requested,
} = {}) {
  const components = {
    offerer: seller,
    zone: ZERO,
    offer: [item(standard === "erc721" ? 2 : 3, nft, "7", size)],
    consideration: [
      item(0, ZERO, "0", "900", seller),
      item(0, ZERO, "0", "60", fee1),
      item(0, ZERO, "0", "40", fee2),
    ],
    orderType: standard === "erc721" ? 0 : 1,
    startTime: "100",
    endTime: "1000",
    zoneHash: ZERO_HASH,
    salt: "9",
    conduitKey: ZERO_HASH,
    counter: "0",
  };
  const scaled = (n, q = requested) =>
    ((BigInt(n) * BigInt(q)) / BigInt(size)).toString();
  const order = {
    schema: "artfi-nft-sale-order/1",
    nativeAction: "list",
    binding: {
      taskDigest: hash("f"),
      nativePlanId: "synthetic-plan",
      nativeOperationId: "synthetic-operation",
      reviewDigest: "e".repeat(64),
      orderHash: ethers.TypedDataEncoder.hashStruct(
        "OrderComponents",
        EIP_712_ORDER_TYPE,
        components,
      ),
      typedDataDigest: ethers.TypedDataEncoder.hash(
        {
          name: "Seaport",
          version: "1.6",
          chainId: Number(chainId),
          verifyingContract: protocol,
        },
        EIP_712_ORDER_TYPE,
        components,
      ),
    },
    chainId,
    protocol,
    seller,
    nft: { standard, contract: nft, tokenId: "7", quantity: requested },
    payment: { itemType: 0, token: ZERO, symbol: "ETH", decimals: 18 },
    components,
    amounts: {
      gross: scaled("1000"),
      fees: scaled("100"),
      sellerNet: scaled("900"),
    },
    feeRecipients: [
      { recipient: fee1, amount: scaled("60") },
      { recipient: fee2, amount: scaled("40") },
    ],
  };
  const parameters = {
    ...components,
    totalOriginalConsiderationItems: components.consideration.length,
  };
  const data =
    method === "fulfillAdvancedOrder"
      ? seaport.encodeFunctionData(method, [
          {
            parameters,
            signature: "0x",
            numerator: fill,
            denominator: size,
            extraData: "0x",
          },
          [],
          ZERO_HASH,
          buyer,
        ])
      : seaport.encodeFunctionData(method, [
          { parameters, signature: "0x" },
          ZERO_HASH,
        ]);
  const transactionHash = hash("a"),
    blockHash = hash("b");
  const transaction = {
    chainId,
    hash: transactionHash,
    blockHash,
    blockNumber: 100,
    from: buyer,
    to: protocol,
    data,
    value: scaled("1000", fill),
    nonce: 17,
  };
  const context = {
    chainId,
    transactionHash,
    blockHash,
    blockNumber: 100,
    removed: false,
  };
  const log = (iface, name, address, args, index) => ({
    ...context,
    ...iface.encodeEventLog(iface.getEvent(name), args),
    address,
    index,
  });
  const eventItem = (i, consideration) => [
    i.itemType,
    i.token,
    i.identifierOrCriteria,
    scaled(i.startAmount, fill),
    ...(consideration ? [i.recipient] : []),
  ];
  const sale = log(
    seaport,
    "OrderFulfilled",
    protocol,
    [
      order.binding.orderHash,
      seller,
      ZERO,
      buyer,
      components.offer.map((i) => eventItem(i, false)),
      components.consideration.map((i) => eventItem(i, true)),
    ],
    0,
  );
  const transfer =
    standard === "erc721"
      ? log(erc721, "Transfer", nft, [seller, buyer, "7"], 1)
      : log(
          erc1155,
          "TransferSingle",
          nft,
          [protocol, seller, buyer, "7", fill],
          1,
        );
  const evidence = {
    transaction,
    receipt: {
      transactionHash,
      chainId,
      from: buyer,
      to: protocol,
      blockHash,
      blockNumber: 100,
      status: 1,
      logs: [sale, transfer],
    },
    deploymentEvidence: { runtimeCode },
  };
  const config = {
    ethers,
    orderTypes: EIP_712_ORDER_TYPE,
    seaportABI: SeaportABI,
    expectedOrder: order,
    observationPolicy: {
      id: "synthetic-policy",
      taskDigest: order.binding.taskDigest,
      chainId,
      sourceId: "synthetic-reader",
      minimumConfirmations: 3,
    },
    allowedDeployments: [
      {
        chainId,
        address: protocol,
        runtimeCodeHash: ethers.keccak256(runtimeCode),
        proxyOrUpgradeAllowed: false,
        reviewEvidenceSha256: "1".repeat(64),
        nativeConsiderationPolicy: NFT_SALE_NATIVE_POLICY,
      },
    ],
  };
  return { config, order, evidence };
}
export {
  fixture,
  ethers,
  seaport,
  validation,
  readNftRequest,
  EIP_712_ORDER_TYPE,
  kernelRequestDigest,
  createNftSaleTermsVerifier,
  seller,
  buyer,
  nft,
  fee1,
  fee2,
  protocol,
  ZERO,
  ZERO_HASH,
  hash,
};
