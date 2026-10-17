package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type notificationFixture struct {
	db *sql.DB
	auth *userAuthService
	handler http.Handler
	owner,other *userAuthTokens
	now *time.Time
	txs []string
}

func notificationIntegrationFixture(t *testing.T) *notificationFixture {
	t.Helper()
	db,auth,now,address := walletAuthIntegrationFixture(t)
	var columns int
	if err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
		WHERE table_schema=DATABASE() AND table_name='chain_events' AND column_name='notification_revision'`).Scan(&columns);err!=nil {
		t.Fatal(err)
	}
	if columns!=1 {
		if os.Getenv("ARTFI_NOTIFICATION_MYSQL_REQUIRED")=="1" {
			t.Fatal("migration 000015 missing from required notification SQL run")
		}
		t.Skip("UNVERIFIED: notification SQL tests require migration 000015; the legacy migration job applies only 000001-000014")
	}
	t.Setenv("ARTFI_USER_AUTH_CHAIN_IDS",fmt.Sprintf("%d,1",hoodiChainID))
	random,err := userRandomToken(20)
	if err!=nil {t.Fatal(err)}
	f := &notificationFixture{db:db,auth:auth,now:now,owner:walletAuthIntegrationLogin(t,auth,address),other:walletAuthIntegrationLogin(t,auth,"0x"+random)}
	f.restart()
	t.Cleanup(func(){
		for _, tokens := range []*userAuthTokens{f.owner,f.other} {
			address := tokens.Session.Address
			for _, statement := range []string{
				"DELETE FROM notifications WHERE owner_address=?",
				"DELETE FROM notification_preferences WHERE owner_address=?",
				"DELETE FROM wallet_user_sessions WHERE wallet_address=?",
				"DELETE FROM wallet_user_challenges WHERE wallet_address=?",
			} {
				if _,err := db.Exec(statement,address);err!=nil {t.Error(err)}
			}
			hash := sha256.Sum256([]byte(address))
			if _,err := db.Exec("DELETE FROM administration_requests WHERE actor_hash=?",hash[:]);err!=nil {t.Error(err)}
		}
		for _, hash := range f.txs {
			if _,err := db.Exec("DELETE FROM chain_events WHERE chain_id=? AND transaction_hash=?",hoodiChainID,hash);err!=nil {t.Error(err)}
		}
	})
	return f
}

func (f *notificationFixture) restart() {
	mux := http.NewServeMux()
	registerNotifications(mux,f.auth)
	f.handler=mux
}

func (f *notificationFixture) request(method,path string,tokens *userAuthTokens,key string,body any) *httptest.ResponseRecorder {
	var payload []byte
	if body!=nil {payload,_=json.Marshal(body)}
	request := httptest.NewRequest(method,path,strings.NewReader(string(payload)))
	if tokens!=nil {request.Header.Set("Authorization","Bearer "+tokens.AccessToken)}
	if key!="" {request.Header.Set("Idempotency-Key",key)}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response,request)
	return response
}

func notificationStatus(t *testing.T,out *httptest.ResponseRecorder,want int) {
	t.Helper()
	if out.Code!=want || out.Header().Get("Cache-Control")!="no-store" {
		t.Fatalf("status=%d want=%d cache=%q body=%s",out.Code,want,out.Header().Get("Cache-Control"),out.Body)
	}
}

func (f *notificationFixture) list(t *testing.T,tokens *userAuthTokens) notificationPage {
	t.Helper()
	out:=f.request("GET","/v1/user/notifications",tokens,"",nil)
	notificationStatus(t,out,200)
	var page notificationPage
	if err:=json.Unmarshal(out.Body.Bytes(),&page);err!=nil {t.Fatal(err)}
	if page.Address!=tokens.Session.Address || page.ChainID!=tokens.Session.ChainID || len(page.Notifications)>100 {
		t.Fatal("principal or page bounds mismatch")
	}
	return page
}

func notificationItem(t *testing.T,page notificationPage,source string) inboxNotification {
	t.Helper()
	for _,item:=range page.Notifications {if item.SourceKey==source {return item}}
	t.Fatalf("source %s missing from %d notices",source,len(page.Notifications))
	return inboxNotification{}
}

func (f *notificationFixture) event(t *testing.T,address string,index uint32) (string,string) {
	t.Helper()
	random,err:=userRandomToken(32)
	if err!=nil {t.Fatal(err)}
	hash:="0x"+random
	f.txs=append(f.txs,hash)
	payload,_:=json.Marshal(map[string]string{"from":address,"to":"0x"+strings.Repeat("f",40),"privateFixture":"must-not-leak"})
	sum:=sha256.Sum256(payload)
	if _,err:=f.db.Exec(`INSERT INTO chain_events
		(chain_id,transaction_hash,log_index,contract_address,block_number,block_hash,event_name,payload,payload_hash,confirmed,removed,confirmations)
		VALUES (?,?,?,?,?,?,?,?,?,FALSE,FALSE,0)`,
		hoodiChainID,hash,index,"0x"+strings.Repeat("a",40),73,"0x"+strings.Repeat("b",64),"Transfer",payload,sum[:]);err!=nil {t.Fatal(err)}
	return hash,portfolioEventID(hoodiChainID,hash,index)
}

func (f *notificationFixture) mark(tokens *userAuthTokens,key string,item inboxNotification) *httptest.ResponseRecorder {
	return f.request("POST","/v1/user/notifications/read",tokens,key,notificationReadInput{ID:item.ID,ExpectedSourceRevision:item.SourceRevision})
}

func (f *notificationFixture) prefs(tokens *userAuthTokens,key,revision string,transactions,system bool) *httptest.ResponseRecorder {
	return f.request("PUT","/v1/user/notification-preferences",tokens,key,notificationPreferenceInput{
		Revision:revision,TransactionAlerts:&transactions,SystemMessageAlerts:&system})
}

func TestMySQLNotifications(t *testing.T) {
	t.Run("owner-chain-full-identity-legacy-and-restart",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		hash,source:=f.event(t,f.owner.Session.Address,^uint32(0))
		_,otherSource:=f.event(t,f.other.Session.Address,0)
		id,_:=userRandomToken(16)
		if _,err:=f.db.Exec("INSERT INTO notifications(notification_id,owner_address,notification_type,payload) VALUES (?,?,?,?)",
			id,f.owner.Session.Address,"legacy",`{"privateLegacy":"must-not-leak"}`);err!=nil {t.Fatal(err)}
		item:=notificationItem(t,f.list(t,f.owner),source)
		if item.Read || item.ReadAt!=nil || item.SourceRevision!="1" || item.State!="pending" || item.Event.LogIndex!=^uint32(0) || !strings.Contains(item.SourceKey,hash) {
			t.Fatal("incorrect canonical first materialization")
		}
		out:=f.request("GET","/v1/user/notifications",f.owner,"",nil)
		for _,private:=range []string{otherSource,"privateFixture","privateLegacy",id} {
			if strings.Contains(out.Body.String(),private) {t.Fatalf("private or legacy projection leaked: %s",private)}
		}
		notificationStatus(t,f.mark(f.other,"other-owner-read-key",item),404)
		notificationStatus(t,f.request("GET","/v1/user/notifications?address="+f.other.Session.Address,f.owner,"",nil),400)
		notificationStatus(t,f.mark(f.owner,"owner-read-stable-key",item),200)
		f.restart()
		after:=notificationItem(t,f.list(t,f.owner),source)
		if after.ID!=item.ID || !after.Read || after.ReadAt==nil {t.Fatal("durable read lost on restart")}
		challenge,err:=f.auth.createChallenge(context.Background(),userChallengeInput{Address:f.owner.Session.Address,ChainID:1,Origin:f.auth.origin})
		if err!=nil {t.Fatal(err)}
		chainOne,err:=f.auth.consumeChallenge(context.Background(),walletAuthProof(challenge))
		if err!=nil {t.Fatal(err)}
		page:=f.list(t,chainOne)
		if page.ChainEventsAvailable {t.Fatal("Hoodi events claimed on another chain")}
		for _,n:=range page.Notifications {if n.SourceKind=="chain_event" {t.Fatal("cross-chain event disclosed")}}
		notificationStatus(t,f.mark(chainOne,"wrong-chain-read-key",item),404)
	})
	t.Run("effective-source-revision-and-stale-idempotency",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		hash,source:=f.event(t,f.owner.Session.Address,0)
		first:=notificationItem(t,f.list(t,f.owner),source)
		*f.now=f.now.Add(123456789*time.Nanosecond)
		out:=f.mark(f.owner,"first-read-replay-key",first)
		notificationStatus(t,out,200)
		var marked notificationPage
		if err:=json.Unmarshal(out.Body.Bytes(),&marked);err!=nil {t.Fatal(err)}
		if got:=notificationItem(t,marked,source);got.ReadAt==nil || !strings.HasSuffix(*got.ReadAt,".123456Z") {t.Fatal("readAt is not microsecond canonical",got.ReadAt)}
		if _,err:=f.db.Exec("UPDATE chain_events SET observed_at=CURRENT_TIMESTAMP(6),confirmations=confirmations+1 WHERE transaction_hash=?",hash);err!=nil {t.Fatal(err)}
		replay:=notificationItem(t,f.list(t,f.owner),source)
		if replay.SourceRevision!="1" || !replay.Read {t.Fatal("no-op event observation changed revision/read state")}
		notificationStatus(t,f.mark(f.owner,"first-read-replay-key",first),200)
		for i,assignment:=range []string{"confirmed=TRUE","removed=TRUE","removed=FALSE","block_number=74","block_hash='0x"+strings.Repeat("c",64)+"'"} {
			if _,err:=f.db.Exec("UPDATE chain_events SET "+assignment+" WHERE transaction_hash=?",hash);err!=nil {t.Fatal(err)}
			current:=notificationItem(t,f.list(t,f.owner),source)
			if current.ID!=first.ID || current.SourceRevision!=fmt.Sprint(i+2) || current.Read || current.ReadAt!=nil {t.Fatal("source change retained stale read or lost identity")}
			notificationStatus(t,f.mark(f.owner,"first-read-replay-key",first),409)
			notificationStatus(t,f.mark(f.owner,fmt.Sprintf("current-read-key-%d",i),current),200)
		}
	})
	t.Run("preference-cas-replay-filter-and-enable",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		_,source:=f.event(t,f.owner.Session.Address,0)
		start:=f.list(t,f.owner)
		if start.Preferences.Revision!="0" || !start.Preferences.TransactionAlerts || !start.Preferences.SystemMessageAlerts {t.Fatal("defaults changed")}
		notificationStatus(t,f.prefs(f.owner,"save-preference-key","0",false,false),200)
		page:=f.list(t,f.owner)
		if len(page.Notifications)!=0 || page.Preferences.Revision!="1" {t.Fatal("disabled preferences not durable")}
		notificationStatus(t,f.prefs(f.owner,"save-preference-key","0",false,false),200)
		notificationStatus(t,f.prefs(f.owner,"other-stale-save-key","0",true,true),409)
		out:=f.prefs(f.owner,"enable-preference-key","1",true,true)
		notificationStatus(t,out,200)
		if err:=json.Unmarshal(out.Body.Bytes(),&page);err!=nil {t.Fatal(err)}
		if notificationItem(t,page,source).SourceRevision!="1" || page.Preferences.Revision!="2" {t.Fatal("enable acknowledgement omitted current source inventory")}
		notificationStatus(t,f.prefs(f.owner,"save-preference-key","0",false,false),409)
		notificationStatus(t,f.prefs(f.owner,"enable-preference-key","1",false,true),409)
		f.restart()
		if f.list(t,f.owner).Preferences.Revision!="2" {t.Fatal("restart lost preferences")}
		if f.list(t,f.other).Preferences.Revision!="0" {t.Fatal("preferences leaked across owners")}
	})
	t.Run("parallel-cas-has-one-winner",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		f.list(t,f.owner)
		start:=make(chan struct{})
		results:=make(chan int,2)
		var workers sync.WaitGroup
		for i:=range 2 {
			workers.Add(1)
			go func(i int){
				defer workers.Done()
				<-start
				results<-f.prefs(f.owner,fmt.Sprintf("concurrent-save-key-%d",i),"0",false,true).Code
			}(i)
		}
		close(start);workers.Wait();close(results)
		success,conflict:=0,0
		for code:=range results {if code==200 {success++} else if code==409 {conflict++} else {t.Fatalf("unexpected concurrent status %d",code)}}
		if success!=1 || conflict!=1 || f.list(t,f.owner).Preferences.Revision!="1" {t.Fatal("preference CAS did not have exactly one winner")}
	})
	t.Run("published-notice-withdrawal-and-republish",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		var revision uint64
		var enabled bool
		var text string
		var updated time.Time
		if err:=f.db.QueryRow("SELECT revision,notice_enabled,notice_text,updated_at FROM platform_configuration WHERE configuration_id=1").Scan(&revision,&enabled,&text,&updated);err!=nil {t.Fatal(err)}
		t.Cleanup(func(){if _,err:=f.db.Exec("UPDATE platform_configuration SET revision=?,notice_enabled=?,notice_text=?,updated_at=? WHERE configuration_id=1",revision,enabled,text,updated);err!=nil {t.Error(err)}})
		set:=func(on bool,message string) {
			t.Helper()
			if _,err:=f.db.Exec("UPDATE platform_configuration SET revision=revision+1,notice_enabled=?,notice_text=? WHERE configuration_id=1",on,message);err!=nil {t.Fatal(err)}
		}
		set(false,"unpublished-private-draft")
		out:=f.request("GET","/v1/user/notifications",f.owner,"",nil)
		notificationStatus(t,out,200)
		if strings.Contains(out.Body.String(),"unpublished-private-draft") {t.Fatal("disabled draft leaked")}
		set(true,"Published service notice")
		item:=notificationItem(t,f.list(t,f.owner),"platform:service_notice")
		notificationStatus(t,f.mark(f.owner,"notice-read-stable-key",item),200)
		set(false,"replacement-private-draft")
		withdrawn:=notificationItem(t,f.list(t,f.owner),"platform:service_notice")
		if withdrawn.ID!=item.ID || withdrawn.Text!=nil || withdrawn.Read || withdrawn.ReadAt!=nil || withdrawn.State!="withdrawn" {t.Fatal("withdrawal retained old content/read state")}
		notificationStatus(t,f.mark(f.owner,"notice-read-stable-key",item),409)
		set(true,"Replacement published notice")
		renewed:=notificationItem(t,f.list(t,f.owner),"platform:service_notice")
		if renewed.ID!=item.ID || renewed.SourceRevision==item.SourceRevision || renewed.Read || renewed.Text==nil || *renewed.Text!="Replacement published notice" {t.Fatal("republish reused stale source")}
	})
	t.Run("full-uint64-revision-and-rollback",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		hash,source:=f.event(t,f.owner.Session.Address,0)
		// The trigger owns monotonic increments. Set its OLD value using a
		// test-only session insert at the maximum before projection exists.
		if _,err:=f.db.Exec("DELETE FROM chain_events WHERE transaction_hash=?",hash);err!=nil {t.Fatal(err)}
		payload,_:=json.Marshal(map[string]string{"owner":f.owner.Session.Address})
		sum:=sha256.Sum256(payload)
		if _,err:=f.db.Exec(`INSERT INTO chain_events(chain_id,transaction_hash,log_index,contract_address,block_number,block_hash,event_name,payload,payload_hash,notification_revision)
			VALUES (?,?,0,?,73,?,'Transfer',?,?,18446744073709551615)`,
			hoodiChainID,hash,"0x"+strings.Repeat("a",40),"0x"+strings.Repeat("b",64),payload,sum[:]);err!=nil {t.Fatal(err)}
		item:=notificationItem(t,f.list(t,f.owner),source)
		if item.SourceRevision!="18446744073709551615" {t.Fatal("revision truncated")}
		notificationStatus(t,f.mark(f.owner,"maximum-read-key",item),200)
		if !notificationItem(t,f.list(t,f.owner),source).Read {t.Fatal("unsigned read revision lost")}
		if _,err:=f.db.Exec("UPDATE chain_events SET removed=TRUE WHERE transaction_hash=?",hash);err==nil {t.Fatal("overflow silently wrapped")}
		if notificationItem(t,f.list(t,f.owner),source).State!="pending" {t.Fatal("overflow partially changed event")}
		_,second:=f.event(t,f.owner.Session.Address,1)
		unread:=notificationItem(t,f.list(t,f.owner),second)
		suffix,_:=userRandomToken(8)
		trigger:="notification_rollback_"+suffix
		query:=fmt.Sprintf("CREATE TRIGGER %s BEFORE UPDATE ON notifications FOR EACH ROW BEGIN IF NEW.notification_id='%s' AND NEW.read_revision IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic acknowledgement failure'; END IF; END",trigger,unread.ID)
		if _,err:=f.db.Exec(query);err!=nil {t.Fatal(err)}
		t.Cleanup(func(){f.db.Exec("DROP TRIGGER IF EXISTS "+trigger)})
		notificationStatus(t,f.mark(f.owner,"rollback-read-key",unread),503)
		if notificationItem(t,f.list(t,f.owner),second).Read {t.Fatal("failed transaction partially marked read")}
		var receipts int
		actor,key:=sha256.Sum256([]byte(f.owner.Session.Address)),sha256.Sum256([]byte("rollback-read-key"))
		if err:=f.db.QueryRow("SELECT COUNT(*) FROM administration_requests WHERE actor_hash=? AND key_hash=?",actor[:],key[:]).Scan(&receipts);err!=nil || receipts!=0 {t.Fatal("failed transaction retained receipt",err)}
	})
	t.Run("expired-revoked-and-rebound-session",func(t *testing.T){
		f:=notificationIntegrationFixture(t)
		_,source:=f.event(t,f.owner.Session.Address,0)
		item:=notificationItem(t,f.list(t,f.owner),source)
		if _,err:=f.db.Exec("UPDATE wallet_user_sessions SET origin='https://other.test' WHERE session_id=?",f.owner.Session.ID);err!=nil {t.Fatal(err)}
		notificationStatus(t,f.mark(f.owner,"rebound-session-key",item),401)
		if _,err:=f.db.Exec("UPDATE wallet_user_sessions SET origin=? WHERE session_id=?",f.auth.origin,f.owner.Session.ID);err!=nil {t.Fatal(err)}
		*f.now=f.now.Add(userAccessLifetime)
		notificationStatus(t,f.mark(f.owner,"expired-session-key",item),401)
		*f.now=f.now.Add(-userAccessLifetime)
		if err:=f.auth.revokeUserSession(context.Background(),f.owner.Session.ID,"");err!=nil {t.Fatal(err)}
		notificationStatus(t,f.request("GET","/v1/user/notifications",f.owner,"",nil),401)
	})
}
