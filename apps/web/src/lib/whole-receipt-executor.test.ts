import { expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { decodeFunctionData,keccak256,parseAbi,type Address,type Hex } from "viem";
import {createWholeReceiptExecutor} from "./whole-receipt-executor";
import {receiptAuthorizationHash} from "./whole-receipt-authorization";
import {nftTaskJournalDigest} from "./nft/task-journal";
import type {WholeReceiptTaskPlan,WholeReceiptTaskOperation} from "./whole-receipt-journal";
const a=(x:string)=>`0x${x.repeat(40)}` as Address,h=(x:string)=>`0x${x.repeat(64)}` as Hex;
function fixture(){
 const task={kind:"task" as const,taskId:"TEST_ONLY",taskDigest:h("1"),executorDigest:h("2"),grantReference:"TEST_ONLY",grantPolicyVersion:"1",operationId:"TEST_ONLY_operation"};
 const sale={seller:a("a"),buyer:a("b"),collection:a("1"),paymentToken:a("2"),tokenId:7n,price:100n,salt:1n,epoch:0n,startsAt:1000,endsAt:2000};
 const domain={chainId:560048 as const,verifyingContract:a("3")};
 const correspondence={settlementId:h("1"),assetRecordHash:h("2"),oracleSourceId:h("3"),requestHash:h("4"),executionReferenceHash:h("5"),previousSegment:h("0"),oldCertificateHash:h("6"),warehouseReceiptHash:h("7")};
 const plan:WholeReceiptTaskPlan={id:"TEST_ONLY_receipt_plan",operationId:task.operationId,taskPrincipal:task,chainId:560048,request:{account:sale.buyer},kind:"transaction",wholeReceipt:{schemaVersion:1,phase:"funded",segmentId:receiptAuthorizationHash(sale,domain,correspondence),domain,correspondence,sale:{...sale,tokenId:"7",price:"100",salt:"1",epoch:"0"}}};
 const row:WholeReceiptTaskOperation={id:plan.operationId,wallet:sale.buyer,chainId:560048,plan,requestHash:nftTaskJournalDigest(plan),revision:1,status:"awaiting-wallet",walletStarted:false,updatedAt:"2026-10-12T00:00:00Z"};
 const calls:string[]=[];
 const journal={read:vi.fn(async()=>structuredClone(row)),markWalletStarted:vi.fn(async()=>{calls.push("durable-start");if(row.walletStarted)throw Error("CAS_CONFLICT");row.walletStarted=true;return structuredClone(row);}),recordSubmission:vi.fn(async(_task:unknown,_row:unknown,hash:Hex)=>{calls.push("record-hash");row.transactionHash=hash;row.status="pending";return structuredClone(row);})};
 const wallet={identity:vi.fn(async()=>({account:sale.buyer,chainId:560048})),sendTransaction:vi.fn(async()=>{calls.push("wallet-send");return h("a");})};
 const chain={getChainId:vi.fn(async()=>560048),getCode:vi.fn(async()=>"0x6000" as Hex),simulate:vi.fn(async()=>{calls.push("simulate");})};
 const authorize=async<T>(_task:unknown,_plan:unknown,action:(lease:{expiresAtMs:number})=>Promise<T>)=>action({expiresAtMs:Date.now()+60000});
 const deps={journal,wallet,chain,authorize,chainId:560048 as const,escrow:a("3"),runtimeCodeHash:keccak256("0x6000")};
 return{task,row,calls,journal,wallet,chain,deps,client:()=>createWholeReceiptExecutor(deps)};
}
it("simulates exact zero-value request, CAS-claims before one wallet send and records only hash",async()=>{
 const f=fixture();await f.client().execute(f.task,f.row.id,"0x1234");
 expect(f.calls).toEqual(["simulate","durable-start","wallet-send","record-hash"]);
 expect(f.wallet.sendTransaction.mock.calls[0]).toEqual(f.chain.simulate.mock.calls[0]);
 expect(JSON.stringify(f.row)).not.toContain("0x1234");
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow("RECOVER_EXISTING");expect(f.wallet.sendTransaction).toHaveBeenCalledTimes(1);
});
it("keeps outcome-unknown marker after wallet throws, never retries",async()=>{
 const f=fixture();f.wallet.sendTransaction.mockRejectedValue(Error("PRIVATE_PROVIDER_ERROR"));
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow("OUTCOME_UNKNOWN");
 expect(f.row.walletStarted).toBe(true);await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow("RECOVER_EXISTING");expect(f.wallet.sendTransaction).toHaveBeenCalledTimes(1);
});
it("retains returned hash when journal acknowledgement is lost",async()=>{
 const f=fixture();f.journal.recordSubmission.mockRejectedValue(Error("UNAVAILABLE"));
 expect(await f.client().execute(f.task,f.row.id,"0x1234")).toEqual({status:"submission-recording-unknown",operationId:f.row.id,transactionHash:h("a")});expect(f.row.walletStarted).toBe(true);
});
for(const mode of ["simulation","code","chain","wallet","authorization"] as const){
 it(`rejects ${mode} failure before wallet start`,async()=>{
 const f=fixture();if(mode==="simulation")f.chain.simulate.mockRejectedValue(Error("REVERT"));if(mode==="code")f.chain.getCode.mockResolvedValue("0x6001");if(mode==="chain")f.chain.getChainId.mockResolvedValue(1);if(mode==="wallet")f.wallet.identity.mockResolvedValue({account:a("c"),chainId:560048});if(mode==="authorization")f.deps.authorize=async()=>{throw Error("REVOKED");};
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow();expect(f.wallet.sendTransaction).not.toHaveBeenCalled();expect(f.journal.markWalletStarted).not.toHaveBeenCalled();
 });
}
it("rejects a post-CAS account switch without clearing the marker",async()=>{
 const f=fixture();f.wallet.identity.mockResolvedValueOnce({account:a("b"),chainId:560048}).mockResolvedValueOnce({account:a("b"),chainId:560048}).mockResolvedValue({account:a("c"),chainId:560048});
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow();expect(f.row.walletStarted).toBe(true);expect(f.wallet.sendTransaction).not.toHaveBeenCalled();
});
it("prepares only the immutable segment for payout, with no caller-selected recipient or amount",async()=>{
 const f=fixture();f.row.plan.wholeReceipt.phase="paid";
 await f.client().execute(f.task,f.row.id);
 const request=f.wallet.sendTransaction.mock.calls[0] as unknown as [{to:Address;value:bigint;data:Hex}];
 expect(request[0].to).toBe(f.deps.escrow);expect(request[0].value).toBe(0n);
 expect(decodeFunctionData({abi:parseAbi(["function paySeller(bytes32 id)"]),data:request[0].data}).args).toEqual([f.row.plan.wholeReceipt.segmentId]);
});
it("never sends if durable-start acknowledgement is lost",async()=>{
 const f=fixture();f.journal.markWalletStarted.mockImplementation(async()=>{f.row.walletStarted=true;throw Error("ACK_LOST");});
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow();expect(f.wallet.sendTransaction).not.toHaveBeenCalled();
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow("RECOVER_EXISTING");
});
it("refuses expired execution capability before simulation or wallet start",async()=>{
 const f=fixture();f.deps.authorize=async(_task,_plan,action)=>action({expiresAtMs:Date.now()-1});
 await expect(f.client().execute(f.task,f.row.id,"0x1234")).rejects.toThrow();expect(f.chain.simulate).not.toHaveBeenCalled();expect(f.journal.markWalletStarted).not.toHaveBeenCalled();
});
