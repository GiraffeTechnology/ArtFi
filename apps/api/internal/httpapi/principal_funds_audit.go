package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const principalAuditMaximumEvents = 256

var errPrincipalAuditLimit = errors.New("PRINCIPAL_JOURNAL_AUDIT_LIMIT")

// PrincipalFundsAuditReport describes database history consistency only. It is
// neither fresh Wallet/source evidence nor financial or property authority.
// It deliberately omits the principal, reservation references and source proof.
type PrincipalFundsAuditReport struct {
	OperationID string
	Revision    uint64
	EventCount  int
	CreatedAtMs int64
	UpdatedAtMs int64
}

func auditPrincipalHistory(current PrincipalFundsRecord, events []PrincipalFundsRecord) (PrincipalFundsAuditReport, error) {
	if !validPrincipalRecord(current) || len(events) == 0 || len(events) > principalAuditMaximumEvents {
		return PrincipalFundsAuditReport{}, errPrincipalJournalRefused
	}
	if uint64(len(events)) != current.Revision {
		return PrincipalFundsAuditReport{}, errPrincipalJournalConflict
	}
	first := events[0]
	if !validPrincipalRecord(first) || first.Binding != current.Binding || first.Revision != 1 || first.Observation != (PrincipalFundsObservation{Phase: "prepared"}) || first.CreatedAtMs != first.UpdatedAtMs {
		return PrincipalFundsAuditReport{}, errPrincipalJournalRefused
	}
	previous := first
	for _, event := range events[1:] {
		if !validPrincipalRecord(event) || event.Binding != current.Binding || event.CreatedAtMs != first.CreatedAtMs || event.Revision != previous.Revision+1 {
			return PrincipalFundsAuditReport{}, errPrincipalJournalRefused
		}
		calculated, changed, err := nextPrincipalObservation(previous, event.Observation, event.UpdatedAtMs)
		if err != nil || !changed || calculated != event {
			return PrincipalFundsAuditReport{}, errPrincipalJournalRefused
		}
		previous = event
	}
	if previous != current {
		return PrincipalFundsAuditReport{}, errPrincipalJournalConflict
	}
	return PrincipalFundsAuditReport{OperationID: current.Binding.OperationID, Revision: current.Revision, EventCount: len(events), CreatedAtMs: first.CreatedAtMs, UpdatedAtMs: current.UpdatedAtMs}, nil
}

// Audit reads one existing operation and its complete bounded event history in
// one repeatable-read, read-only transaction. It never repairs, deletes, retries
// or dispatches anything. The fixed authority must explicitly authorize "audit"
// for the current caller and original binding; ordinary "read" is not promoted.
func (j *PrincipalFundsJournal) Audit(ctx context.Context, binding PrincipalFundsBinding, limit int) (PrincipalFundsAuditReport, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if limit < 1 || limit > principalAuditMaximumEvents {
		return PrincipalFundsAuditReport{}, errPrincipalJournalRefused
	}
	if err := j.authorize(ctx, binding, "audit"); err != nil {
		return PrincipalFundsAuditReport{}, err
	}
	tx, err := j.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return PrincipalFundsAuditReport{}, errPrincipalJournalUnavailable
	}
	defer func() { _ = tx.Rollback() }()
	current, err := scanPrincipalRecord(tx.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=?`, binding.OperationID), binding.OperationID)
	if err != nil {
		return PrincipalFundsAuditReport{}, err
	}
	if current.Binding != binding {
		return PrincipalFundsAuditReport{}, errPrincipalJournalConflict
	}
	// An incomplete history is never reported as a successful whole audit.
	if current.Revision > uint64(limit) {
		return PrincipalFundsAuditReport{}, errPrincipalAuditLimit
	}
	rows, err := tx.QueryContext(ctx, `SELECT revision,event_json FROM whole_receipt_principal_observation_events WHERE operation_id=? ORDER BY revision ASC LIMIT ?`, binding.OperationID, limit+1)
	if err != nil {
		return PrincipalFundsAuditReport{}, errPrincipalJournalUnavailable
	}
	defer rows.Close()
	events := make([]PrincipalFundsRecord, 0, int(current.Revision))
	for rows.Next() {
		var revision uint64
		var raw []byte
		if rows.Scan(&revision, &raw) != nil {
			return PrincipalFundsAuditReport{}, errPrincipalJournalUnavailable
		}
		if len(events) == limit {
			return PrincipalFundsAuditReport{}, errPrincipalAuditLimit
		}
		record, err := decodePrincipalRecord(raw, binding.OperationID, revision)
		if err != nil {
			return PrincipalFundsAuditReport{}, err
		}
		events = append(events, record)
	}
	if rows.Err() != nil || rows.Close() != nil || ctx.Err() != nil {
		return PrincipalFundsAuditReport{}, errPrincipalJournalUnavailable
	}
	report, err := auditPrincipalHistory(current, events)
	if err != nil {
		return PrincipalFundsAuditReport{}, err
	}
	// A failed read-only transaction does not change a financial outcome. No
	// partial report is returned, and no automatic repair or retry is attempted.
	if tx.Commit() != nil || ctx.Err() != nil {
		return PrincipalFundsAuditReport{}, errPrincipalJournalUnavailable
	}
	return report, nil
}
