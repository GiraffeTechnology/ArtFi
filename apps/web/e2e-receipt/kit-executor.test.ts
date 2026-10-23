import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { createWholeReceiptExecutor } from "../src/lib/whole-receipt-executor";
import {
  createWholeReceiptTaskJournal,
  type WholeReceiptTaskPlan,
  type WholeReceiptTaskOperation,
} from "../src/lib/whole-receipt-journal";
import { createWholeReceiptRegistrationReader } from "../src/lib/whole-receipt-chain";
import {
  receiptAuthorizationHash,
  receiptAuthorizationTypedData,
} from "../src/lib/whole-receipt-authorization";
import { nftTaskJournalDigest } from "../src/lib/nft/task-journal";

// TEST_ONLY_NO_REAL_VALUE. Real Kit/escrow/RPC; synthetic unlocked Anvil accounts,
// task grant and transport store. Not genuine-wallet or mTLS/MySQL acceptance.
it.each([false, true])(
  "dispatches exact Kit registration and handles mid-recovery reorg=%s",
  async (reorgDuringRecovery) => {
    const url = process.env.ARTFI_RECEIPT_LOCAL_EVM_TEST_URL;
    if (url !== "http://127.0.0.1:38547")
      throw Error("ISOLATED_LOCAL_EVM_REQUIRED");
    const rpc = createPublicClient({
      chain: foundry,
      transport: http(url, { retryCount: 0 }),
    });
    const wallet = createWalletClient({
      chain: foundry,
      transport: http(url, { retryCount: 0 }),
    });
    const local = createTestClient({
      chain: foundry,
      mode: "anvil",
      transport: http(url),
    });
    expect(await rpc.getChainId()).toBe(31337);
    const snapshot = await local.snapshot();
    try {
      const [seller, buyer, , , attestor] = await wallet.getAddresses();
      const h = (x: string) => `0x${x.repeat(64)}` as Hex;
      type Contract = { address: Address; abi: Abi };
      async function send(from: Address, to: Address | undefined, data: Hex) {
        const hash = await wallet.sendTransaction({
          account: from,
          to,
          data,
          value: 0n,
        });
        const receipt = await rpc.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe("success");
        return receipt;
      }
      async function deploy(
        file: string,
        name: string,
        args: unknown[] = [],
      ): Promise<Contract> {
        const artifact = JSON.parse(
          readFileSync(
            resolve("../../packages/contracts/out", file, `${name}.json`),
            "utf8",
          ),
        ) as { abi: Abi; bytecode: { object: Hex } };
        const receipt = await send(
          seller,
          undefined,
          encodeDeployData({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
          }),
        );
        if (!receipt.contractAddress) throw Error("TEST_DEPLOY_MISSING");
        return { address: receipt.contractAddress, abi: artifact.abi };
      }
      const call = (
        c: Contract,
        fn: string,
        args: unknown[],
        from: Address = seller,
      ) =>
        send(
          from,
          c.address,
          encodeFunctionData({ abi: c.abi, functionName: fn, args }),
        );
      const read = (c: Contract, fn: string, args: unknown[] = []) =>
        rpc.readContract({ ...c, functionName: fn, args });
      const codeHash = async (c: Contract) => {
        const code = await rpc.getBytecode({ address: c.address });
        if (!code) throw Error("TEST_CODE_MISSING");
        return keccak256(code);
      };
      const proofVerifier = await deploy(
        "AttestationProofVerifier.sol",
        "AttestationProofVerifier",
        [h("1"), attestor],
      );
      const predictedSettlement = getContractAddress({
        from: seller,
        nonce: BigInt(await rpc.getTransactionCount({ address: seller })) + 1n,
      });
      const projection = await deploy(
        "RegisterProjection.sol",
        "RegisterProjection",
        [h("2"), predictedSettlement],
      );
      const settlement = await deploy(
        "ProjectionSettlement.sol",
        "ProjectionSettlement",
        [projection.address, proofVerifier.address, 3600, [seller]],
      );
      expect(settlement.address.toLowerCase()).toBe(
        predictedSettlement.toLowerCase(),
      );
      const policy = await deploy(
        "WholeArtworkMarket.sol",
        "WholeArtworkMarket",
        [seller, seller, seller],
      );
      const nft = await deploy(
        "WholeReceiptEscrow.t.sol",
        "TestOnlyReceiptNFT",
      );
      const payment = await deploy(
        "WholeReceiptEscrow.t.sol",
        "TestOnlyReceiptPayment",
      );
      const predictedEscrow = getContractAddress({
        from: seller,
        nonce: BigInt(await rpc.getTransactionCount({ address: seller })) + 1n,
      });
      const adapter = await deploy(
        "WholeReceiptKitVerifier.sol",
        "WholeReceiptKitVerifier",
        [
          [
            predictedEscrow,
            nft.address,
            settlement.address,
            projection.address,
            proofVerifier.address,
            seller,
            h("3"),
            h("2"),
            h("1"),
            await codeHash(settlement),
            await codeHash(projection),
            await codeHash(proofVerifier),
          ],
        ],
      );
      const escrow = await deploy(
        "WholeReceiptEscrow.sol",
        "WholeReceiptEscrow",
        [policy.address, adapter.address, await codeHash(adapter)],
      );
      expect(escrow.address.toLowerCase()).toBe(predictedEscrow.toLowerCase());
      await call(policy, "setCollectionAllowed", [nft.address, true]);
      await call(policy, "setPaymentTokenAllowed", [payment.address, true]);
      await call(nft, "mint", [seller, 7n]);
      await call(nft, "setApprovalForAll", [escrow.address, true]);
      await call(payment, "mint", [buyer, 1000n]);
      await call(payment, "approve", [escrow.address, 1000n], buyer);
      const now = Number((await rpc.getBlock()).timestamp);
      const sale = {
        seller,
        buyer,
        collection: nft.address,
        paymentToken: payment.address,
        tokenId: 7n,
        price: 100n,
        salt: 1n,
        epoch: 0n,
        startsAt: now - 1,
        endsAt: now + 3600,
      };
      const domain = {
        chainId: 31337 as const,
        verifyingContract: escrow.address,
      };
      const correspondence = {
        settlementId: h("1"),
        assetRecordHash: h("2"),
        oracleSourceId: h("3"),
        requestHash: h("4"),
        executionReferenceHash: h("5"),
        previousSegment: h("0"),
        oldCertificateHash: h("6"),
        warehouseReceiptHash: h("7"),
      };
      const segment = receiptAuthorizationHash(sale, domain, correspondence);
      const genesis = await read(settlement, "initializationBinding", [
        7n,
        h("a"),
        h("b"),
        seller,
        1,
      ]);
      await call(settlement, "initializeRegister", [
        7n,
        h("a"),
        h("b"),
        seller,
        1,
        await wallet.signMessage({
          account: attestor,
          message: { raw: genesis as Hex },
        }),
      ]);
      const task = {
        kind: "task" as const,
        taskId: "TEST_ONLY",
        taskDigest: h("1"),
        executorDigest: h("2"),
        grantReference: "grant:TEST_ONLY",
        grantPolicyVersion: "1",
        operationId: "TEST_ONLY_operation",
      };
      const rows = new Map<string, WholeReceiptTaskOperation>();
      const config = {
        url: "https://journal.invalid/internal/v1/nft/operations",
        peerId: "spiffe://TEST_ONLY/journal",
        async withCapability<T>(
          _scope: unknown,
          dispatch: (capability: string) => Promise<T>,
        ) {
          return dispatch("TEST_ONLY_NO_REAL_VALUE_NOT_A_CREDENTIAL");
        },
        async transport(_url: string, init: RequestInit) {
          const { action, operation } = JSON.parse(String(init.body));
          const existing = rows.get(operation.id);
          if (action === "get")
            return existing
              ? Response.json(existing)
              : new Response(null, { status: 404 });
          if (action === "create") {
            if (
              existing &&
              nftTaskJournalDigest(existing.plan) !==
                nftTaskJournalDigest(operation.plan)
            )
              return new Response(null, { status: 409 });
            rows.set(
              operation.id,
              existing ?? {
                ...operation,
                revision: 1,
                updatedAt: "2026-10-13T00:00:00Z",
              },
            );
          } else {
            if (
              !existing ||
              operation.revision !== existing.revision ||
              nftTaskJournalDigest(existing.plan) !==
                nftTaskJournalDigest(operation.plan)
            )
              return new Response(null, { status: 409 });
            rows.set(operation.id, {
              ...operation,
              revision: existing.revision + 1,
              updatedAt: "2026-10-13T00:01:00Z",
            });
          }
          return Response.json(rows.get(operation.id));
        },
      };
      const journal = createWholeReceiptTaskJournal(config);
      let dispatches = 0,
        loseRegistrationResult = false,
        registrationHash: Hex | undefined;
      const runtimeCodeHash = await codeHash(escrow);
      const executor = createWholeReceiptExecutor({
        journal,
        escrow: escrow.address,
        chainId: 31337,
        runtimeCodeHash,
        async authorize(_task, _plan, action) {
          return action({ expiresAtMs: Date.now() + 60000 });
        },
        wallet: {
          async identity() {
            return { account: buyer, chainId: 31337 };
          },
          async sendTransaction(request) {
            dispatches++;
            const hash = await wallet.sendTransaction({
              ...request,
              chain: foundry,
            });
            if (loseRegistrationResult) {
              registrationHash = hash;
              throw Error("TEST_ONLY_RESPONSE_LOST");
            }
            return hash;
          },
        },
        chain: {
          getChainId: () => rpc.getChainId(),
          getCode: async (address) =>
            (await rpc.getBytecode({ address })) ?? "0x",
          simulate: async (request) => {
            await rpc.call(request);
          },
        },
      });
      function plan(
        phase: WholeReceiptTaskPlan["wholeReceipt"]["phase"],
        proof?: Hex,
      ): WholeReceiptTaskPlan {
        return {
          id: `TEST_ONLY_plan_${phase}`,
          operationId: `TEST_ONLY_operation_${phase}`,
          chainId: 31337,
          taskPrincipal: task,
          kind: "transaction",
          request: { account: buyer },
          wholeReceipt: {
            schemaVersion: 1,
            phase,
            segmentId: segment,
            domain,
            correspondence,
            sale: {
              ...sale,
              tokenId: "7",
              price: "100",
              salt: "1",
              epoch: "0",
            },
            ...(proof
              ? {
                  kitRegistration: {
                    version: "2",
                    proofHash: keccak256(proof),
                  },
                }
              : {}),
          },
        };
      }
      const fund = await journal.create(task, plan("funded"));
      await executor.execute(
        task,
        fund.id,
        await wallet.signTypedData({
          account: seller,
          ...receiptAuthorizationTypedData(sale, domain, correspondence),
        }),
      );
      const fundHash = rows.get(fund.id)!.transactionHash as Hex;
      await rpc.waitForTransactionReceipt({ hash: fundHash });
      expect(await read(nft, "ownerOf", [7n])).toBe(buyer);
      await call(settlement, "beginSettlement", [
        7n,
        correspondence.settlementId,
        buyer,
        segment,
        now + 3500,
      ]);
      const digest = await read(settlement, "admissionBinding", [
        correspondence.settlementId,
        h("c"),
        h("d"),
        now,
      ]);
      const proof = await wallet.signMessage({
        account: attestor,
        message: { raw: digest as Hex },
      });
      await call(settlement, "finalizeSettlement", [
        correspondence.settlementId,
        h("c"),
        h("d"),
        now,
        proof,
      ]);
      const registered = await journal.create(task, plan("registered", proof));
      const wrongSegment = structuredClone(plan("registered", proof));
      wrongSegment.wholeReceipt.segmentId = h("e");
      await expect(journal.create(task, wrongSegment)).rejects.toThrow();
      const wrongDeployment = structuredClone(plan("registered", proof));
      wrongDeployment.wholeReceipt.domain.verifyingContract = nft.address;
      await expect(journal.create(task, wrongDeployment)).rejects.toThrow();
      await expect(
        executor.execute(task, registered.id, undefined, {
          version: 2n,
          proof: "0x1234",
        }),
      ).rejects.toThrow();
      expect(dispatches).toBe(1);
      const beforeRegistration = await local.snapshot();
      loseRegistrationResult = true;
      await expect(
        executor.execute(task, registered.id, undefined, {
          version: 2n,
          proof,
        }),
      ).rejects.toThrow("OUTCOME_UNKNOWN");
      if (!registrationHash) throw Error("TEST_REGISTRATION_HASH_MISSING");
      await rpc.waitForTransactionReceipt({ hash: registrationHash });
      await expect(
        executor.execute(task, registered.id, undefined, {
          version: 2n,
          proof,
        }),
      ).rejects.toThrow("RECOVER_EXISTING");
      expect(dispatches).toBe(2);
      await local.mine({ blocks: 2 });
      const reader = createWholeReceiptRegistrationReader({
        chainId: 31337,
        escrow: escrow.address,
        runtimeCodeHash,
        confirmations: 2,
        client: {
          getChainId: () => rpc.getChainId(),
          getTransactionReceipt: (input) => rpc.getTransactionReceipt(input),
          getTransaction: (input) => rpc.getTransaction(input),
          getBlock: (input) => rpc.getBlock(input),
          getBlockNumber: () => rpc.getBlockNumber({ cacheTime: 0 }),
          getCode: (input) => rpc.getBytecode(input),
        },
      });
      if (reorgDuringRecovery) {
        let observations = 0;
        const reorgReader: typeof reader = async (...args) => {
          observations++;
          const observation = await reader(...args);
          if (observations === 1)
            await local.revert({ id: beforeRegistration });
          return observation;
        };
        await expect(
          createWholeReceiptTaskJournal(config).reconcileRegistration(
            task,
            registered.id,
            reorgReader,
            registrationHash,
          ),
        ).rejects.toThrow();
        expect(observations).toBe(2);
        const pending = await createWholeReceiptTaskJournal(config).read(
          task,
          registered.id,
        );
        expect(pending.status).toBe("pending");
        expect(pending.transactionHash).toBe(registrationHash);
        expect(pending.walletStarted).toBe(true);
        await expect(
          executor.execute(task, registered.id, undefined, {
            version: 2n,
            proof,
          }),
        ).rejects.toThrow("RECOVER_EXISTING");
        expect(dispatches).toBe(2);
        expect(await read(payment, "balanceOf", [seller])).toBe(0n);
        expect(await read(payment, "balanceOf", [escrow.address])).toBe(100n);
        expect(await read(nft, "ownerOf", [7n])).toBe(buyer);
        return;
      }
      const recovered = await createWholeReceiptTaskJournal(
        config,
      ).reconcileRegistration(task, registered.id, reader, registrationHash);
      expect(recovered.operation.status).toBe("confirmed");
      expect(recovered.observation.recordHash).toBe(h("c"));
      expect(recovered.observation.oracleEvidenceAuthenticated).toBe(false);
      expect(JSON.stringify(rows.get(registered.id))).not.toContain(proof);
      expect(await read(nft, "ownerOf", [7n])).toBe(buyer);
      expect(await read(payment, "balanceOf", [seller])).toBe(0n);
      expect(await read(payment, "balanceOf", [escrow.address])).toBe(100n);
      loseRegistrationResult = false;
      const paid = await journal.create(task, plan("paid"));
      await executor.execute(task, paid.id);
      await rpc.waitForTransactionReceipt({
        hash: rows.get(paid.id)!.transactionHash as Hex,
      });
      expect(await read(payment, "balanceOf", [seller])).toBe(100n);
      expect(await read(payment, "balanceOf", [buyer])).toBe(900n);
      expect(await read(payment, "balanceOf", [escrow.address])).toBe(0n);
      expect(dispatches).toBe(3);
      await expect(executor.execute(task, paid.id)).rejects.toThrow(
        "RECOVER_EXISTING",
      );
      // A confirmed journal marker is not a substitute for fresh canonical evidence.
      await local.revert({ id: beforeRegistration });
      await expect(
        createWholeReceiptTaskJournal(config).reconcileRegistration(
          task,
          registered.id,
          reader,
          registrationHash,
        ),
      ).rejects.toThrow();
      await expect(
        executor.execute(task, registered.id, undefined, {
          version: 2n,
          proof,
        }),
      ).rejects.toThrow("RECOVER_EXISTING");
      expect(dispatches).toBe(3);
      expect(await read(payment, "balanceOf", [seller])).toBe(0n);
      expect(await read(payment, "balanceOf", [escrow.address])).toBe(100n);
      expect(await read(nft, "ownerOf", [7n])).toBe(buyer);
    } finally {
      await local.revert({ id: snapshot });
    }
  },
  60000,
);
