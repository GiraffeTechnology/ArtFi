import test from "node:test";
import assert from "node:assert/strict";
import * as ethers from "ethers";
import { compileStage1Action } from "../../../scripts/agent/stage1-action-plans.mjs";
import { nftFixture } from "./native-nft-reference.test.mjs";
const wrapped = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
};
const token = (action, chain) =>
  ["list", "buy"].includes(action) ? ethers.ZeroAddress : wrapped[chain];
const compile = (f, chain, request = f.request, nativePlan = f.nativePlan) =>
  compileStage1Action(request, { ethers, chainId: chain, nativePlan });
// Static original Stage1 Ethereum/Base ETH/WETH records and offline identities.
// No RPC, token transfer, real signing or arbitrary currency conversion.
test("A2 native payment accepts exact original ETH/WETH token identities", async () => {
  for (const chain of ["1", "8453"])
    for (const action of ["list", "offer", "buy", "accept", "cancel"]) {
      const f = await nftFixture(action, chain);
      f.request.paymentToken = token(action, chain);
      assert.equal(
        compile(f, chain).legs[0].paymentToken.toLowerCase(),
        token(action, chain).toLowerCase(),
      );
    }
});
test("A2 native payment refuses a differently labelled payment asset", async (t) => {
  for (const chain of ["1", "8453"])
    for (const action of ["list", "offer", "buy", "accept", "cancel"])
      await t.test(chain + "-" + action, async () => {
        const f = await nftFixture(action, chain);
        f.request.paymentToken = ethers.getAddress(
          "0x1111111111111111111111111111111111111111",
        );
        assert.throws(
          () => compile(f, chain),
          /NATIVE_NFT_PAYMENT_TOKEN_REFUSED/,
        );
      });
});
test("A2 native payment refuses absent unknown and changed plan currency", async (t) => {
  for (const value of [undefined, "USDC", "eth", "WETH"])
    await t.test(String(value), async () => {
      const f = await nftFixture("buy", "1");
      f.request.paymentToken = ethers.ZeroAddress;
      if (value === undefined) delete f.nativePlan.paymentToken;
      else f.nativePlan.paymentToken = value;
      assert.throws(() => compile(f, "1"), /NATIVE_NFT_PAYMENT_TOKEN_REFUSED/);
    });
});
test("A2 native payment refuses wrapped token from the other supported chain", async (t) => {
  for (const chain of ["1", "8453"])
    await t.test(chain, async () => {
      const f = await nftFixture("accept", chain);
      f.request.paymentToken = wrapped[chain === "1" ? "8453" : "1"];
      assert.throws(
        () => compile(f, chain),
        /NATIVE_NFT_PAYMENT_TOKEN_REFUSED/,
      );
    });
});
test("A2 native ETH sentinel does not broaden fraction or whole payment requests", async () => {
  const f = await nftFixture("buy", "1");
  for (const marketKind of ["FRACTION", "WHOLE", "AUCTION", "OFFERING"])
    assert.throws(
      () =>
        compile(f, "1", {
          ...f.request,
          marketKind,
          paymentToken: ethers.ZeroAddress,
        }),
      /ACTION_REQUEST_INVALID/,
    );
});
