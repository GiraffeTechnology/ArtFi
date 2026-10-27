package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

func syntheticPrincipalHistory(t *testing.T) []PrincipalFundsRecord {
	t.Helper()
	first := syntheticPrincipalPrepared()
	frozen := principalAdvance(t, first, syntheticPrincipalFrozen())
	pending := principalAdvance(t, frozen, syntheticPrincipalRelease())
	unknown := pending.Observation
	unknown.Phase, unknown.ActionOutcome = "unknown", "UNKNOWN"
	uncertain := principalAdvance(t, pending, unknown)
	settled := uncertain.Observation
	settled.Phase, settled.PendingAction, settled.ActionOutcome, settled.ReconcilesUnknown = "released", "", "APPLIED", true
	return []PrincipalFundsRecord{first, frozen, pending, uncertain, principalAdvance(t, uncertain, settled)}
}

func TestPrincipalFundsAuditRequiresCompleteValidTransitionHistory(t *testing.T) {
	events := syntheticPrincipalHistory(t)
	current := events[len(events)-1]
	report, err := auditPrincipalHistory(current, events)
	if err != nil || report.EventCount != len(events) || report.Revision != current.Revision || report.OperationID != current.Binding.OperationID {
		t.Fatalf("complete history audit: %v", err)
	}
	for name, mutate := range map[string]func([]PrincipalFundsRecord) []PrincipalFundsRecord{
		"missing middle":     func(x []PrincipalFundsRecord) []PrincipalFundsRecord { return append(x[:1], x[2:]...) },
		"duplicate revision": func(x []PrincipalFundsRecord) []PrincipalFundsRecord { x[2].Revision = x[1].Revision; return x },
		"reversed events":    func(x []PrincipalFundsRecord) []PrincipalFundsRecord { x[1], x[2] = x[2], x[1]; return x },
		"foreign principal": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			x[1].Binding.Principal.TaskID = "synthetic-foreign-task"
			return x
		},
		"rewritten creation": func(x []PrincipalFundsRecord) []PrincipalFundsRecord { x[1].CreatedAtMs++; return x },
		"backwards clock": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			x[2].UpdatedAtMs = x[1].UpdatedAtMs - 1
			return x
		},
		"not prepared": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			x[0].Observation = syntheticPrincipalFrozen()
			return x
		},
		"terminal reopened": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			o := syntheticPrincipalRelease()
			o.Phase, o.PendingAction, o.ActionOutcome = "released", "", "APPLIED"
			x[1].Observation = o
			return x
		},
		"unreconciled UNKNOWN": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			x[4].Observation.ReconcilesUnknown = false
			return x
		},
		"different final event": func(x []PrincipalFundsRecord) []PrincipalFundsRecord {
			x[4].Observation.WalletEvidence = "synthetic-different-evidence"
			return x
		},
	} {
		t.Run(name, func(t *testing.T) {
			copyEvents := append([]PrincipalFundsRecord(nil), events...)
			if _, err := auditPrincipalHistory(current, mutate(copyEvents)); err == nil {
				t.Fatal("corrupt or incomplete history accepted")
			}
		})
	}
	if _, err := auditPrincipalHistory(current, nil); err == nil {
		t.Fatal("empty history accepted")
	}
	tooMany := make([]PrincipalFundsRecord, principalAuditMaximumEvents+1)
	if _, err := auditPrincipalHistory(current, tooMany); err == nil {
		t.Fatal("unbounded audit accepted")
	}
}

type syntheticAuditDeniedAuthority struct{ action string }

func (a *syntheticAuditDeniedAuthority) AuthorizeJournal(_ context.Context, _ PrincipalFundsBinding, action string) error {
	a.action = action
	return errPrincipalJournalRefused
}

func (*syntheticAuditDeniedAuthority) ReadPrincipalObservation(context.Context, PrincipalFundsBinding, PrincipalFundsRecord) (PrincipalFundsVerifiedObservation, error) {
	panic("read-only SQL audit must not call Wallet/source observation")
}

func TestPrincipalFundsAuditHasExplicitAuthorityAndBounds(t *testing.T) {
	a := &syntheticAuditDeniedAuthority{}
	j, err := NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB: &sql.DB{}, Authority: a})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Audit(context.Background(), syntheticPrincipalBinding(), principalAuditMaximumEvents); !errors.Is(err, errPrincipalJournalRefused) || a.action != "audit" {
		t.Fatal("audit failed to require explicit authority before SQL")
	}
	a.action = ""
	for _, limit := range []int{-1, 0, principalAuditMaximumEvents + 1} {
		if _, err := j.Audit(context.Background(), syntheticPrincipalBinding(), limit); err == nil || a.action != "" {
			t.Fatal("invalid bound reached the authority or database")
		}
	}
	var unavailable *PrincipalFundsJournal
	if _, err := unavailable.Audit(context.Background(), syntheticPrincipalBinding(), 1); !errors.Is(err, errPrincipalJournalUnavailable) {
		t.Fatal("missing journal accepted audit")
	}
}

func TestMySQLPrincipalFundsAuditDetectsCanonicalButImpossibleHistory(t *testing.T) {
	db, b, now := principalMySQLFixture(t)
	a := &syntheticPrincipalFundsAuthority{now: now, next: syntheticPrincipalFrozen()}
	j, err := NewPrincipalFundsJournal(PrincipalFundsJournalConfig{DB: db, Authority: a, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	r, err := j.Prepare(context.Background(), b)
	if err != nil {
		t.Fatal(err)
	}
	r, err = j.Refresh(context.Background(), b, r.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a.next = syntheticPrincipalRelease()
	a.next.Registration.Holder = b.Buyer
	r, err = j.Refresh(context.Background(), b, r.Revision)
	if err != nil {
		t.Fatal(err)
	}
	report, err := j.Audit(context.Background(), b, 10)
	if err != nil || report.Revision != r.Revision || report.EventCount != int(r.Revision) {
		t.Fatal("valid SQL history audit failed")
	}
	if _, err := j.Audit(context.Background(), b, 2); !errors.Is(err, errPrincipalAuditLimit) {
		t.Fatal("truncated SQL history claimed complete audit")
	}
	var raw []byte
	if err := db.QueryRow(`SELECT event_json FROM whole_receipt_principal_observation_events WHERE operation_id=? AND revision=2`, b.OperationID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var original PrincipalFundsRecord
	if json.Unmarshal(raw, &original) != nil {
		t.Fatal("fixture event decode failed")
	}
	changed := original
	changed.Observation = a.next
	changed.Observation.Phase, changed.Observation.PendingAction, changed.Observation.ActionOutcome = "released", "", "APPLIED"
	bad, _ := json.Marshal(changed)
	if _, err := decodePrincipalRecord(bad, b.OperationID, 2); err != nil {
		t.Fatal("fixture must be canonical and individually valid")
	}
	if _, err := db.Exec(`UPDATE whole_receipt_principal_observation_events SET event_json=? WHERE operation_id=? AND revision=2`, string(bad), b.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Audit(context.Background(), b, 10); err == nil {
		t.Fatal("canonical terminal-then-pending history accepted")
	}
	// The audit cannot change even corrupted history or the current row.
	var preserved []byte
	if err := db.QueryRow(`SELECT event_json FROM whole_receipt_principal_observation_events WHERE operation_id=? AND revision=2`, b.OperationID).Scan(&preserved); err != nil || string(preserved) != string(bad) {
		t.Fatal("read-only audit changed evidence")
	}
	if current, err := j.Get(context.Background(), b); err != nil || current != r {
		t.Fatal("audit changed the current row")
	}
	if _, err := db.Exec(`UPDATE whole_receipt_principal_observation_events SET event_json=? WHERE operation_id=? AND revision=2`, string(raw), b.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := j.Audit(context.Background(), b, 10); err != nil {
		t.Fatal("restored fixture history refused")
	}
}
