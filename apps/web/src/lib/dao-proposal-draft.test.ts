import { describe, expect, it } from "vitest";
import {
  createDaoProposalDraft,
  daoDraftForm,
  daoDraftMaxBytes,
  parseDaoProposalDraft,
  serializeDaoProposalDraft,
  type DaoDraftContext,
  type DaoDraftForm,
} from "./dao-proposal-draft";

const target: DaoDraftContext = {
  chainId: "560048",
  governor: "0x" + "1".repeat(40),
  token: "0x" + "2".repeat(40),
  vault: "0x" + "3".repeat(40),
  actionRegistry: "0x" + "4".repeat(40),
};
const form: DaoDraftForm = {
  actionType: "market",
  description: "Migrate the approved marketplace after review.",
  evidenceHash: "0x" + "a".repeat(64),
  evidenceURI: "https://example.invalid/proposal-evidence",
  marketName: "TEST_ONLY market",
  amountWei: "",
  t0: "",
  observationStart: "",
  tradeCount: "",
  dueDate: "",
};
function json(overrides: Partial<DaoDraftForm> = {}) {
  return JSON.parse(
    serializeDaoProposalDraft(
      createDaoProposalDraft(target, { ...form, ...overrides }),
      target,
    ),
  );
}

describe("unsigned DAO proposal drafts", () => {
  it("roundtrips the full target and terms without a transaction package", () => {
    const draft = createDaoProposalDraft(target, form);
    const encoded = serializeDaoProposalDraft(draft, target);
    expect(parseDaoProposalDraft(encoded, target)).toEqual(draft);
    expect(daoDraftForm(draft)).toEqual(form);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.context)).toBe(true);
    expect(Object.isFrozen(draft.action)).toBe(true);
    expect(encoded).not.toMatch(
      /signature|calldata|transactionHash|proposalId/,
    );
  });
  it("normalizes addresses and hash spelling while retaining exact decimal terms", () => {
    const lower = createDaoProposalDraft(target, form);
    const upperHash = createDaoProposalDraft(target, {
      ...form,
      evidenceHash: "0x" + "A".repeat(64),
    });
    expect(upperHash).toEqual(lower);
    const namedTarget = { ...target, vault: "0x" + "a".repeat(40) };
    const draft = createDaoProposalDraft(namedTarget, form);
    expect(
      parseDaoProposalDraft(JSON.stringify(draft), namedTarget).context.vault,
    ).toBe(namedTarget.vault);
  });
  it.each(["warehouse", "auction", "sale", "custodian"] as const)(
    "retains %s as a ledger request without stale market fields",
    (type) => {
      const draft = createDaoProposalDraft(target, {
        ...form,
        actionType: type,
        amountWei: "not used",
      });
      expect(Object.keys(draft.action).sort()).toEqual(
        ["type", "description", "evidenceHash", "evidenceURI"].sort(),
      );
      expect(daoDraftForm(draft).marketName).toBe("");
      expect(daoDraftForm(draft).amountWei).toBe("");
    },
  );
  it("keeps failure-cost assessment separate from any debit or settlement", () => {
    const draft = createDaoProposalDraft(target, {
      ...form,
      actionType: "failure",
      amountWei: "123456789012345678901234567890",
      dueDate: "1800000000",
    });
    expect(draft.action.amountWei).toBe("123456789012345678901234567890");
    expect(daoDraftForm(draft).t0).toBe("");
    expect(parseDaoProposalDraft(JSON.stringify(draft), target)).toEqual(draft);
  });
  it.each([
    {
      actionType: "buyout30",
      amountWei: "100",
      t0: "3000000",
      observationStart: "408000",
      tradeCount: "7",
    },
    {
      actionType: "buyout10",
      amountWei: "100",
      t0: "3000000",
      observationStart: "0",
      tradeCount: "10",
    },
  ] as const)("preserves the existing $actionType initiation rule", (terms) => {
    const draft = createDaoProposalDraft(target, { ...form, ...terms });
    expect(parseDaoProposalDraft(JSON.stringify(draft), target)).toEqual(draft);
    expect(daoDraftForm(draft).actionType).toBe(terms.actionType);
    expect(daoDraftForm(draft).marketName).toBe("");
  });
  it("rejects a target mismatch for every deployment member before returning terms", () => {
    const raw = JSON.stringify(json());
    for (const key of Object.keys(target) as (keyof DaoDraftContext)[]) {
      const wrong = {
        ...target,
        [key]: key === "chainId" ? "1" : "0x" + "9".repeat(40),
      };
      expect(() => parseDaoProposalDraft(raw, wrong)).toThrow();
    }
    expect(() =>
      createDaoProposalDraft({ ...target, governor: "" }, form),
    ).toThrow();
    expect(() =>
      createDaoProposalDraft({ ...target, vault: "0x" + "0".repeat(40) }, form),
    ).toThrow();
  });
  it("refuses unsupported fields at every level, including signing and execution data", () => {
    for (const key of [
      "signature",
      "privateKey",
      "calldata",
      "proposalId",
      "transactionHash",
      "autoExecute",
      "__proto__",
    ]) {
      for (const level of ["root", "context", "action"]) {
        const value = json();
        const object = level === "root" ? value : value[level];
        Object.defineProperty(object, key, {
          value: "TEST_ONLY",
          enumerable: true,
        });
        expect(() =>
          parseDaoProposalDraft(JSON.stringify(value), target),
        ).toThrow();
      }
    }
  });
  it("refuses missing fields, unknown versions and unknown action types", () => {
    for (const key of ["schema", "context", "action"]) {
      const value = json();
      delete value[key];
      expect(() =>
        parseDaoProposalDraft(JSON.stringify(value), target),
      ).toThrow();
    }
    const version = json();
    version.schema = "artfi-dao-draft/2";
    expect(() =>
      parseDaoProposalDraft(JSON.stringify(version), target),
    ).toThrow();
    const action = json();
    action.action.type = "execute";
    expect(() =>
      parseDaoProposalDraft(JSON.stringify(action), target),
    ).toThrow();
    const missing = json();
    delete missing.action.evidenceHash;
    expect(() =>
      parseDaoProposalDraft(JSON.stringify(missing), target),
    ).toThrow();
  });
  it("rejects noncanonical quantities, overflows and pricing-rule contradictions", () => {
    const failure = {
      ...form,
      actionType: "failure" as const,
      amountWei: "1",
      dueDate: "1800000000",
    };
    for (const amountWei of [
      "0",
      "01",
      "-1",
      "1e3",
      "1.0",
      (1n << 256n).toString(),
    ]) {
      expect(() =>
        createDaoProposalDraft(target, { ...failure, amountWei }),
      ).toThrow();
    }
    expect(() =>
      createDaoProposalDraft(target, {
        ...failure,
        dueDate: (1n << 48n).toString(),
      }),
    ).toThrow();
    const buyout = {
      ...form,
      actionType: "buyout30" as const,
      amountWei: "1",
      t0: "3000000",
      observationStart: "408000",
      tradeCount: "1",
    };
    for (const patch of [
      { observationStart: "407999" },
      { tradeCount: "0" },
      { tradeCount: "4294967296" },
      { t0: "1" },
    ]) {
      expect(() =>
        createDaoProposalDraft(target, { ...buyout, ...patch }),
      ).toThrow();
    }
    for (const patch of [{ tradeCount: "9" }, { observationStart: "1" }]) {
      expect(() =>
        createDaoProposalDraft(target, {
          ...buyout,
          actionType: "buyout10",
          observationStart: "0",
          tradeCount: "10",
          ...patch,
        }),
      ).toThrow();
    }
    const numeric = json({
      actionType: "failure",
      amountWei: "1",
      dueDate: "1800000000",
    });
    numeric.action.amountWei = 1;
    expect(() =>
      parseDaoProposalDraft(JSON.stringify(numeric), target),
    ).toThrow();
  });
  it("rejects empty evidence, unsafe URI schemes, credentials and the contract URI byte overflow", () => {
    for (const evidenceURI of [
      "javascript:alert(1)",
      "data:text/plain,test",
      "http://example.invalid/a",
      "https://user:password@example.invalid/a",
      "ipfs://",
      "https://example.invalid/" + "雪".repeat(170),
    ]) {
      expect(() =>
        createDaoProposalDraft(target, { ...form, evidenceURI }),
      ).toThrow();
    }
    expect(() =>
      createDaoProposalDraft(target, {
        ...form,
        evidenceHash: "0x" + "0".repeat(64),
      }),
    ).toThrow();
    expect(
      createDaoProposalDraft(target, {
        ...form,
        evidenceURI: "ipfs://test-only-cid/evidence",
      }).action.evidenceURI,
    ).toBe("ipfs://test-only-cid/evidence");
  });
  it("rejects oversized, malformed, null and trailing JSON without changing the original form", () => {
    const before = { ...form };
    for (const raw of [
      "null",
      "[]",
      "{",
      JSON.stringify(json()) + "{}",
      " ".repeat(daoDraftMaxBytes + 1),
      JSON.stringify({ value: "雪".repeat(6000) }),
    ]) {
      expect(() => parseDaoProposalDraft(raw, target)).toThrow();
    }
    expect(form).toEqual(before);
  });
  it("copies draft terms so editing the import object cannot change a reviewed snapshot", () => {
    const imported = json();
    const draft = parseDaoProposalDraft(JSON.stringify(imported), target);
    imported.context.governor = "0x" + "9".repeat(40);
    imported.action.description = "A later unreviewed text";
    expect(draft.context.governor).toBe(target.governor);
    expect(draft.action.description).toBe(form.description);
    const copied = daoDraftForm(draft);
    copied.description = "A separate edited form";
    expect(draft.action.description).toBe(form.description);
  });
  it("does not invoke accessors supplied to the in-process serializer", () => {
    let calls = 0;
    const value = json();
    Object.defineProperty(value.action, "description", {
      get() {
        calls++;
        return form.description;
      },
      enumerable: true,
    });
    expect(() => serializeDaoProposalDraft(value, target)).toThrow();
    expect(calls).toBe(0);
  });
});
