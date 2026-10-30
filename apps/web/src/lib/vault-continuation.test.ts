import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  artFiVaultAbi,
  erc721VaultApprovalAbi,
  vaultFactoryAbi,
} from "./contracts";
import { setupRecoverySession, type SetupRecord } from "./setup-recovery";
import { isVaultSetup, type VaultSetup } from "./vault-setup";
import {
  archiveCompletedVault,
  assertVaultParticipantsReady,
  listVaultContinuations,
  markVaultContinuationLogged,
  readVaultContinuation,
  reviewVaultContinuation,
  saveVaultContinuation,
} from "./vault-continuation";
import {
  createSetupChainFixture,
  setupAddresses as a,
  setupRequestIds,
} from "../test/setup-chain-fixture";

const creator = a.wallet;
const fractionalizer = a.otherWallet;
const outsider = "0x1000000000000000000000000000000000000040" as Address;
const canonical = `0x${"71".repeat(32)}` as Hex;
const configuration = {
  collectionAddress: a.collection,
  tokenId: "1",
  vaultName: "TEST_ONLY Role Vault",
  adminAddress: creator,
  pauserAddress: creator,
  fractionalizerAddress: fractionalizer,
  tokenName: "TEST_ONLY Role Fractions",
  tokenSymbol: "ROLE",
  tokenSupply: String(100n * 10n ** 18n),
  recipient: creator,
};
const deposited: VaultSetup = {
  chainId: 560048,
  walletAddress: creator,
  depositorAddress: creator,
  factoryAddress: a.factory,
  configuration,
  idempotencyKey: "TEST-ONLY-vault-recovery",
  intent: {
    intentId: "TEST-ONLY-role-intent",
    requestId: setupRequestIds.vault,
    factoryAddress: a.factory,
    chainId: 560048,
    ...configuration,
  },
  stage: "deposited",
  vaultAddress: a.vault,
  creationHash: canonical,
  submissionPending: true,
};
function store() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
  };
}
function saveJournal(
  storage: ReturnType<typeof store>,
  data: VaultSetup,
  pending?: SetupRecord<VaultSetup>["pending"],
) {
  const record = { id: "source-record", data, pending };
  storage.setItem(
    `artfi:setup:vault:560048:${data.walletAddress.toLowerCase()}`,
    JSON.stringify({ version: 1, ...record }),
  );
  return record;
}
async function depositedFixture() {
  const chain = createSetupChainFixture();
  const targets: string[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_call")
          targets.push(
            String((params as [{ to: string }])[0].to).toLowerCase(),
          );
        const reply = chain.rpc({ id: 1, method, params });
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
      },
    }),
  });
  const create = chain.submit({
    from: creator,
    to: a.factory,
    data: encodeFunctionData({
      abi: vaultFactoryAbi,
      functionName: "createVault",
      args: [
        setupRequestIds.vault,
        configuration.vaultName,
        a.collection,
        1n,
        creator,
        creator,
        fractionalizer,
      ],
    }),
  });
  await client.getTransactionReceipt({ hash: create });
  const approve = chain.submit({
    from: creator,
    to: a.collection,
    data: encodeFunctionData({
      abi: erc721VaultApprovalAbi,
      functionName: "approve",
      args: [a.vault, 1n],
    }),
  });
  await client.getTransactionReceipt({ hash: approve });
  const deposit = chain.submit({
    from: creator,
    to: a.vault,
    data: encodeFunctionData({ abi: artFiVaultAbi, functionName: "deposit" }),
  });
  await client.getTransactionReceipt({ hash: deposit });
  return { chain, client, targets };
}

describe("explicit confirmed Vault continuation", () => {
  it("lets the configured B fractionalizer continue without registrar rights and preserves A as depositor", async () => {
    const { chain, client, targets } = await depositedFixture();
    const storage = store();
    const source = saveJournal(storage, deposited);
    const saved = saveVaultContinuation(storage, source);
    const roleAbi = parseAbi([
      "function hasRole(bytes32,address) view returns (bool)",
    ]);
    expect(
      await client.readContract({
        abi: roleAbi,
        address: a.registry,
        functionName: "hasRole",
        args: [
          keccak256(new TextEncoder().encode("REGISTRAR_ROLE")),
          fractionalizer,
        ],
      }),
    ).toBe(false);
    targets.length = 0;
    assertVaultParticipantsReady(storage, deposited, fractionalizer);
    const reviewed = await reviewVaultContinuation(
      client,
      saved,
      fractionalizer,
    );
    assertVaultParticipantsReady(storage, deposited, fractionalizer);
    expect(reviewed.walletAddress).toBe(fractionalizer);
    expect(reviewed.depositorAddress).toBe(creator);
    expect(reviewed.configuration).toEqual(configuration);
    expect(targets).not.toContain(a.registry.toLowerCase());
    const imported = saveJournal(storage, reviewed);
    saveVaultContinuation(storage, imported);
    expect(
      JSON.parse(storage.getItem(`artfi:setup:vault:560048:${creator}`)!).data
        .walletAddress,
    ).toBe(creator);
    const hash = chain.submit({
      from: fractionalizer,
      to: a.vault,
      data: encodeFunctionData({
        abi: artFiVaultAbi,
        functionName: "fractionalize",
        args: [
          configuration.tokenName,
          configuration.tokenSymbol,
          BigInt(configuration.tokenSupply),
          creator,
        ],
      }),
    });
    expect((await client.getTransactionReceipt({ hash })).status).toBe(
      "success",
    );
    expect(chain.state.transactions.at(-1)?.from).toBe(fractionalizer);
  });

  it("rejects an unauthorized C before creating an issuance request", async () => {
    const { chain, client } = await depositedFixture();
    const storage = store();
    const saved = saveVaultContinuation(
      storage,
      saveJournal(storage, deposited),
    );
    const before = chain.state.transactions.length;
    await expect(
      reviewVaultContinuation(client, saved, outsider),
    ).rejects.toThrow("FRACTIONALIZER_ROLE");
    expect(chain.state.transactions).toHaveLength(before);
    expect(storage.getItem(`artfi:setup:vault:560048:${outsider}`)).toBeNull();
  });

  it("archives completed identity and unfinished logging before another NFT replaces the wallet's active setup", () => {
    const storage = store();
    const completed = {
      ...deposited,
      stage: "complete" as const,
      fractionToken: a.fraction,
    };
    archiveCompletedVault(
      storage,
      saveJournal(storage, completed),
      false,
      false,
    );
    const another: VaultSetup = {
      ...deposited,
      stage: "configure",
      vaultAddress: undefined,
      intent: undefined,
      creationHash: undefined,
      configuration: { ...configuration, tokenId: "2" },
      idempotencyKey: "TEST-ONLY-second-vault",
    };
    saveJournal(storage, another);
    const [saved] = listVaultContinuations(storage);
    expect(saved.data.configuration.tokenId).toBe("1");
    expect(saved.data.fractionToken).toBe(a.fraction);
    expect(saved.data.intent?.intentId).toBe(deposited.intent!.intentId);
    expect(saved.data.creationHash).toBe(canonical);
    expect(saved.data.submissionPending).toBe(true);
    markVaultContinuationLogged(storage, saved);
    expect(
      readVaultContinuation(storage, completed)?.data.submissionPending,
    ).toBe(false);
    expect(
      JSON.parse(storage.getItem(`artfi:setup:vault:560048:${creator}`)!).data
        .configuration.tokenId,
    ).toBe("2");
  });

  it.each(["pending", "no-hash", "busy", "blocked", "unfinished"])(
    "cannot prepare another Vault by clearing %s work",
    (condition) => {
      const storage = store();
      const record = saveJournal(
        storage,
        {
          ...deposited,
          stage: condition === "unfinished" ? "deposited" : "complete",
          fractionToken: a.fraction,
        },
        condition === "pending" || condition === "no-hash"
          ? {
              id: "still-unresolved",
              step: "fractionalize",
              ...(condition === "pending" ? { hash: canonical } : {}),
            }
          : undefined,
      );
      expect(() =>
        archiveCompletedVault(
          storage,
          record,
          condition === "busy",
          condition === "blocked",
        ),
      ).toThrow("Finish or resolve");
      expect(storage.getItem(`artfi:setup:vault:560048:${creator}`)).toContain(
        "source-record",
      );
    },
  );

  it("does not let an older logging result replace a newer complete archive", () => {
    const storage = store();
    const old = saveVaultContinuation(storage, saveJournal(storage, deposited));
    const completed = {
      ...deposited,
      walletAddress: fractionalizer,
      stage: "complete" as const,
      fractionToken: a.fraction,
    };
    saveVaultContinuation(storage, saveJournal(storage, completed));
    saveVaultContinuation(storage, {
      id: "old-log",
      data: { ...deposited, submissionPending: false },
    });
    markVaultContinuationLogged(storage, old);
    const latest = readVaultContinuation(storage, deposited)!;
    expect(latest.data.stage).toBe("complete");
    expect(latest.data.fractionToken).toBe(a.fraction);
    expect(latest.participants).toEqual([creator, fractionalizer]);
  });

  it("checks fresh disk pending markers and refuses missing source journals", () => {
    const storage = store();
    saveVaultContinuation(storage, saveJournal(storage, deposited));
    expect(() =>
      assertVaultParticipantsReady(storage, deposited, fractionalizer),
    ).not.toThrow();
    saveJournal(storage, deposited, {
      id: "late-request",
      step: "fractionalize",
    });
    expect(() =>
      assertVaultParticipantsReady(storage, deposited, fractionalizer),
    ).toThrow("unresolved operation");
    storage.values.delete(`artfi:setup:vault:560048:${creator}`);
    expect(() =>
      assertVaultParticipantsReady(storage, deposited, fractionalizer),
    ).toThrow("Missing data does not cancel");
  });

  it("reads original-wallet live uncertainty even when its hash could not reach disk", () => {
    const storage = store();
    const liveWallet = "0x1000000000000000000000000000000000000050" as Address;
    const data = {
      ...deposited,
      walletAddress: liveWallet,
      depositorAddress: liveWallet,
    };
    const session = setupRecoverySession(
      `vault:560048:${liveWallet}`,
      isVaultSetup,
    );
    session.restore(() => storage);
    const lease = session.begin()!;
    session.save(lease, data);
    saveVaultContinuation(storage, session.getSnapshot().record!);
    session.awaitWallet(lease, "fractionalize");
    const write = storage.setItem;
    storage.setItem = () => {
      throw new Error("quota");
    };
    session.broadcast(lease, canonical);
    session.finish(lease);
    storage.setItem = write;
    expect(() =>
      assertVaultParticipantsReady(storage, data, fractionalizer),
    ).toThrow("unresolved operation");
    expect(session.getSnapshot().record?.pending?.hash).toBe(canonical);
  });
});
