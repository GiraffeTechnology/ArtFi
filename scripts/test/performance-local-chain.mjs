/** TEST_ONLY local EVM settlement fixture. Never accepts an external RPC URL. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  loopbackURL,
  mapLimited,
  sha256,
  summary,
  waitFor,
} from "./performance-common.mjs";
const {
  Wallet,
  JsonRpcProvider,
  FetchRequest,
  NonceManager,
  ContractFactory,
  MaxUint256,
  keccak256,
} = createRequire(
  new URL("../../apps/agent-runtime/package.json", import.meta.url),
)("ethers");

export async function runLocalTrades({
  root,
  rpcURL,
  count,
  launch,
  anvil,
  port,
}) {
  loopbackURL(rpcURL);
  // No pre-funded published development keys, fork URL, state dump or console output.
  launch(
    "anvil",
    anvil,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "560048",
      "--accounts",
      "0",
      "--quiet",
      "--threads",
      "2",
    ],
    {},
    undefined,
    true,
  );
  const transport = new FetchRequest(rpcURL);
  transport.timeout = 10000;
  const provider = new JsonRpcProvider(transport, 560048, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  try {
    await waitFor(
      async () => (await provider.send("eth_chainId", [])) === "0x88bb0",
      "isolated Anvil",
    );
    assert.match(await provider.send("web3_clientVersion", []), /anvil/i);
    const seller = Wallet.createRandom().connect(provider);
    const admin = new NonceManager(seller);
    const buyers = Array.from({ length: count * 2 }, () =>
      Wallet.createRandom().connect(provider),
    );
    await mapLimited([seller, ...buyers], 10, (wallet) =>
      provider.send("anvil_setBalance", [
        wallet.address,
        "0x56bc75e2d63100000",
      ]),
    );
    const artifacts = {};
    async function artifact(file) {
      const path = join(root, "packages/contracts/out", file);
      const result = JSON.parse(await readFile(path, "utf8"));
      // Reject stale bytecode rather than imply testing today's Solidity source.
      for (const [source, data] of Object.entries(result.metadata.sources)) {
        const contents = await readFile(
          join(root, "packages/contracts", source),
        );
        assert.equal(
          keccak256(contents),
          data.keccak256,
          `Stale compiled source: ${source}`,
        );
      }
      artifacts[file] = await sha256(path);
      return result;
    }
    async function deploy(file, args = []) {
      const a = await artifact(file);
      const instance = await new ContractFactory(
        a.abi,
        a.bytecode.object,
        admin,
      ).deploy(...args);
      const receipt = await instance.deploymentTransaction().wait(1, 10000);
      assert.equal(receipt.status, 1);
      return instance;
    }
    const whole = await deploy(
      "WholeArtworkMarket.sol/WholeArtworkMarket.json",
      [seller.address, seller.address, seller.address],
    );
    const fraction = await deploy("ArtFiMarket.sol/ArtFiMarket.json", [
      seller.address,
      seller.address,
      seller.address,
    ]);
    const nft = await deploy("WholeArtworkMarket.t.sol/ArtworkNFT.json");
    const asset = await deploy("FractionSaleIntent.t.sol/IntentToken.json", [
      "TEST_ONLY Fraction",
      "TESTFRC",
    ]);
    const payment = await deploy("WholeArtworkMarket.t.sol/PaymentToken.json");
    const addresses = {
      whole: await whole.getAddress(),
      fraction: await fraction.getAddress(),
      nft: await nft.getAddress(),
      asset: await asset.getAddress(),
      payment: await payment.getAddress(),
    };
    const confirmed = async (promise) => {
      const receipt = await (await promise).wait(1, 10000);
      assert.equal(receipt.status, 1);
    };
    for (const transaction of [
      () => whole.setCollectionAllowed(addresses.nft, true),
      () => whole.setPaymentTokenAllowed(addresses.payment, true),
      () => fraction.setTokenPermission(addresses.asset, true, false),
      () => fraction.setTokenPermission(addresses.payment, false, true),
      () => asset.mint(seller.address, BigInt(count) * 10n),
      () => asset.approve(addresses.fraction, MaxUint256),
      () => nft.setApprovalForAll(addresses.whole, true),
    ])
      await confirmed(transaction());
    // Setup is excluded from timed settlement. Serialize the single admin nonce stream.
    for (let i = 0; i < count; i++)
      await confirmed(nft.mint(seller.address, i + 1));
    for (const buyer of buyers)
      await confirmed(payment.mint(buyer.address, 1000n));
    for (const buyer of buyers.slice(count))
      await confirmed(
        fraction.setPilotCap(buyer.address, addresses.payment, 1000n),
      );
    await mapLimited(buyers, 10, async (buyer, i) =>
      confirmed(
        payment
          .connect(buyer)
          .approve(
            i < count ? addresses.whole : addresses.fraction,
            MaxUint256,
          ),
      ),
    );
    const orders = [],
      events = [],
      receipts = [],
      profiles = [];
    for (const kind of ["whole", "fraction"]) {
      const market = kind === "whole" ? whole : fraction;
      const group =
        kind === "whole" ? buyers.slice(0, count) : buyers.slice(count);
      const now = Number((await provider.getBlock("latest")).timestamp);
      const jobs = await mapLimited(group, 10, async (buyer, i) => {
        const intent =
          kind === "whole"
            ? {
                seller: seller.address,
                collection: addresses.nft,
                tokenId: String(i + 1),
                paymentToken: addresses.payment,
                price: "100",
                buyer: buyer.address,
                salt: String(i + 1),
                startsAt: now - 1,
                endsAt: now + 3600,
                epoch: "0",
              }
            : {
                seller: seller.address,
                assetToken: addresses.asset,
                paymentToken: addresses.payment,
                maxAmount: "10",
                unitPrice: "3",
                buyer: buyer.address,
                salt: String(i + 1),
                startsAt: now - 1,
                endsAt: now + 3600,
                epoch: "0",
              };
        const hash = await market.intentHash(intent);
        const signature = seller.signingKey.sign(hash).serialized;
        const args =
          kind === "whole" ? [intent, signature] : [intent, signature, 10n];
        orders.push({
          kind,
          chainId: 560048,
          marketAddress: await market.getAddress(),
          intentHash: hash,
          intent,
          signature,
        });
        return { buyer, intent, hash, signature, args, i };
      });
      const estimateMs = [],
        submitMs = [],
        settlementMs = [];
      await Promise.all(
        jobs.map(async (job) => {
          const began = performance.now();
          job.gas = await market
            .connect(job.buyer)
            .fillIntent.estimateGas(...job.args);
          estimateMs.push(performance.now() - began);
        }),
      );
      const beforePayment = await payment.balanceOf(seller.address);
      await provider.send("evm_setAutomine", [false]);
      const began = performance.now();
      // Each buyer has a distinct nonce stream. All sends begin before awaiting any result.
      await Promise.all(
        jobs.map(async (job) => {
          job.start = performance.now();
          job.transaction = await market
            .connect(job.buyer)
            .fillIntent(...job.args, { gasLimit: job.gas * 2n });
          submitMs.push(performance.now() - job.start);
        }),
      );
      const pool = await provider.send("txpool_status", []);
      const pending = Number(BigInt(pool.pending));
      assert.equal(
        pending,
        count,
        "Every trade must be simultaneously pending before mining.",
      );
      assert.equal(
        Number(BigInt(pool.queued)),
        0,
        "Nonce gaps are not a trade concurrency pass.",
      );
      const miningStart = performance.now();
      await provider.send("evm_mine", []);
      const miningMs = performance.now() - miningStart;
      await Promise.all(
        jobs.map(async (job) => {
          const receipt = await provider.getTransactionReceipt(
            job.transaction.hash,
          );
          assert.ok(receipt, "Missing mined receipt");
          assert.equal(
            receipt.status,
            1,
            "Reverted transaction is not a settled trade.",
          );
          const settlement = receipt.logs
            .map((log) => {
              try {
                return market.interface.parseLog(log);
              } catch {
                return null;
              }
            })
            .find(
              (log) =>
                log?.name ===
                (kind === "whole" ? "SaleSettled" : "IntentFilled"),
            );
          assert.ok(settlement, "Missing settlement event");
          assert.equal(
            settlement.args.intentHash.toLowerCase(),
            job.hash.toLowerCase(),
          );
          assert.equal(
            settlement.args.buyer.toLowerCase(),
            job.buyer.address.toLowerCase(),
          );
          if (kind === "whole") {
            assert.equal(
              (await nft.ownerOf(job.i + 1)).toLowerCase(),
              job.buyer.address.toLowerCase(),
            );
            assert.equal(await whole.intentUsed(job.hash), true);
          } else {
            assert.equal(await asset.balanceOf(job.buyer.address), 10n);
            assert.equal(await fraction.intentFilled(job.hash), 10n);
          }
          assert.equal(
            await payment.balanceOf(job.buyer.address),
            kind === "whole" ? 900n : 970n,
          );
          settlementMs.push(performance.now() - job.start);
          receipts.push({
            kind,
            transactionHash: receipt.hash,
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status,
            buyer: job.buyer.address,
          });
          for (const log of receipt.logs) {
            let parsed, symbol;
            if (log.address.toLowerCase() === addresses.payment.toLowerCase()) {
              parsed = payment.interface.parseLog(log);
              symbol = "TESTUSD";
            } else if (
              log.address.toLowerCase() === addresses.asset.toLowerCase()
            ) {
              parsed = asset.interface.parseLog(log);
              symbol = "TESTFRC";
            } else if (
              log.address.toLowerCase() ===
              (await market.getAddress()).toLowerCase()
            )
              parsed = market.interface.parseLog(log);
            // The portfolio Transfer projection is ERC-20-shaped; do not mislabel an ERC-721 ID as amount.
            else continue;
            const payload = {};
            parsed.fragment.inputs.forEach((input, index) => {
              payload[input.name] = String(parsed.args[index]);
            });
            if (symbol) payload.symbol = symbol;
            events.push({
              chainId: 560048,
              transactionHash: receipt.hash,
              logIndex: log.index,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              contractAddress: log.address,
              eventName: parsed.name,
              payload,
              removed: false,
              confirmations: 1,
            });
          }
        }),
      );
      await provider.send("evm_setAutomine", [true]);
      assert.equal(
        (await payment.balanceOf(seller.address)) - beforePayment,
        BigInt(count) * (kind === "whole" ? 100n : 30n),
      );
      assert.equal(await payment.balanceOf(await market.getAddress()), 0n);
      if (kind === "fraction")
        assert.equal(await asset.balanceOf(addresses.fraction), 0n);
      const profile = {
        kind,
        requested: count,
        simultaneouslyPending: pending,
        settled: jobs.length,
        failureCount: 0,
        blockCount: new Set(
          receipts.filter((r) => r.kind === kind).map((r) => r.blockNumber),
        ).size,
        wallMs: performance.now() - began,
        miningMs,
        gasEstimate: summary(estimateMs),
        submitRPC: summary(submitMs),
        receiptAndStateVerified: summary(settlementMs),
        includesLocalMiningDelay: true,
        finalityAcceptance: false,
      };
      profile.localThresholdMet =
        pending === count &&
        jobs.length === count &&
        profile.gasEstimate.maxMs < 5000 &&
        profile.receiptAndStateVerified.maxMs < 30000;
      profiles.push(profile);
      console.log(JSON.stringify({ phase: "settlement", ...profile }));
    }
    return {
      seller,
      buyers,
      orders,
      events,
      publicResult: {
        environment: "TEST_ONLY local Anvil, no fork and no external chain",
        chainId: 560048,
        note: "560048 selects application schema only; these blocks are not public Hoodi evidence.",
        addresses,
        artifactSHA256: artifacts,
        profiles,
        receipts,
        realValue: false,
      },
    };
  } finally {
    provider.destroy();
  }
}
