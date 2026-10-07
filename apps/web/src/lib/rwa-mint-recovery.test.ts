import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
import { currentOperation } from "./current-operation";
import { createSetupRecoverySession } from "./setup-recovery";
import {
  assertMintIntent,
  isMintRecovery,
  mintedDaoHref,
  prepareMint,
  recoverMintedAsset,
  type MintDraft,
  type MintIntent,
  type MintRecovery,
} from "./rwa-mint-recovery";
const wallet = "0x1000000000000000000000000000000000000010" as const;
const registry = "0x1000000000000000000000000000000000000001" as const;
const collection = "0x1000000000000000000000000000000000000002";
const draft: MintDraft = {
  name: "Test artwork",
  artist: "Test artist",
  year: 2026,
  medium: "Test image",
  location: "Hoodi fixture",
  description: "Isolated fixture without real asset rights.",
};
const intent: MintIntent = {
  intentId: "intent-123",
  requestId: `0x${"11".repeat(32)}`,
  recipient: wallet,
  registryAddress: registry,
  chainId: 560048,
  metadataUri: "https://fixture.test/metadata.json",
  metadataSha256: `0x${"22".repeat(32)}`,
  status: "prepared",
};
const file = () =>
  new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const session = createSetupRecoverySession("mint-test", isMintRecovery);
  session.restore(() => storage);
  return { session, lease: session.begin()!, storage };
}
function prepareArgs(
  overrides: Partial<Parameters<typeof prepareMint>[0]> = {},
) {
  return {
    draft,
    file: file(),
    wallet,
    chainId: 560048,
    assertCurrent: () => {},
    save: vi.fn(),
    stage: vi.fn(),
    upload: vi.fn(async () => "upload-123"),
    prepare: vi.fn(async () => intent),
    ...overrides,
  };
}

describe("mint preparation recovery", () => {
  it("reuses upload, exact intent and idempotency key after explicit wallet rejection", async () => {
    const { session, lease } = setup();
    const args = prepareArgs({ save: (data) => session.save(lease, data) });
    const prepared = await prepareMint(args);
    session.awaitWallet(lease, "mint");
    session.rejected(lease);
    session.finish(lease);
    const next = session.begin()!;
    const retry = await prepareMint({
      ...args,
      previous: session.getSnapshot().record!.data,
      save: (data) => session.save(next, data),
    });
    expect(retry).toEqual(prepared);
    expect(args.upload).toHaveBeenCalledTimes(1);
    expect(args.prepare).toHaveBeenCalledTimes(1);
    expect(retry.intent).toBe(intent);
  });
  it("restores a prepared intent without storing or requiring file bytes", async () => {
    const prepared = await prepareMint(prepareArgs());
    const args = prepareArgs({
      previous: JSON.parse(JSON.stringify(prepared)),
      file: undefined,
    });
    expect(await prepareMint(args)).toEqual(prepared);
    expect(args.upload).not.toHaveBeenCalled();
    expect(args.prepare).not.toHaveBeenCalled();
    expect(isMintRecovery(prepared)).toBe(true);
  });
  it("uses a fresh key for deliberately changed metadata and reuses unchanged uploaded bytes", async () => {
    const previous = await prepareMint(prepareArgs());
    const args = prepareArgs({
      previous,
      draft: { ...draft, name: "Changed artwork" },
    });
    const next = await prepareMint(args);
    expect(next.idempotencyKey).not.toBe(previous.idempotencyKey);
    expect(next.uploadId).toBe(previous.uploadId);
    expect(args.upload).not.toHaveBeenCalled();
    expect(args.prepare).toHaveBeenCalledTimes(1);
  });
  it("retains the completed upload when preparation fails for same-payload recovery", async () => {
    const saves: MintRecovery[] = [];
    const args = prepareArgs({
      save: (data) => saves.push(data),
      prepare: vi
        .fn()
        .mockRejectedValueOnce(new Error("503"))
        .mockResolvedValue(intent),
    });
    await expect(prepareMint(args)).rejects.toThrow("503");
    const previous = saves.at(-1)!;
    const next = await prepareMint({ ...args, previous });
    expect(args.upload).toHaveBeenCalledTimes(1);
    expect(next.idempotencyKey).toBe(previous.idempotencyKey);
    expect(next.uploadId).toBe(previous.uploadId);
  });
  it("takes a synchronous lease before hashing or upload can be clicked again", async () => {
    const { session, lease } = setup();
    const upload = deferred<string>();
    const pending = prepareMint(
      prepareArgs({
        upload: () => upload.promise,
        save: (data) => session.save(lease, data),
      }),
    );
    expect(session.begin()).toBeUndefined();
    upload.resolve("upload-123");
    await pending;
    expect(session.begin()).toBeUndefined();
    session.finish(lease);
    expect(session.begin()).toBeTypeOf("number");
  });
  it.each(["upload", "prepare"] as const)(
    "retires before saving the late %s response",
    async (boundary) => {
      const response = deferred<never>();
      const current = currentOperation();
      const save = vi.fn();
      const stage = vi.fn();
      const args = prepareArgs({
        save,
        stage,
        assertCurrent: current.assertCurrent,
        [boundary]: () => response.promise,
      });
      const pending = prepareMint(args);
      await vi.waitFor(() =>
        expect(stage).toHaveBeenCalledWith(
          boundary === "upload" ? "uploading" : "preparing",
        ),
      );
      const count = save.mock.calls.length;
      current.retire();
      response.resolve(
        (boundary === "upload" ? "upload-123" : intent) as never,
      );
      await expect(pending).rejects.toThrow("changed");
      expect(save).toHaveBeenCalledTimes(count);
    },
  );
  it("requires the original digest when restoring an interrupted pre-upload record", async () => {
    const prepared = await prepareMint(prepareArgs());
    const previous = { ...prepared, uploadId: undefined, intent: undefined };
    await expect(
      prepareMint(prepareArgs({ previous, file: undefined })),
    ).rejects.toThrow("Reselect");
    await expect(
      prepareMint(
        prepareArgs({ previous, file: new File(["changed"], "test.png") }),
      ),
    ).rejects.toThrow("does not match");
    const changed = await prepareMint(
      prepareArgs({
        previous,
        draft: { ...draft, name: "Changed draft" },
        file: new File(["changed"], "test.png"),
      }),
    );
    expect(changed.idempotencyKey).not.toBe(previous.idempotencyKey);
  });
});

describe("mint on-chain evidence and continuation", () => {
  function chain(overrides = {}) {
    const asset = {
      creator: wallet,
      recipient: wallet,
      tokenId: 7n,
      metadataHash: intent.metadataSha256,
      metadataURI: intent.metadataUri,
      intentHash: keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
          [wallet, intent.metadataUri, intent.metadataSha256],
        ),
      ),
      createdAt: 1n,
      ...overrides,
    };
    const readContract = vi
      .fn()
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(collection);
    return {
      readContract,
      client: { readContract } as unknown as Pick<PublicClient, "readContract">,
    };
  }
  it("recovers without another mint event and builds the exact DAO link", async () => {
    const minted = await recoverMintedAsset(
      chain().client,
      intent,
      wallet,
      () => {},
      100n,
    );
    expect(minted).toEqual({
      chainId: 560048,
      collectionAddress: collection,
      tokenId: "7",
    });
    expect(mintedDaoHref(minted)).toBe(
      `/dao?chainId=560048&collectionAddress=${collection}&tokenId=7`,
    );
  });
  it.each([
    { creator: collection },
    { recipient: collection },
    { metadataHash: intent.requestId },
    { metadataURI: "https://wrong.test" },
    { intentHash: intent.requestId },
    { tokenId: 0n },
  ])("rejects mismatched registry binding %#", async (change) => {
    const { client, readContract } = chain(change);
    await expect(
      recoverMintedAsset(client, intent, wallet, () => {}),
    ).rejects.toThrow("does not match");
    expect(readContract).toHaveBeenCalledTimes(1);
  });
  it("rejects changed response commitments and wrong deployment before signing", () => {
    const deployment = { chainId: 560048, registryAddress: registry };
    expect(() =>
      assertMintIntent(intent, wallet, deployment, intent),
    ).not.toThrow();
    expect(() =>
      assertMintIntent(
        { ...intent, metadataUri: "https://wrong.test" },
        wallet,
        deployment,
        intent,
      ),
    ).toThrow("changed");
    expect(() =>
      assertMintIntent(
        { ...intent, registryAddress: collection },
        wallet,
        deployment,
      ),
    ).toThrow("does not match");
    expect(() =>
      assertMintIntent(
        { ...intent, recipient: collection },
        wallet,
        deployment,
      ),
    ).toThrow("does not match");
  });
  it("stops the collection read when context changes during the asset read", async () => {
    const response = deferred<never>();
    const readContract = vi.fn(() => response.promise);
    const op = currentOperation();
    const promise = recoverMintedAsset(
      { readContract } as unknown as Pick<PublicClient, "readContract">,
      intent,
      wallet,
      op.assertCurrent,
    );
    op.retire();
    response.resolve({} as never);
    await expect(promise).rejects.toThrow("changed");
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});
