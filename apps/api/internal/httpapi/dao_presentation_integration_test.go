package httpapi

import (
 "context"
 "net/http"
 "reflect"
 "strings"
 "testing"
)
func TestMySQLDAOPresentationReadbackRestartAndConflicts(t *testing.T) {
 fixture,a,asset,_,_:=catalogIntegrationFixture(t)
 a.config.vaultFactoryAddress="0x1111111111111111111111111111111111111111"
 b:=newRWAService(a.config,newMemoryObjectStore());b.db=fixture.db;b.requireDB=true;b.now=a.now;b.grounding=a.grounding
 handlers:=[]http.Handler{newHandler(a),newHandler(b)}
 input:=vaultIntentRequest{CollectionAddress:asset.Asset.Binding.CollectionAddress,TokenID:asset.Asset.Binding.TokenID,VaultName:"TEST_ONLY profile Vault",AdminAddress:fixture.owner.Session.Address,PauserAddress:fixture.owner.Session.Address,FractionalizerAddress:fixture.owner.Session.Address,Presentation:exampleDAOPresentation()}
 headers:=map[string]string{"Idempotency-Key":"dao-profile-"+randomID()}
 out:=jsonRequest(t,handlers[0],"POST","/v1/vault/intents",input,headers)
 if out.Code!=201{t.Fatalf("prepare profile %d %s",out.Code,out.Body)}
 var saved vaultIntent;decode(t,out,&saved)
 t.Cleanup(func(){fixture.db.Exec("DELETE FROM vaults WHERE vault_id=?",saved.IntentID)})
 if !reflect.DeepEqual(saved.Presentation,input.Presentation)||len(saved.ContractArguments)!=7{t.Fatal("profile or contract arguments changed")}
 out=jsonRequest(t,handlers[1],"POST","/v1/vault/intents",input,headers)
 if out.Code!=200{t.Fatalf("replay %d %s",out.Code,out.Body)}
 var replay vaultIntent;decode(t,out,&replay)
 if replay.RequestID!=saved.RequestID||replay.IntentID!=saved.IntentID||!reflect.DeepEqual(replay.Presentation,input.Presentation){t.Fatal("cross-node profile mismatch")}
 for _,change:=range []func(*daoPresentation){
  func(p *daoPresentation){p.Description="Different description"},
  func(p *daoPresentation){p.Avatar.Palette="gold"},
 } {
  changed:=input;changed.Presentation=cloneDAOPresentation(input.Presentation);change(changed.Presentation)
  if response:=jsonRequest(t,handlers[1],"POST","/v1/vault/intents",changed,headers);response.Code!=409{t.Fatalf("changed profile status %d",response.Code)}
 }
 fresh:=newRWAService(a.config,newMemoryObjectStore());fresh.db=fixture.db;fresh.requireDB=true
 if err:=fresh.hydratePersistence(context.Background());err!=nil{t.Fatal(err)}
 if hydrated:=fresh.vaultIntents[saved.IntentID];hydrated==nil||!reflect.DeepEqual(hydrated.Presentation,input.Presentation){t.Fatal("restart lost profile")}
 read,err:=b.readVaultIntent(context.Background(),saved.IntentID)
 if err!=nil||!reflect.DeepEqual(read.Presentation,input.Presentation){t.Fatal("DB read lost profile",err)}

 legacy:=input;legacy.Presentation=nil
 legacyHeaders:=map[string]string{"Idempotency-Key":"dao-legacy-"+randomID()}
 out=jsonRequest(t,handlers[0],"POST","/v1/vault/intents",legacy,legacyHeaders)
 if out.Code!=201{t.Fatalf("legacy prepare %d %s",out.Code,out.Body)}
 if strings.Contains(out.Body.String(),"\"presentation\""){t.Fatal("legacy omission changed")}
 var legacySaved vaultIntent;decode(t,out,&legacySaved)
 t.Cleanup(func(){fixture.db.Exec("DELETE FROM vaults WHERE vault_id=?",legacySaved.IntentID)})
 out=jsonRequest(t,handlers[1],"POST","/v1/vault/intents",legacy,legacyHeaders)
 if out.Code!=200{t.Fatalf("legacy replay %d",out.Code)}
}
