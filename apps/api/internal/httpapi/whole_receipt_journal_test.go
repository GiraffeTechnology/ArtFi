package httpapi

import (
 "encoding/json"
 "strings"
 "testing"
 "time"
)

// Existing repository decisions are exercised directly. No new storage,
// authentication bypass, migration or live database is introduced by this test.
func receiptJournalFixture(t *testing.T) (verifiedNFTPrincipal, nftOperation) {
 t.Helper()
 task := syntheticNFTTaskPrincipal()
 principal := verifiedNFTPrincipal{wallet:userAuthTestAddress, chainID:560048, task:&task}
 plan := map[string]any{
  "id":"TEST_ONLY_receipt_plan", "operationId":"TEST_ONLY_receipt_operation", "chainId":560048,
  "taskPrincipal":task, "kind":"transaction", "request":map[string]any{"account":userAuthTestAddress},
  "wholeReceipt":map[string]any{"schemaVersion":1,"phase":"funded","segmentId":"0x"+strings.Repeat("a",64),
   "sale":map[string]any{"price":"100","buyer":userAuthTestAddress,"seller":"0x"+strings.Repeat("b",40)},
   "correspondence":map[string]any{"requestHash":"0x"+strings.Repeat("c",64),"executionReferenceHash":"0x"+strings.Repeat("d",64)}},
 }
 raw,err:=json.Marshal(plan);if err!=nil{t.Fatal(err)}
 digest,err:=nftTaskWireDigest(raw);if err!=nil{t.Fatal(err)}
 return principal,nftOperation{ID:"TEST_ONLY_receipt_operation",Wallet:userAuthTestAddress,ChainID:560048,RequestHash:digest,Status:"awaiting-wallet",Plan:raw}
}

func TestWholeReceiptUsesSharedTaskJournalCASAndRecovery(t *testing.T) {
 p,input:=receiptJournalFixture(t);now:=time.Date(2026,10,12,0,0,0,0,time.UTC)
 created,write,err:=decideNFTMutation(p,"create",input,nil,now)
 if err!=nil||!write||created.Revision!=1{t.Fatalf("create failed: %v",err)}
 started:=created;started.WalletStarted=true
 started,write,err=decideNFTMutation(p,"update",started,&created,now)
 if err!=nil||!write||started.Revision!=2{t.Fatalf("start failed: %v",err)}
 _,_,err=decideNFTMutation(p,"update",created,&started,now);assertNFTStatus(t,err,409)
 submitted:=started;submitted.Status="pending";submitted.TransactionHash="0x"+strings.Repeat("e",64)
 submitted,write,err=decideNFTMutation(p,"update",submitted,&started,now)
 if err!=nil||!write||submitted.Revision!=3{t.Fatalf("submission failed: %v",err)}
 recovered,write,err:=decideNFTMutation(p,"create",input,&submitted,now)
 if err!=nil||write||recovered.TransactionHash!=submitted.TransactionHash||!recovered.WalletStarted{t.Fatal("duplicate create reset live operation")}
 recovered,write,err=decideNFTMutation(p,"get",nftOperation{ID:input.ID},&submitted,now)
 if err!=nil||write||recovered.Revision!=3{t.Fatal("recovery failed")}
 changed:=submitted;changed.TransactionHash="0x"+strings.Repeat("f",64)
 _,_,err=decideNFTMutation(p,"update",changed,&submitted,now);assertNFTStatus(t,err,409)
}

func TestWholeReceiptSharedJournalRejectsImmutablePlanMutation(t *testing.T) {
 p,input:=receiptJournalFixture(t);now:=time.Now();stored,_,err:=decideNFTMutation(p,"create",input,nil,now);if err!=nil{t.Fatal(err)}
 for _,field:=range []string{"phase","segmentId","sale","correspondence"}{t.Run(field,func(t *testing.T){
  changed:=stored;var plan map[string]any;if json.Unmarshal(changed.Plan,&plan)!=nil{t.Fatal("fixture")}
  plan["wholeReceipt"].(map[string]any)[field]="TEST_ONLY_CHANGED"
  changed.Plan,_=json.Marshal(plan)
  _,_,err:=decideNFTMutation(p,"update",changed,&stored,now);assertNFTStatus(t,err,409)
  _,_,err=decideNFTMutation(p,"create",changed,&stored,now);assertNFTStatus(t,err,409)
 })}
}

func TestWholeReceiptSharedJournalKeepsTaskSessionWalletIsolation(t *testing.T) {
 p,input:=receiptJournalFixture(t);now:=time.Now();stored,_,err:=decideNFTMutation(p,"create",input,nil,now);if err!=nil{t.Fatal(err)}
 otherTask:=*p.task;otherTask.TaskID="TEST_ONLY_OTHER"
 for _,other:=range []verifiedNFTPrincipal{
  {wallet:p.wallet,chainID:p.chainID,sessionID:"TEST_ONLY_SESSION"},
  {wallet:p.wallet,chainID:p.chainID,task:&otherTask},
  {wallet:"0x"+strings.Repeat("f",40),chainID:p.chainID,task:p.task},
  {wallet:p.wallet,chainID:1,task:p.task},
 }{_,_,err=decideNFTMutation(other,"get",nftOperation{ID:input.ID},&stored,now);assertNFTStatus(t,err,403)}
}
