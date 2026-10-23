import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { readWholeReceiptOracleAttestation } from "./oracle-read";

const now = new Date("2026-10-12T08:00:00.000Z");
const binding = {
  settlementId:"TEST_ONLY-settlement", assetId:"TEST_ONLY-asset",
  token:{chainId:"560048",contract:`0x${"1".repeat(40)}`,tokenId:"7"},
  sellerWallet:`0x${"a".repeat(40)}`, buyerWallet:`0x${"b".repeat(40)}`,
  externalExecutionRef:"TEST_ONLY-private-execution",
  oldCertificateHash:"1".repeat(64), warehouseReceiptHash:"2".repeat(64),snapshotHash:"3".repeat(64),
};
const policy = {
  attestationId:"00000000-0000-4000-8000-000000000001", purpose:"provenance",
  signerSetId:"TEST_ONLY-signers", sourceAuthority:"TEST_ONLY-certificate-source",
  sourceRecordHash:"4".repeat(64),factType:"CERTIFICATE_STATUS" as const,factValue:"VALID",
};
function envelope() {
  return {
    attestation:{
      envelope:{schemaVersion:"giraffe-attestation.v1",attestationId:policy.attestationId,
        subject:{assetId:binding.assetId,...binding.token,purpose:policy.purpose},
        factType:policy.factType,factValue:policy.factValue,sourceAuthority:policy.sourceAuthority,
        sourceRecordHash:policy.sourceRecordHash,observedAt:now.toISOString(),validFrom:now.toISOString(),
        expiresAt:new Date(now.getTime()+60000).toISOString(),nonce:"TEST_ONLY-nonce",revocationRef:null,
        signerSetId:policy.signerSetId},
      envelopeHash:"5".repeat(64),signature:"TEST_ONLY_not_a_real_signature",
    },revoked:false,
  };
}
// Wire-contract fixtures only: these do not test Oracle cryptography or issuance.
function transport(value=envelope(), verification:unknown={valid:true,errorCode:null}) {
  const fetcher = vi.fn(async (_url: unknown,init?:RequestInit)=>Response.json(init?.method==="POST"?verification:value));
  vi.stubGlobal("fetch",fetcher);
  return fetcher;
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  vi.stubEnv("ARTFI_ORACLE_READ_API_URL","https://oracle.invalid/existing/");
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});

describe("TEST_ONLY existing Oracle attestation association",()=>{
  it("uses existing GET and verifier POST with exact expected subject, never payment authority",async()=>{
    const fetcher=transport();
    const result=await readWholeReceiptOracleAttestation(binding,policy);
    expect(result).toMatchObject({observationOnly:true,sourceAuthenticatedForPayment:false,registrationAuthorized:false,
      verification:{valid:true,subject:envelope().attestation.envelope.subject,sourceRecordHash:policy.sourceRecordHash}});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://oracle.invalid/existing/v1/rwa/attestations/${policy.attestationId}`);
    const [url,options]=fetcher.mock.calls[1];
    expect(String(url)).toBe("https://oracle.invalid/existing/v1/rwa/attestations/verify");
    expect(options).toMatchObject({method:"POST",credentials:"omit",cache:"no-store",redirect:"error"});
    const posted=String(options?.body);
    expect(JSON.parse(posted)).toEqual({attestation:envelope().attestation,expectedSubject:envelope().attestation.envelope.subject});
    for(const secret of [binding.sellerWallet,binding.buyerWallet,binding.externalExecutionRef,"grantReference","taskDigest"])
      expect(posted).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(envelope().attestation.signature);
  });
  it.each(["assetId","chainId","contract","tokenId","purpose"] as const)("rejects %s drift before verifier call",async key=>{
    const value=envelope();value.attestation.envelope.subject[key]="OTHER";
    const fetcher=transport(value);
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow("ATTESTATION_SOURCE_BINDING_MISMATCH");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["attestationId","signerSetId","sourceAuthority","sourceRecordHash","factType","factValue"] as const)("rejects %s source-policy drift",async key=>{
    const value=envelope();
    Object.assign(value.attestation.envelope,{[key]:key==="attestationId"?"00000000-0000-4000-8000-000000000002":key==="sourceRecordHash"?"6".repeat(64):key==="factType"?"TRANSFER_STATUS":"OTHER"});
    const fetcher=transport(value);
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["REVOKED","SIGNATURE_INVALID","HASH_INVALID","SIGNER_SET_NOT_ACTIVE","SUBJECT_MISMATCH","NOT_CURRENT"])("preserves verifier refusal %s",async errorCode=>{
    transport(envelope(),{valid:false,errorCode});
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow("ATTESTATION_VERIFICATION_REJECTED");
  });
  it("rejects an inconsistent valid result and extra response fields",async()=>{
    for(const response of [{valid:true,errorCode:"REVOKED"},{valid:true,errorCode:null,financialAuthority:true}]){
      transport(envelope(),response);
      await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow();
    }
  });
  it("does not invent a settlement-finalized fact or accept a record locator as its hash",async()=>{
    const fetcher=transport();
    await expect(readWholeReceiptOracleAttestation(binding,{...policy,factType:"SETTLEMENT_FINALIZED"} as never)).rejects.toThrow();
    await expect(readWholeReceiptOracleAttestation(binding,{...policy,sourceRecordHash:"certificate-reference"})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["invalid","future","expired","oversized-ttl"])("rejects %s timestamps locally",async mode=>{
    const value=envelope();
    if(mode==="invalid") value.attestation.envelope.validFrom="not-a-date";
    if(mode==="future") vi.setSystemTime(new Date(now.getTime()-1));
    if(mode==="expired") vi.setSystemTime(new Date(now.getTime()+60000));
    if(mode==="oversized-ttl") value.attestation.envelope.expiresAt=new Date(now.getTime()+86400001).toISOString();
    const fetcher=transport(value);
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rechecks expiry after the verification service responds",async()=>{
    vi.stubGlobal("fetch",vi.fn(async (_url,options)=>{
      if(options.method==="POST"){vi.setSystemTime(new Date(now.getTime()+60000));return Response.json({valid:true,errorCode:null});}
      return Response.json(envelope());
    }));
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow("ATTESTATION_NOT_CURRENT");
  });
  it("rejects revoked GET, oversized verification response and redirect failures",async()=>{
    transport({...envelope(),revoked:true});
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow();
    vi.stubGlobal("fetch",vi.fn(async(_url,options)=>options.method==="POST"
      ? new Response(" ".repeat(65537),{headers:{"content-type":"application/json"}}):Response.json(envelope())));
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow("ORACLE_INVALID_RESPONSE");
    vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("TEST_ONLY_REDIRECT_REFUSED");}));
    await expect(readWholeReceiptOracleAttestation(binding,policy)).rejects.toThrow("TEST_ONLY_REDIRECT_REFUSED");
  });
});
