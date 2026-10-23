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
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { createWholeReceiptExecutor } from "../src/lib/whole-receipt-executor";
import { createWholeReceiptChainReader, createWholeReceiptRegistrationReader } from "../src/lib/whole-receipt-chain";
import {
  createWholeReceiptTaskJournal,
  wholeReceiptTradeFromPlan,
} from "../src/lib/whole-receipt-journal";
import {
  receiptAuthorizationHash,
  receiptAuthorizationTypedData,
} from "../src/lib/whole-receipt-authorization";
import { nftTaskJournalDigest } from "../src/lib/nft/task-journal";
import type {
  WholeReceiptTaskOperation,
  WholeReceiptTaskPlan,
} from "../src/lib/whole-receipt-journal";

// Explicit local-only invocation, outside the normal unit-suite source directory.
// Anvil unlocked TEST_ONLY accounts; no key is read, exported or recorded.
it("executes funded escrow and independently guarded seller payout through actual local EVM", async () => {
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
  const localChain = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(url),
  });
  const snapshot = await localChain.snapshot();
  const [seller, buyer, third, fourth] = await wallet.getAddresses();
  expect(await rpc.getChainId()).toBe(31337);
  function artifact(file: string, name: string) {
    return JSON.parse(
      readFileSync(
        resolve("../../packages/contracts/out", file, `${name}.json`),
        "utf8",
      ),
    ) as { abi: Abi; bytecode: { object: Hex } };
  }
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
  async function deploy(file: string, name: string, args: unknown[] = []) {
    const a = artifact(file, name);
    const receipt = await send(
      seller,
      undefined,
      encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }),
    );
    if (!receipt.contractAddress) throw Error("TEST_DEPLOY_FAILED");
    return { address: receipt.contractAddress, abi: a.abi };
  }
  const policy = await deploy("WholeArtworkMarket.sol", "WholeArtworkMarket", [
    seller,
    seller,
    seller,
  ]);
  const oracle = await deploy(
    "WholeReceiptEscrow.t.sol",
    "TestOnlyReceiptOracle",
  );
  const nft = await deploy("WholeReceiptEscrow.t.sol", "TestOnlyReceiptNFT");
  const token = await deploy(
    "WholeReceiptEscrow.t.sol",
    "TestOnlyReceiptPayment",
  );
  const oracleCode = await rpc.getBytecode({ address: oracle.address });
  if (!oracleCode) throw Error("TEST_CODE_MISSING");
  const escrow = await deploy("WholeReceiptEscrow.sol", "WholeReceiptEscrow", [
    policy.address,
    oracle.address,
    keccak256(oracleCode),
  ]);
  const call = async (
    c: { address: Address; abi: Abi },
    fn: string,
    args: unknown[],
    from: Address = seller,
  ) =>
    send(
      from,
      c.address,
      encodeFunctionData({ abi: c.abi, functionName: fn, args }),
    );
  await call(policy, "setCollectionAllowed", [nft.address, true]);
  await call(policy, "setPaymentTokenAllowed", [token.address, true]);
  await call(nft, "mint", [seller, 1n]);
  await call(token, "mint", [buyer, 1000n]);
  await call(token, "approve", [escrow.address, 1000n], buyer);
  await call(nft, "setApprovalForAll", [escrow.address, true]);
  const time = Number((await rpc.getBlock()).timestamp),
    h = (v: string) => `0x${v.repeat(64)}` as Hex;
  const sale = {
    seller,
    buyer,
    collection: nft.address,
    paymentToken: token.address,
    tokenId: 1n,
    price: 100n,
    salt: 1n,
    epoch: 0n,
    startsAt: time - 1,
    endsAt: time + 3600,
  };
  const domain = { chainId: 31337 as const, verifyingContract: escrow.address };
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
  const id = receiptAuthorizationHash(sale, domain, correspondence);
  const signature = await wallet.signTypedData({
    account: seller,
    ...receiptAuthorizationTypedData(sale, domain, correspondence),
  });
  const task = {
    kind: "task" as const,
    taskId: "TEST_ONLY",
    taskDigest: h("1"),
    executorDigest: h("2"),
    grantReference: "grant:TEST_ONLY",
    grantPolicyVersion: "1",
    operationId: "TEST_ONLY_receipt_fund",
  };
  function row(
    phase: "funded" | "paid",
    terms = sale,
    binding = correspondence,
  ): WholeReceiptTaskOperation {
    const plan: WholeReceiptTaskPlan = {
      id: `TEST_ONLY_plan_${phase}_${terms.salt}`,
      operationId: `TEST_ONLY_operation_${phase}_${terms.salt}`,
      chainId: 31337,
      taskPrincipal: task,
      request: { account: terms.buyer },
      kind: "transaction",
      wholeReceipt: {
        schemaVersion: 1,
        phase,
        segmentId: receiptAuthorizationHash(terms, domain, binding),
        domain,
        correspondence: binding,
        sale: {
          ...terms,
          tokenId: terms.tokenId.toString(),
          price: terms.price.toString(),
          salt: terms.salt.toString(),
          epoch: terms.epoch.toString(),
        },
      },
    };
    return {
      id: plan.operationId,
      chainId: 31337,
      wallet: terms.buyer,
      plan,
      requestHash: nftTaskJournalDigest(plan),
      status: "awaiting-wallet",
      revision: 1,
      walletStarted: false,
      updatedAt: "2026-10-12T00:00:00Z",
    };
  }
  let stored = row("funded"),
    dispatches = 0;
  const runtime = await rpc.getBytecode({ address: escrow.address });
  if (!runtime) throw Error("TEST_CODE_MISSING");
  const chainConfig: Parameters<typeof createWholeReceiptChainReader>[0] = {
    client: {
      getChainId: () => rpc.getChainId(),
      getTransactionReceipt: (input) => rpc.getTransactionReceipt(input),
      getTransaction: (input) => rpc.getTransaction(input),
      getBlock: (input) => rpc.getBlock(input),
      getBlockNumber: () => rpc.getBlockNumber({ cacheTime: 0 }),
      getCode: (input) => rpc.getBytecode(input),
    },
    chainId: 31337,
    escrow: escrow.address,
    runtimeCodeHash: keccak256(runtime),
    confirmations: 2,
  };
  const canonical = createWholeReceiptChainReader(chainConfig);
  const registrationReader = createWholeReceiptRegistrationReader(chainConfig);
  const submissions: WholeReceiptTaskOperation[] = [];
  const executor = createWholeReceiptExecutor({
    chainId: 31337,
    escrow: escrow.address,
    runtimeCodeHash: keccak256(runtime),
    journal: {
      read: async () => structuredClone(stored),
      markWalletStarted: async () => {
        if (stored.walletStarted) throw Error("CAS_CONFLICT");
        stored.walletStarted = true;
        return structuredClone(stored);
      },
      recordSubmission: async (_task, _row, hash) => {
        stored.transactionHash = hash;
        stored.status = "pending";
        submissions.push(structuredClone(stored));
        return structuredClone(stored);
      },
    },
    authorize: async (_task, _plan, action) =>
      action({ expiresAtMs: Date.now() + 60000 }),
    chain: {
      getChainId: () => rpc.getChainId(),
      getCode: async (address) => (await rpc.getBytecode({ address })) ?? "0x",
      simulate: async (request) => {
        await rpc.call(request);
      },
    },
    wallet: {
      identity: async () => ({
        account: stored.plan.request.account as Address,
        chainId: 31337,
      }),
      sendTransaction: async (request) => {
        dispatches++;
        return wallet.sendTransaction({
          ...request,
          account: request.account,
          chain: foundry,
        });
      },
    },
  });
  await executor.execute(task, stored.id, signature);
  if (!stored.transactionHash) throw Error("TEST_HASH_MISSING");
  await rpc.waitForTransactionReceipt({ hash: stored.transactionHash as Hex });
  expect(
    await rpc.readContract({ ...nft, functionName: "ownerOf", args: [1n] }),
  ).toBe(buyer);
  const balance = (account: Address) =>
    rpc.readContract({ ...token, functionName: "balanceOf", args: [account] });
  expect(await balance(seller)).toBe(0n);
  expect(await balance(buyer)).toBe(900n);
  expect(await balance(escrow.address)).toBe(100n);
  await expect(executor.execute(task, stored.id, signature)).rejects.toThrow(
    "RECOVER_EXISTING",
  );
  expect(dispatches).toBe(1);
  // Continue ownership before any registration or payout. Each buyer funds only
  // their own segment; the synthetic journal below is not durable-auth evidence.
  const later: {
    terms: typeof sale;
    binding: typeof correspondence;
    id: Hex;
  }[] = [];
  let previous = id;
  for (const [from, to, price, salt] of [
    [buyer, third, 200n, 2n],
    [third, fourth, 300n, 3n],
  ] as const) {
    await call(token, "mint", [to, 1000n]);
    await call(token, "approve", [escrow.address, 1000n], to);
    await call(nft, "setApprovalForAll", [escrow.address, true], from);
    const terms = { ...sale, seller: from, buyer: to, price, salt };
    const commitment = (name: string) =>
      keccak256(stringToHex(`TEST_ONLY_${salt}_${name}`));
    const binding = {
      ...correspondence,
      settlementId: commitment("settlement"),
      requestHash: commitment("request"),
      executionReferenceHash: commitment("execution"),
      previousSegment: previous,
      oldCertificateHash: commitment("old-certificate"),
    };
    const segmentId = receiptAuthorizationHash(terms, domain, binding);
    stored = row("funded", terms, binding);
    const signed = await wallet.signTypedData({
      account: from,
      ...receiptAuthorizationTypedData(terms, domain, binding),
    });
    await executor.execute(task, stored.id, signed);
    if (!stored.transactionHash) throw Error("TEST_HASH_MISSING");
    expect(
      (
        await rpc.waitForTransactionReceipt({
          hash: stored.transactionHash as Hex,
        })
      ).status,
    ).toBe("success");
    await expect(executor.execute(task, stored.id, signed)).rejects.toThrow(
      "RECOVER_EXISTING",
    );
    later.push({ terms, binding, id: segmentId });
    previous = segmentId;
  }
  expect(
    await rpc.readContract({ ...nft, functionName: "ownerOf", args: [1n] }),
  ).toBe(fourth);
  expect(await balance(escrow.address)).toBe(600n);
  expect(await balance(buyer)).toBe(900n);
  expect(await balance(third)).toBe(800n);
  expect(await balance(fourth)).toBe(700n);
  expect(dispatches).toBe(3);
  stored = row("paid");
  await expect(executor.execute(task, stored.id)).rejects.toThrow();
  expect(stored.walletStarted).toBe(false);
  expect(dispatches).toBe(3);
  const proof = "0x1234" as Hex;
  const registrations: {plan: WholeReceiptTaskPlan; hash: Hex; record: Hex}[] = [];
  await call(oracle, "allow", [id, proof, h("8")]);
  const firstRegistration = await call(escrow, "confirmRegistration", [id, proof]);
  registrations.push({plan:row("funded").plan,hash:firstRegistration.transactionHash,record:h("8")});
  await executor.execute(task, stored.id);
  if (!stored.transactionHash) throw Error("TEST_HASH_MISSING");
  await rpc.waitForTransactionReceipt({ hash: stored.transactionHash as Hex });
  expect(await balance(seller)).toBe(100n);
  expect(await balance(escrow.address)).toBe(500n);
  expect(dispatches).toBe(4);
  await expect(executor.execute(task, stored.id)).rejects.toThrow(
    "RECOVER_EXISTING",
  );
  expect(dispatches).toBe(4);
  // Historical registrations remain valid with D holding the NFT. Confirm in
  // chain order, then pay the newest seller before the middle seller.
  for (const segment of later) {
    await call(oracle, "allow", [
      segment.id,
      proof,
      keccak256(stringToHex(`TEST_ONLY_record_${segment.terms.salt}`)),
    ]);
    const confirmed = await call(escrow, "confirmRegistration", [segment.id, proof]);
    registrations.push({plan:row("funded",segment.terms,segment.binding).plan,hash:confirmed.transactionHash,record:keccak256(stringToHex(`TEST_ONLY_record_${segment.terms.salt}`))});
  }
  for (const segment of [...later].reverse()) {
    stored = row("paid", segment.terms, segment.binding);
    await executor.execute(task, stored.id);
    if (!stored.transactionHash) throw Error("TEST_HASH_MISSING");
    expect(
      (
        await rpc.waitForTransactionReceipt({
          hash: stored.transactionHash as Hex,
        })
      ).status,
    ).toBe("success");
    await expect(executor.execute(task, stored.id)).rejects.toThrow(
      "RECOVER_EXISTING",
    );
  }
  expect(await balance(seller)).toBe(100n);
  expect(await balance(buyer)).toBe(1100n);
  expect(await balance(third)).toBe(1100n);
  expect(await balance(fourth)).toBe(700n);
  expect(await balance(escrow.address)).toBe(0n);
  expect(
    await rpc.readContract({ ...nft, functionName: "ownerOf", args: [1n] }),
  ).toBe(fourth);
  expect(dispatches).toBe(6);
  // The last payment has only one confirmation and must not yet be evidence.
  const last = submissions.at(-1)!;
  await expect(
    canonical(
      last.plan.wholeReceipt.phase,
      wholeReceiptTradeFromPlan(last.plan),
      last.transactionHash as Hex,
    ),
  ).rejects.toThrow("RECEIPT_CHAIN_EVIDENCE_INVALID");
  await localChain.mine({ blocks: 2 });
  expect(registrations).toHaveLength(3);
  for(const registration of registrations) {
    const observed=await registrationReader(wholeReceiptTradeFromPlan(registration.plan),registration.hash);
    expect(observed.segmentId).toBe(registration.plan.wholeReceipt.segmentId);
    expect(observed.recordHash).toBe(registration.record);
    expect(observed.oracleEvidenceAuthenticated).toBe(false);
    expect(await registrationReader(wholeReceiptTradeFromPlan(registration.plan),registration.hash)).toEqual(observed);
  }
  await expect(registrationReader(wholeReceiptTradeFromPlan(registrations[1].plan),registrations[0].hash)).rejects.toThrow("RECEIPT_CHAIN_EVIDENCE_INVALID");
  expect(submissions).toHaveLength(6);
  for (const submission of submissions) {
    await expect(
      canonical(
        submission.plan.wholeReceipt.phase,
        wholeReceiptTradeFromPlan(submission.plan),
        submission.transactionHash as Hex,
      ),
    ).resolves.toBeDefined();
  }
  // Exercise the production journal recovery composition against actual chain
  // evidence. Only its transport/store and grant remain synthetic, not MySQL/mTLS.
  let recoveryRow: WholeReceiptTaskOperation = {
    ...structuredClone(last),
    status: "awaiting-wallet",
    transactionHash: undefined,
  };
  let recoveryWrites = 0;
  const recoveryJournal = createWholeReceiptTaskJournal({
    url: "https://journal.invalid/internal/v1/nft/operations",
    peerId: "spiffe://TEST_ONLY/journal",
    withCapability: async (scope, dispatch) => {
      expect(scope.principal).toEqual(task);
      return dispatch("TEST_ONLY_opaque_capability_not_a_credential");
    },
    transport: async (_url, init) => {
      const { action, operation } = JSON.parse(String(init.body));
      if (operation.id !== recoveryRow.id)
        return new Response(null, { status: 404 });
      if (action === "update") {
        if (
          operation.revision !== recoveryRow.revision ||
          nftTaskJournalDigest(operation.plan) !==
            nftTaskJournalDigest(recoveryRow.plan)
        )
          return new Response(null, { status: 409 });
        recoveryWrites++;
        recoveryRow = { ...operation, revision: recoveryRow.revision + 1 };
      } else if (action !== "get") return new Response(null, { status: 405 });
      return Response.json(recoveryRow);
    },
  });
  await expect(
    recoveryJournal.recoverSubmission(
      task,
      last.id,
      submissions[0].transactionHash as Hex,
      canonical,
    ),
  ).rejects.toThrow();
  expect(recoveryWrites).toBe(0);
  expect(recoveryRow.transactionHash).toBeUndefined();
  const recovered = await recoveryJournal.recoverSubmission(
    task,
    last.id,
    last.transactionHash as Hex,
    canonical,
  );
  expect(recovered.operation.status).toBe("confirmed");
  expect(recoveryWrites).toBe(2);
  await recoveryJournal.recoverSubmission(
    task,
    last.id,
    last.transactionHash as Hex,
    canonical,
  );
  expect(recoveryWrites).toBe(2);
  expect(dispatches).toBe(6);
  // Actual chain rollback removes the accepted receipts. A saved journal hash
  // cannot remain authoritative and must never trigger an automatic resend.
  await localChain.revert({ id: snapshot });
  for(const registration of registrations) {
    await expect(registrationReader(wholeReceiptTradeFromPlan(registration.plan),registration.hash)).rejects.toThrow();
  }
  await expect(
    recoveryJournal.recoverSubmission(
      task,
      last.id,
      last.transactionHash as Hex,
      canonical,
    ),
  ).rejects.toThrow();
  expect(recoveryWrites).toBe(2);
  for (const submission of submissions) {
    await expect(
      canonical(
        submission.plan.wholeReceipt.phase,
        wholeReceiptTradeFromPlan(submission.plan),
        submission.transactionHash as Hex,
      ),
    ).rejects.toThrow();
  }
  expect(dispatches).toBe(6);
}, 90000);
