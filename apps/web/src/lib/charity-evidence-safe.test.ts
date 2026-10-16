import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toBytes, zeroHash, type Address, type Hex } from "viem";
import { charityEditionsAbi } from "./contracts";
import { encodeOperatorSafeSubmission, safeProposalRequestId } from "./admin-safe";
import { isSafeRecord, reviewSafeSubmission, safeFlowSpec } from "./admin-safe-client";
import { charityEvidenceSafeSubmission, type CharityEvidenceRecord } from "./charity-evidence";
const target = `0x${"12".repeat(20)}` as Address;
const wallet = `0x${"34".repeat(20)}` as Address;
const safe = `0x${"56".repeat(20)}` as Address;
const hash = `0x${"78".repeat(32)}` as Hex;
const record: CharityEvidenceRecord = {chainId:560048,account:wallet,target,tokenId:"9",action:"sellout",evidenceHash:hash};

describe("exact recorder-only Safe flow extensions", () => {
  it("uses the donation recorder role for both evidence methods and preserves the creation role", () => {
    const role = keccak256(toBytes("DONATION_RECORDER_ROLE"));
    expect(safeFlowSpec["charity-sellout"].role).toBe(role);
    expect(safeFlowSpec["charity-donation"].role).toBe(role);
    expect(safeFlowSpec.charity.role).toBe(keccak256(toBytes("SERIES_CREATOR_ROLE")));
    expect(safeFlowSpec.rwa.operatorSessionRequired).toBe(true);
    expect(safeFlowSpec.vault.operatorSessionRequired).toBe(true);
  });
  it("does not let an evidence call enter the existing creation console", () => {
    expect(() => reviewSafeSubmission("charity",target,charityEvidenceSafeSubmission(record))).toThrow();
  });
  it("does not let the donation flow review a sellout call", () => {
    expect(() => reviewSafeSubmission("charity-donation",target,charityEvidenceSafeSubmission(record),9n)).toThrow();
  });
  it("does not let a recorder flow submit series creation", () => {
    const creation = encodeOperatorSafeSubmission({target,requestId:hash,abi:charityEditionsAbi,functionName:"createSeries",args:[hash,hash,hash,wallet,"ipfs://TEST_ONLY"]});
    expect(() => reviewSafeSubmission("charity-sellout",target,creation,9n)).toThrow();
  });
  it.each([{value:1n},{target:safe},{requestId:zeroHash}])("rejects changed zero-value target/request binding %j", (change) => {
    expect(() => reviewSafeSubmission("charity-sellout",target,{...charityEvidenceSafeSubmission(record),...change},9n)).toThrow();
  });
  it("rejects an operation seed not derived from the evidence commitment", () => {
    const submission = charityEvidenceSafeSubmission(record);
    const wrong = {...submission,requestId:safeProposalRequestId(`0x${"ab".repeat(32)}` as Hex,target,submission.data)};
    expect(() => reviewSafeSubmission("charity-sellout",target,wrong,9n)).toThrow();
  });
  it.each([0n,10n])("rejects another/invalid expected series %s", (id) => {
    expect(() => reviewSafeSubmission("charity-sellout",target,charityEvidenceSafeSubmission(record),id)).toThrow();
  });
  it("rejects zero evidence even if its proposal identity is rebound", () => {
    const invalid = encodeOperatorSafeSubmission({target,requestId:hash,abi:charityEditionsAbi,functionName:"recordSellout",args:[9n,zeroHash]});
    expect(() => reviewSafeSubmission("charity-sellout",target,invalid,9n)).toThrow();
  });
  it("rejects noncanonical trailing calldata even when the request hash covers it", () => {
    const call = encodeFunctionData({abi:charityEditionsAbi,functionName:"recordSellout",args:[9n,hash]});
    const data = `${call}00` as Hex;
    expect(() => reviewSafeSubmission("charity-sellout",target,{target,value:0n,data,requestId:safeProposalRequestId(hash,target,data)},9n)).toThrow();
  });
  it("recognizes only own flow names in public recovery records", () => {
    const submission = charityEvidenceSafeSubmission(record);
    const stored = {chainId:560048,wallet,safe,kind:"charity-sellout",submission:{target,requestId:submission.requestId,data:submission.data},startBlock:"1"};
    expect(isSafeRecord(stored)).toBe(true);
    expect(isSafeRecord({...stored,kind:"toString"})).toBe(false);
    expect(isSafeRecord({...stored,kind:"constructor"})).toBe(false);
  });
});
