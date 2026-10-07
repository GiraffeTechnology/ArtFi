import { expect, test } from "@playwright/test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  zeroHash,
  type Hex,
} from "viem";

import { charityEditionsAbi } from "../src/lib/contracts";
import { supportedChain } from "../src/lib/wagmi";

/**
 * The populated rendering path.
 *
 * Explicit browser fixture, in the same sense as `market-unavailable.spec.ts`: the JSON-RPC
 * responses below are stubbed in the browser, so this proves **presentation**, not live chain
 * connectivity. It is here because the unavailable state is easy to test and the populated state is
 * the one that actually has to be right — a card that renders the wrong supply, or that silently
 * upgrades an empty distribution wallet to "sold out", would otherwise reach a reviewer unchecked.
 *
 * Nothing in the application changes to accommodate it. The page still reads the same contract
 * through the same client; only the transport is intercepted.
 */

const distributionWallet = "0x00000000000000000000000000000000000000a1";

const series = {
  artworkId: `0x${"11".repeat(32)}` as Hex,
  masterArtworkHash: `0x${"22".repeat(32)}` as Hex,
  metadataHash: `0x${"33".repeat(32)}` as Hex,
  distributionWallet: distributionWallet as Hex,
  createdAt: 1_760_000_000n,
  soldOutAt: 0n,
  physicalDonationRecordedAt: 0n,
  selloutEvidenceHash: zeroHash,
  physicalDonationEvidenceHash: zeroHash,
  metadataURI: "ipfs://charity/1",
};

function answer(data: Hex): Hex {
  const call = decodeFunctionData({ abi: charityEditionsAbi, data });
  switch (call.functionName) {
    case "seriesCount":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "seriesCount",
        result: 1n,
      });
    case "EDITIONS_PER_ARTWORK":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "EDITIONS_PER_ARTWORK",
        result: 100n,
      });
    case "PRIMARY_PRICE_WEI":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "PRIMARY_PRICE_WEI",
        result: 10_000_000_000_000_000n,
      });
    case "series":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "series",
        result: series,
      });
    case "totalSupply":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "totalSupply",
        result: 100n,
      });
    case "balanceOf":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "balanceOf",
        result: 63n,
      });
    default:
      throw new Error(`unexpected call ${call.functionName}`);
  }
}

/**
 * viem batches the page's parallel reads through Multicall3, so the stub has to speak it. Without
 * this the fixture would only ever exercise a single-read path the application does not take.
 */
const multicall3Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const call3Type = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;
const result3Type = [
  {
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  },
] as const;
const aggregate3Selector = "0x82ad56cb";

function answerCall(to: string | undefined, data: Hex): Hex {
  if (
    to?.toLowerCase() === multicall3Address.toLowerCase() &&
    data.startsWith(aggregate3Selector)
  ) {
    const [calls] = decodeAbiParameters(
      call3Type,
      `0x${data.slice(aggregate3Selector.length)}` as Hex,
    );
    return encodeAbiParameters(result3Type, [
      calls.map((call) => ({
        success: true,
        returnData: answer(call.callData),
      })),
    ]);
  }
  return answer(data);
}

type RpcRequest = { id: number; method: string; params?: unknown[] };

/** Answer the whole JSON-RPC conversation, not only `eth_call`: an unanswered probe hangs. */
function rpcResult(request: RpcRequest): unknown {
  switch (request.method) {
    case "eth_chainId":
      return `0x${supportedChain.id.toString(16)}`;
    case "eth_blockNumber":
      return "0x1";
    case "eth_call": {
      const call = request.params?.[0] as { to?: string; data: Hex };
      return answerCall(call.to, call.data);
    }
    default:
      throw new Error(`unexpected RPC method ${request.method}`);
  }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const body = request.postData();
    if (request.method() !== "POST" || !body?.includes("jsonrpc")) {
      return route.fallback();
    }
    const payload = JSON.parse(body) as RpcRequest | RpcRequest[];
    const respond = (single: RpcRequest) => ({
      jsonrpc: "2.0",
      id: single.id,
      result: rpcResult(single),
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(respond) : respond(payload),
      ),
    });
  });
});

/**
 * Skipped unless an editions address is configured, because with none the catalog correctly reports
 * itself unavailable and there is nothing populated to assert. Run it with:
 *
 *   NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS=0x… pnpm --filter web test:e2e
 */
test("an edition renders the supply the contract reports", async ({ page }) => {
  test.skip(
    !process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS,
    "No editions address is configured for this run.",
  );
  await page.goto("/charity");
  const card = page.locator(".charity-edition-card").first();
  await expect(card).toContainText("Edition #1");
  await expect(card).toContainText("63 of 100");
  await expect(card).toContainText("Not recorded");
  await expect(page.getByTestId("charity-edition-terms")).toContainText(
    "0.01 ETH",
  );
});
