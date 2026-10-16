import { describe, expect, it } from "vitest";
import {
  assertVaultBinding,
  isVaultSetup,
  type VaultSetup,
  type VaultIntent,
} from "./vault-setup";
import type { DaoPresentation } from "./dao-presentation";
const address = (digit: string) => ("0x" + digit.repeat(40)) as `0x${string}`;
const presentation = (): DaoPresentation => ({
  version: 1,
  description: "TEST_ONLY DAO profile",
  avatar: { text: "DAO", palette: "teal" },
});
function fixture() {
  const configuration = {
    collectionAddress: address("1"),
    tokenId: "1",
    vaultName: "TEST_ONLY Vault",
    adminAddress: address("2"),
    pauserAddress: address("3"),
    fractionalizerAddress: address("4"),
    tokenName: "TEST_ONLY Fractions",
    tokenSymbol: "TEST",
    tokenSupply: "1000000000000000000",
    recipient: address("2"),
    presentation: presentation(),
  };
  const data: VaultSetup = {
    chainId: 560048,
    walletAddress: address("2"),
    factoryAddress: address("5"),
    idempotencyKey: "TEST-ONLY-idempotency-0001",
    configuration,
    stage: "configure",
  };
  const intent: VaultIntent = {
    ...configuration,
    chainId: 560048,
    factoryAddress: data.factoryAddress,
    requestId: ("0x" + "a".repeat(64)) as `0x${string}`,
    intentId: "TEST_ONLY_intent",
    presentation: presentation(),
  };
  return { data, intent };
}
describe("Vault presentation response and recovery binding", () => {
  it("binds every profile field before the existing transaction workflow", () => {
    const { data, intent } = fixture();
    expect(() => assertVaultBinding(intent, data)).not.toThrow();
    for (const changed of [
      undefined,
      { ...presentation(), description: "changed" },
      { ...presentation(), avatar: { text: "NEW", palette: "teal" } },
      { ...presentation(), avatar: { text: "DAO", palette: "gold" } },
    ])
      expect(() =>
        assertVaultBinding(
          { ...intent, presentation: changed } as VaultIntent,
          data,
        ),
      ).toThrow();
  });
  it("retains legacy requests only when both sides omit presentation", () => {
    const { data, intent } = fixture();
    delete data.configuration.presentation;
    delete intent.presentation;
    expect(() => assertVaultBinding(intent, data)).not.toThrow();
    data.intent = intent;
    expect(isVaultSetup(data)).toBe(true);
    data.configuration.presentation = presentation();
    expect(isVaultSetup(data)).toBe(false);
  });
});
