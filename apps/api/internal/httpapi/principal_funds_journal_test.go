package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Every source, address, digest and reservation below is synthetic. This fake
// is not a Wallet reservation service or approved Oracle installation.
func syntheticPrincipalBinding() PrincipalFundsBinding {
	a := func(c string) string { return "0x" + strings.Repeat(c, 40) }
	h := func(c string) string { return "0x" + strings.Repeat(c, 64) }
	return PrincipalFundsBinding{OperationID: "synthetic-principal-operation-0001", Principal: syntheticNFTTaskPrincipal(), ChainID: 560048, Buyer: a("1"), Seller: a("2"), Collection: a("3"), TokenID: "0", PaymentToken: zeroAddress, Amount: "12345", PlanDigest: h("4"), JournalBindingHash: h("5"), SegmentID: h("6"), AssetRecordHash: h("7"), SourceID: "synthetic-source", OracleContract: a("8"), OracleRuntimeCodeHash: h("9"), RegisterID: h("a"), SourceAuthority: a("b"), MintPolicyHash: h("c"), RegistrationDeadline: "2000"}
}

func syntheticPrincipalPrepared() PrincipalFundsRecord {
	return PrincipalFundsRecord{Schema: "artfi-principal-observation/1", Binding: syntheticPrincipalBinding(), Observation: PrincipalFundsObservation{Phase: "prepared"}, Revision: 1, CreatedAtMs: 1000, UpdatedAtMs: 1000}
}

func syntheticPrincipalFrozen() PrincipalFundsObservation {
	return PrincipalFundsObservation{Phase: "frozen", FreezeOperation: "synthetic-wallet-freeze-1", Reservation: "synthetic-principal-reservation-1", ReservationKind: "PRINCIPAL_FUNDS", WalletEvidence: "synthetic-wallet-evidence-frozen", OutcomeAction: "freeze", ActionOutcome: "APPLIED"}
}

func syntheticPrincipalRelease() PrincipalFundsObservation {
	b := syntheticPrincipalBinding()
	o := syntheticPrincipalFrozen()
	o.Phase, o.PendingAction, o.ReleaseOperation = "release-pending", "release", "synthetic-wallet-release-1"
	o.OutcomeAction, o.ActionOutcome = "release", "PENDING"
	o.Registration = PrincipalRegistrationObservation{SegmentID: b.SegmentID, Version: "2", Holder: b.Buyer, EffectiveAt: "1900", RecordCommitment: "0x"+strings.Repeat("d",64), ReceiptDocumentHash: "0x"+strings.Repeat("e",64), BlockHash: "0x"+strings.Repeat("f",64)}
	return o
}

func syntheticPrincipalRefund() PrincipalFundsObservation {
	b := syntheticPrincipalBinding()
	o := syntheticPrincipalFrozen()
	o.Phase, o.PendingAction, o.RefundOperation = "refund-pending", "refund", "synthetic-wallet-refund-1"
	o.OutcomeAction, o.ActionOutcome = "refund", "PENDING"
	o.Rollback = PrincipalRollbackObservation{Reference: "synthetic-bounded-rollback-1", SegmentID: b.SegmentID, Holder: b.Seller, Owner: b.Seller, BlockHash: "0x"+strings.Repeat("d",64)}
	return o
}

func principalAdvance(t *testing.T, current PrincipalFundsRecord, next PrincipalFundsObservation) PrincipalFundsRecord {
	t.Helper()
	updated, write, err := nextPrincipalObservation(current, next, current.UpdatedAtMs+1)
	if err != nil || !write || updated.Revision != current.Revision+1 || updated.Binding != current.Binding { t.Fatalf("observation advance: write=%v err=%v",write,err) }
	return updated
}

func TestPrincipalFundsPrepareIsNotFrozenAndIdentityBounds(t *testing.T) {
	r := syntheticPrincipalPrepared()
	if !validPrincipalRecord(r) || r.Observation.Reservation != "" || r.Observation.ReservationKind != "" { t.Fatal("prepared metadata became a reservation") }
	for name, mutate := range map[string]func(*PrincipalFundsBinding){
		"zero amount": func(b *PrincipalFundsBinding) { b.Amount="0" },
		"overflow amount": func(b *PrincipalFundsBinding) { b.Amount="1"+strings.Repeat("0",78) },
		"leading zero": func(b *PrincipalFundsBinding) { b.Amount="01" },
		"signed amount": func(b *PrincipalFundsBinding) { b.Amount="+1" },
		"unknown chain": func(b *PrincipalFundsBinding) { b.ChainID=1 },
		"same parties": func(b *PrincipalFundsBinding) { b.Seller=b.Buyer },
		"zero source": func(b *PrincipalFundsBinding) { b.SourceAuthority=zeroAddress },
		"zero digest": func(b *PrincipalFundsBinding) { b.AssetRecordHash=zeroHash },
		"deadline overflow": func(b *PrincipalFundsBinding) { b.RegistrationDeadline="18446744073709551616" },
		"principal overflow": func(b *PrincipalFundsBinding) { b.Principal.GrantPolicyVersion="9"+strings.Repeat("0",77) },
	} {
		t.Run(name,func(t *testing.T) { b:=r.Binding;mutate(&b);if validPrincipalBinding(b) { t.Fatal("invalid immutable binding accepted") } })
	}
}

func TestPrincipalFundsRegistrationReleasesOnlyOriginalReservation(t *testing.T) {
	r := principalAdvance(t,syntheticPrincipalPrepared(),syntheticPrincipalFrozen())
	r = principalAdvance(t,r,syntheticPrincipalRelease())
	next:=r.Observation;next.Phase,next.PendingAction,next.ActionOutcome="released","","APPLIED"
	// Processing after the mint deadline is allowed only because the exact
	// source entry was effective before that deadline. No new payment is made.
	settled,write,err:=nextPrincipalObservation(r,next,3_000_000)
	if err!=nil || !write || settled.Observation.Reservation!=r.Observation.Reservation { t.Fatal("original reservation release refused or changed") }
	if _,write,err:=nextPrincipalObservation(settled,settled.Observation,settled.UpdatedAtMs+1);err!=nil || write { t.Fatal("terminal idempotent read changed history") }
	for _, bad:=range []PrincipalFundsObservation{syntheticPrincipalFrozen(),syntheticPrincipalRefund()} {
		if _,_,err:=nextPrincipalObservation(settled,bad,settled.UpdatedAtMs+1);err==nil { t.Fatal("settled prefix was reopened or refunded") }
	}
}

func TestPrincipalFundsRejectsLateWrongOrIncompleteRegistration(t *testing.T) {
	r:=principalAdvance(t,syntheticPrincipalPrepared(),syntheticPrincipalFrozen())
	for name,mutate:=range map[string]func(*PrincipalFundsObservation){
		"late":func(o *PrincipalFundsObservation){o.Registration.EffectiveAt="2001"},
		"wrong holder":func(o *PrincipalFundsObservation){o.Registration.Holder=r.Binding.Seller},
		"wrong segment":func(o *PrincipalFundsObservation){o.Registration.SegmentID=r.Binding.PlanDigest},
		"initial version":func(o *PrincipalFundsObservation){o.Registration.Version="1"},
		"missing receipt":func(o *PrincipalFundsObservation){o.Registration.ReceiptDocumentHash=zeroHash},
		"new reservation":func(o *PrincipalFundsObservation){o.Reservation="synthetic-different-reservation"},
		"grant instead of funds":func(o *PrincipalFundsObservation){o.Reservation=r.Binding.Principal.GrantReference},
	} {
		t.Run(name,func(t *testing.T){o:=syntheticPrincipalRelease();mutate(&o);if _,_,err:=nextPrincipalObservation(r,o,r.UpdatedAtMs+1);err==nil {t.Fatal("registration/release binding accepted")}})
	}
}

func TestPrincipalFundsUnknownMustReconcileOriginalPendingAction(t *testing.T) {
	r:=syntheticPrincipalPrepared()
	pending:=syntheticPrincipalFrozen();pending.Phase,pending.PendingAction,pending.ActionOutcome="freeze-pending","freeze","PENDING";pending.Reservation,pending.ReservationKind="",""
	r=principalAdvance(t,r,pending)
	unknown:=pending;unknown.Phase,unknown.ActionOutcome="unknown","UNKNOWN";r=principalAdvance(t,r,unknown)
	for _,bad:=range []PrincipalFundsObservation{pending,syntheticPrincipalFrozen(),syntheticPrincipalRelease(),syntheticPrincipalRefund()} {
		if _,_,err:=nextPrincipalObservation(r,bad,r.UpdatedAtMs+1);err==nil {t.Fatal("UNKNOWN permitted replay or unreconciled advance")}
	}
	reconciled:=syntheticPrincipalFrozen();reconciled.ReconcilesUnknown=true
	r=principalAdvance(t,r,reconciled)
	stable:=r.Observation;stable.ReconcilesUnknown=false
	if same,write,err:=nextPrincipalObservation(r,stable,r.UpdatedAtMs+1);err!=nil || write || same!=r {t.Fatal("stable reconciled result rewrote its historical transition marker")}
	r=principalAdvance(t,r,syntheticPrincipalRelease())
	unknown=r.Observation;unknown.Phase,unknown.ActionOutcome="unknown","UNKNOWN";r=principalAdvance(t,r,unknown)
	refund:=syntheticPrincipalRefund();refund.ReconcilesUnknown=true
	if _,_,err:=nextPrincipalObservation(r,refund,r.UpdatedAtMs+1);err==nil {t.Fatal("unknown release switched to refund")}
	confirmed:=r.Observation;confirmed.Phase,confirmed.PendingAction,confirmed.ReconcilesUnknown,confirmed.ActionOutcome="released","",true,"APPLIED"
	_ = principalAdvance(t,r,confirmed)
}

func TestPrincipalFundsRollbackPreservesSettledPrefixAndCurrentHolder(t *testing.T) {
	r:=principalAdvance(t,syntheticPrincipalPrepared(),syntheticPrincipalFrozen())
	bad:=syntheticPrincipalRefund();bad.Rollback.Owner=r.Binding.Buyer
	if _,_,err:=nextPrincipalObservation(r,bad,r.UpdatedAtMs+1);err==nil {t.Fatal("rollback owner differs from current valid holder")}
	r=principalAdvance(t,r,syntheticPrincipalRefund())
	refunded:=r.Observation;refunded.Phase,refunded.PendingAction,refunded.ActionOutcome="refunded","","APPLIED"
	r=principalAdvance(t,r,refunded)
	if _,_,err:=nextPrincipalObservation(r,syntheticPrincipalRelease(),r.UpdatedAtMs+1);err==nil {t.Fatal("refund was changed into release")}
	r=principalAdvance(t,syntheticPrincipalPrepared(),syntheticPrincipalFrozen())
	r=principalAdvance(t,r,syntheticPrincipalRelease())
	failedRelease:=r.Observation;failedRelease.Phase,failedRelease.PendingAction,failedRelease.ActionOutcome="frozen","","NOT_APPLIED"
	r=principalAdvance(t,r,failedRelease)
	bad=syntheticPrincipalRefund();bad.ReleaseOperation=r.Observation.ReleaseOperation;bad.Registration=r.Observation.Registration
	if _,_,err:=nextPrincipalObservation(r,bad,r.UpdatedAtMs+1);err==nil {t.Fatal("completed holder registration was rolled back")}
}

func TestPrincipalFundsObserverCatchesUpWithoutReplayingActions(t *testing.T) {
	for _,o:=range []PrincipalFundsObservation{syntheticPrincipalFrozen(),func()PrincipalFundsObservation{o:=syntheticPrincipalRelease();o.Phase,o.PendingAction,o.ActionOutcome="released","","APPLIED";return o}(),func()PrincipalFundsObservation{o:=syntheticPrincipalRefund();o.Phase,o.PendingAction,o.ActionOutcome="refunded","","APPLIED";return o}()} {
		_ = principalAdvance(t,syntheticPrincipalPrepared(),o)
	}
}

func TestPrincipalFundsKnownReservationSurvivesPendingUnknownAndRefusal(t *testing.T) {
	pending:=syntheticPrincipalFrozen();pending.Phase,pending.PendingAction,pending.ActionOutcome="freeze-pending","freeze","PENDING"
	r:=principalAdvance(t,syntheticPrincipalPrepared(),pending)
	if r.Observation.Phase=="frozen" {t.Fatal("allocated reference became frozen money")}
	unknown:=r.Observation;unknown.Phase,unknown.ActionOutcome="unknown","UNKNOWN";r=principalAdvance(t,r,unknown)
	dropped:=r.Observation;dropped.Reservation,dropped.ReservationKind="",""
	if _,_,err:=nextPrincipalObservation(r,dropped,r.UpdatedAtMs+1);err==nil {t.Fatal("known reservation reference disappeared during UNKNOWN")}
	refused:=r.Observation;refused.Phase,refused.PendingAction,refused.ActionOutcome,refused.ReconcilesUnknown="refused","","NOT_APPLIED",true
	r=principalAdvance(t,r,refused)
	if r.Observation.Reservation!=pending.Reservation || r.Observation.Phase!="refused" {t.Fatal("negative outcome lost the original audit reference")}
}

func TestPrincipalFundsFrozenBalanceIsNotProofReleaseWasNotApplied(t *testing.T) {
	r:=principalAdvance(t,syntheticPrincipalPrepared(),syntheticPrincipalFrozen());r=principalAdvance(t,r,syntheticPrincipalRelease())
	balanceOnly:=r.Observation;balanceOnly.Phase,balanceOnly.PendingAction,balanceOnly.OutcomeAction,balanceOnly.ActionOutcome="frozen","","freeze","APPLIED"
	if _,_,err:=nextPrincipalObservation(r,balanceOnly,r.UpdatedAtMs+1);err==nil {t.Fatal("unchanged balance was treated as known release failure")}
	unknown:=r.Observation;unknown.Phase,unknown.ActionOutcome="unknown","UNKNOWN";r=principalAdvance(t,r,unknown)
	balanceOnly.ReconcilesUnknown=true
	if _,_,err:=nextPrincipalObservation(r,balanceOnly,r.UpdatedAtMs+1);err==nil {t.Fatal("UNKNOWN accepted a different operation outcome")}
	notApplied:=r.Observation;notApplied.Phase,notApplied.PendingAction,notApplied.ActionOutcome,notApplied.ReconcilesUnknown="frozen","","NOT_APPLIED",true
	_ = principalAdvance(t,r,notApplied)
}

func TestPrincipalFundsCanonicalRecordRejectsAliasedDuplicateAndUnknownFields(t *testing.T) {
	r:=syntheticPrincipalPrepared();raw,_:=json.Marshal(r)
	if _,err:=decodePrincipalRecord(raw,r.Binding.OperationID,r.Revision);err!=nil {t.Fatal("canonical record refused")}
	for _,bad:=range [][]byte{
		bytes.Replace(raw,[]byte(`"binding":`),[]byte(`"Binding":`),1),
		bytes.Replace(raw,[]byte(`"revision":1`),[]byte(`"revision":1,"revision":1`),1),
		append([]byte(`{"unknown":true,`),raw[1:]...),
		append([]byte(" "),raw...),
		bytes.Repeat([]byte(" "),16385),
	} { if _,err:=decodePrincipalRecord(bad,r.Binding.OperationID,r.Revision);err==nil {t.Fatal("noncanonical storage record accepted")} }
	if _,err:=decodePrincipalRecord(raw,r.Binding.OperationID,r.Revision+1);err==nil {t.Fatal("SQL revision alias accepted")}
	if _,err:=decodePrincipalRecord(raw,"synthetic-foreign-operation",r.Revision);err==nil {t.Fatal("SQL operation alias accepted")}
}

type syntheticPrincipalFundsAuthority struct {
	now func()time.Time
	next PrincipalFundsObservation
	deny bool
	readErr error
	until int64
	barrier func(context.Context)
}
func (a *syntheticPrincipalFundsAuthority) AuthorizeJournal(ctx context.Context,_ PrincipalFundsBinding,_ string)error {
	if a.deny || ctx.Err()!=nil {return errors.New("synthetic-denial")};return nil
}
func (a *syntheticPrincipalFundsAuthority) ReadPrincipalObservation(ctx context.Context,_ PrincipalFundsBinding,_ PrincipalFundsRecord)(PrincipalFundsVerifiedObservation,error) {
	if a.barrier!=nil {a.barrier(ctx)}
	if ctx.Err()!=nil {return PrincipalFundsVerifiedObservation{},ctx.Err()}
	until:=a.until;if until==0 {until=a.now().Add(time.Second).UnixMilli()}
	return PrincipalFundsVerifiedObservation{Observation:a.next,ValidUntilMs:until},a.readErr
}

func TestPrincipalFundsJournalRequiresActualInstalledAuthority(t *testing.T) {
	var typedNil *syntheticPrincipalFundsAuthority
	for _,config:=range []PrincipalFundsJournalConfig{{},{DB:&sql.DB{}},{DB:&sql.DB{},Authority:typedNil}} {
		if _,err:=NewPrincipalFundsJournal(config);err==nil {t.Fatal("missing authority started")}
	}
	var j *PrincipalFundsJournal
	if _,err:=j.Prepare(context.Background(),syntheticPrincipalBinding());!errors.Is(err,errPrincipalJournalUnavailable) {t.Fatal("nil journal accepted prepare")}
}

func principalMySQLFixture(t *testing.T)(*sql.DB,PrincipalFundsBinding,func()time.Time) {
	t.Helper()
	if os.Getenv("ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED")=="1" && os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")=="" {t.Fatal("required principal MySQL run needs the existing isolated integration DSN")}
	db,_,now,address:=walletAuthIntegrationFixture(t)
	if _,err:=db.Exec(`SELECT operation_id FROM whole_receipt_principal_observations LIMIT 0`);err!=nil {
		if os.Getenv("ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED")=="1" {t.Fatal("required principal MySQL run needs migration000017")}
		t.Skip("UNVERIFIED: principal observation SQL requires migration000017")
	}
	b:=syntheticPrincipalBinding();b.OperationID="principal-"+strings.TrimPrefix(address,"0x");b.Buyer=address
	t.Cleanup(func(){
		// Isolated synthetic fixture rows only; production API has no deletion.
		if _,err:=db.Exec(`DELETE FROM whole_receipt_principal_observation_events WHERE operation_id=?`,b.OperationID);err!=nil {t.Error(err)}
		if _,err:=db.Exec(`DELETE FROM whole_receipt_principal_observations WHERE operation_id=?`,b.OperationID);err!=nil {t.Error(err)}
	})
	return db,b,func()time.Time{return *now}
}

func TestMySQLPrincipalFundsJournalCASReconstructionUnknownAndHistory(t *testing.T) {
	db,b,now:=principalMySQLFixture(t);authority:=&syntheticPrincipalFundsAuthority{now:now,next:syntheticPrincipalFrozen()}
	j,err:=NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB:db,Authority:authority,Now:now});if err!=nil {t.Fatal(err)}
	r,err:=j.Prepare(context.Background(),b);if err!=nil || r.Revision!=1 || r.Observation.Reservation!="" {t.Fatalf("prepare %v",err)}
	if duplicate,err:=j.Prepare(context.Background(),b);err!=nil || duplicate!=r {t.Fatal("idempotent prepare changed")}
	changed:=b;changed.Amount="12346";if _,err:=j.Prepare(context.Background(),changed);!errors.Is(err,errPrincipalJournalConflict) {t.Fatal("changed terms adopted original journal")}
	ready:=make(chan struct{});var readers atomic.Int32
	authority.barrier=func(ctx context.Context){if readers.Add(1)==2 {close(ready)};select{case <-ready:case <-ctx.Done():}}
	var wait sync.WaitGroup;out:=make(chan error,2)
	for i:=0;i<2;i++ {wait.Add(1);go func(){defer wait.Done();fresh,_:=NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB:db,Authority:authority,Now:now});_,err:=fresh.Refresh(context.Background(),b,1);out<-err}()}
	wait.Wait();close(out);wins,conflicts:=0,0
	for err:=range out {if err==nil {wins++} else if errors.Is(err,errPrincipalJournalConflict){conflicts++} else {t.Fatalf("CAS error %v",err)}}
	if wins!=1 || conflicts!=1 {t.Fatalf("CAS winners%d conflicts%d",wins,conflicts)}
	authority.barrier=nil
	fresh,_:=NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB:db,Authority:authority,Now:now});r,err=fresh.Get(context.Background(),b);if err!=nil || r.Revision!=2 {t.Fatal("fresh constructor lost state")}
	// Registration belongs to this fixture's synthetic buyer, not a global sample.
	authority.next=syntheticPrincipalRelease();authority.next.Registration.Holder=b.Buyer
	r,err=fresh.Refresh(context.Background(),b,r.Revision);if err!=nil {t.Fatalf("release pending %v",err)}
	authority.next=r.Observation;authority.next.Phase,authority.next.ActionOutcome="unknown","UNKNOWN"
	r,err=fresh.Refresh(context.Background(),b,r.Revision);if err!=nil {t.Fatal(err)}
	authority.readErr=errors.New("synthetic-source-outage")
	if _,err:=fresh.Refresh(context.Background(),b,r.Revision);err==nil {t.Fatal("source outage changed UNKNOWN")}
	check,err:=fresh.Get(context.Background(),b);if err!=nil || check!=r {t.Fatal("UNKNOWN or revision disappeared")}
	authority.readErr=nil;authority.next=r.Observation;authority.next.Phase,authority.next.PendingAction,authority.next.ReconcilesUnknown,authority.next.ActionOutcome="released","",true,"APPLIED"
	r,err=fresh.Refresh(context.Background(),b,r.Revision);if err!=nil {t.Fatal(err)}
	var events int;if err:=db.QueryRow(`SELECT COUNT(*) FROM whole_receipt_principal_observation_events WHERE operation_id=?`,b.OperationID).Scan(&events);err!=nil || uint64(events)!=r.Revision {t.Fatal("CAS and append-only events disagree")}
	page,err:=fresh.History(context.Background(),b,0,2);if err!=nil || len(page.Records)!=2 || !page.More || page.NextRevision!=2 || page.SnapshotRevision!=r.Revision {t.Fatal("bounded history first page invalid")}
	rest,err:=fresh.History(context.Background(),b,page.NextRevision,100);if err!=nil || rest.More || rest.NextRevision!=r.Revision || len(rest.Records)!=int(r.Revision)-2 {t.Fatal("history continuation skipped or repeated events")}
	if _,err:=fresh.History(context.Background(),b,r.Revision+1,2);!errors.Is(err,errPrincipalJournalConflict){t.Fatal("future history cursor accepted")}
	if _,err:=fresh.History(context.Background(),b,0,101);err==nil {t.Fatal("unbounded history accepted")}
	foreign:=b;foreign.Principal.TaskID="synthetic-foreign-task";if _,err:=fresh.Get(context.Background(),foreign);!errors.Is(err,errPrincipalJournalConflict){t.Fatal("foreign principal read adopted row")}
	if _,err:=fresh.History(context.Background(),foreign,0,2);!errors.Is(err,errPrincipalJournalConflict){t.Fatal("foreign principal history adopted row")}
}

func TestMySQLPrincipalFundsJournalExpiryCorruptRowAndForwardOnlyHistory(t *testing.T) {
	db,b,now:=principalMySQLFixture(t);authority:=&syntheticPrincipalFundsAuthority{now:now,next:syntheticPrincipalFrozen()}
	j,_:=NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB:db,Authority:authority,Now:now});r,err:=j.Prepare(context.Background(),b);if err!=nil {t.Fatal(err)}
	for _,until:=range []int64{now().UnixMilli(),now().Add(31*time.Second).UnixMilli()} {
		authority.until=until;if _,err:=j.Refresh(context.Background(),b,r.Revision);err==nil {t.Fatal("expired or overlong observation accepted")}
	}
	authority.until=0;authority.deny=true;if _,err:=j.Refresh(context.Background(),b,r.Revision);err==nil {t.Fatal("revoked journal authority accepted")};authority.deny=false
	raw,_:=json.Marshal(r);bad:=bytes.Replace(raw,[]byte(`"revision":1`),[]byte(`"revision":1,"revision":1`),1)
	if _,err:=db.Exec(`UPDATE whole_receipt_principal_observations SET record_json=? WHERE operation_id=?`,string(bad),b.OperationID);err!=nil {t.Fatal(err)}
	if _,err:=j.Get(context.Background(),b);err==nil {t.Fatal("duplicate JSON field accepted from SQL")}
	if _,err:=db.Exec(`UPDATE whole_receipt_principal_observations SET record_json=? WHERE operation_id=?`,string(raw),b.OperationID);err!=nil {t.Fatal(err)}
	down,err:=os.ReadFile("../../migrations/000017_whole_receipt_principal_observations.down.sql");if err!=nil {t.Fatal(err)}
	_,downErr:=db.Exec(string(down));var refusal *mysql.MySQLError
	if !errors.As(downErr,&refusal) || refusal.Number!=1644 || string(refusal.SQLState[:])!="45000" {t.Fatal("history rollback did not return its deliberate forward-only refusal")}
	if preserved,err:=j.Get(context.Background(),b);err!=nil || preserved!=r {t.Fatal("forward-only refusal destroyed evidence")}
}
