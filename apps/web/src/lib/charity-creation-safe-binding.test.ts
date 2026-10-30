import { expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  sameCharitySeriesFields,
  simulateCharitySeriesCreation,
  type CharitySeriesSetup,
} from "./charity-creation-recovery";
const actor = "0x1000000000000000000000000000000000000001" as Address;
const collection = "0x1000000000000000000000000000000000000002" as Address;
const safe = "0x1000000000000000000000000000000000000003" as Address;
const setup: CharitySeriesSetup = {
  version: 1,
  chainId: 560048,
  walletAddress: actor,
  collectionAddress: collection,
  fields: {
    artworkId: `0x${"1".repeat(64)}`,
    masterArtworkHash: `0x${"2".repeat(64)}`,
    metadataHash: `0x${"3".repeat(64)}`,
    distributionWallet: actor,
    metadataURI: "ipfs://TEST_ONLY/no-preview.json",
  },
};
it("simulates the existing Safe caller and exact reviewed call without a wallet or ETH request", async () => {
  const simulateContract = vi.fn(async (_input: unknown) => ({}));
  await simulateCharitySeriesCreation(
    { simulateContract } as unknown as Parameters<
      typeof simulateCharitySeriesCreation
    >[0],
    setup,
    () => {},
    safe,
  );
  const request = simulateContract.mock.calls[0][0];
  expect(request).toMatchObject({
    account: safe,
    address: collection,
    functionName: "createSeries",
    args: [
      setup.fields.artworkId,
      setup.fields.masterArtworkHash,
      setup.fields.metadataHash,
      actor,
      setup.fields.metadataURI,
    ],
  });
  expect(request).not.toHaveProperty("value");
  expect(setup.walletAddress).toBe(actor);
});
for (const field of [
  "artworkId",
  "masterArtworkHash",
  "metadataHash",
  "distributionWallet",
  "metadataURI",
] as const) {
  it("does not bind Safe execution to another reviewed " + field, () => {
    const fields = { ...setup.fields };
    if (field === "metadataURI")
      fields.metadataURI = "ipfs://TEST_ONLY/another.json";
    else if (field === "distributionWallet") fields.distributionWallet = safe;
    else fields[field] = `0x${"f".repeat(64)}`;
    expect(sameCharitySeriesFields(setup.fields, fields)).toBe(false);
    expect(sameCharitySeriesFields(setup.fields, { ...setup.fields })).toBe(
      true,
    );
  });
}
