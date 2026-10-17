package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"time"
)

// The fixed installer supplies this actual Wallet/source adapter. Methods must
// authenticate the current caller/peer, preserve its full task principal and
// grant/TTL/revocation rules, and honor ctx without reacquiring a held grant.
// ReadPrincipalObservation is READ-ONLY: verify the actual principal reservation
// and original operation result, plus canonical registration/bounded rollback
// where applicable. A fixture, grant reserve, user flag or ArtFi row is not that
// evidence. These normalized Go types are NOT an existing Wallet wire API.
type PrincipalFundsJournalAuthority interface {
	AuthorizeJournal(context.Context, PrincipalFundsBinding, string) error
	ReadPrincipalObservation(context.Context, PrincipalFundsBinding, PrincipalFundsRecord) (PrincipalFundsVerifiedObservation, error)
}

type PrincipalFundsVerifiedObservation struct {
	Observation PrincipalFundsObservation
	// No later than the actual authority/lease expiry. This validity never
	// creates or extends a grant. The journal additionally bounds its work.
	ValidUntilMs int64
}

type PrincipalFundsJournalConfig struct {
	DB *sql.DB
	Authority PrincipalFundsJournalAuthority
	Now func() time.Time
}

type PrincipalFundsJournal struct {
	db *sql.DB
	authority PrincipalFundsJournalAuthority
	now func() time.Time
}

type PrincipalFundsHistory struct {
	Records []PrincipalFundsRecord
	AfterRevision uint64
	NextRevision uint64
	SnapshotRevision uint64
	More bool
}

func NewPrincipalFundsJournal(config PrincipalFundsJournalConfig) (*PrincipalFundsJournal, error) {
	if config.DB == nil || config.Authority == nil { return nil, errPrincipalJournalUnavailable }
	v := reflect.ValueOf(config.Authority)
	if (v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface || v.Kind() == reflect.Map || v.Kind() == reflect.Func || v.Kind() == reflect.Slice || v.Kind() == reflect.Chan) && v.IsNil() { return nil, errPrincipalJournalUnavailable }
	now := config.Now
	if now == nil { now = time.Now }
	return &PrincipalFundsJournal{db: config.DB, authority: config.Authority, now: now}, nil
}

func (j *PrincipalFundsJournal) available() bool {
	return j != nil && j.db != nil && j.authority != nil && j.now != nil
}

func validPrincipalRecord(record PrincipalFundsRecord) bool {
	return record.Schema == "artfi-principal-observation/1" && validPrincipalBinding(record.Binding) && record.Revision > 0 && record.CreatedAtMs >= 0 && record.UpdatedAtMs >= record.CreatedAtMs && validPrincipalObservation(record.Binding, record.Observation)
}

// LONGTEXT keeps the server's exact canonical JSON bytes. Re-encoding rejects
// unknown/duplicate/aliased fields, alternate JSON forms and malformed records;
// the separate SQL key and revision must agree with the encoded record too.
func decodePrincipalRecord(raw []byte, id string, revision uint64) (PrincipalFundsRecord, error) {
	var record PrincipalFundsRecord
	if len(raw) == 0 || len(raw) > 16384 || json.Unmarshal(raw, &record) != nil || record.Binding.OperationID != id || record.Revision != revision || !validPrincipalRecord(record) { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	canonical, err := json.Marshal(record)
	if err != nil || !bytes.Equal(raw, canonical) { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	return record, nil
}

func scanPrincipalRecord(row *sql.Row, id string) (PrincipalFundsRecord, error) {
	var revision uint64
	var raw []byte
	if err := row.Scan(&revision, &raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) { return PrincipalFundsRecord{}, errPrincipalJournalMissing }
		return PrincipalFundsRecord{}, errPrincipalJournalUnavailable
	}
	return decodePrincipalRecord(raw, id, revision)
}

func (j *PrincipalFundsJournal) authorize(ctx context.Context, binding PrincipalFundsBinding, action string) error {
	if !j.available() { return errPrincipalJournalUnavailable }
	if !validPrincipalBinding(binding) || ctx.Err() != nil { return errPrincipalJournalRefused }
	if j.authority.AuthorizeJournal(ctx, binding, action) != nil || ctx.Err() != nil { return errPrincipalJournalRefused }
	return nil
}

func (j *PrincipalFundsJournal) Get(ctx context.Context, binding PrincipalFundsBinding) (PrincipalFundsRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := j.authorize(ctx, binding, "read"); err != nil { return PrincipalFundsRecord{}, err }
	record, err := scanPrincipalRecord(j.db.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=?`, binding.OperationID), binding.OperationID)
	if err != nil { return PrincipalFundsRecord{}, err }
	if record.Binding != binding { return PrincipalFundsRecord{}, errPrincipalJournalConflict }
	return record, nil
}

// History is a bounded append-only read. Its high-water revision comes from
// the current row; concurrent later commits cannot be mixed into this page.
// Cursors/revisions stay uint64 in this internal Go API, never lossy JSON numbers.
func (j *PrincipalFundsJournal) History(ctx context.Context, binding PrincipalFundsBinding, afterRevision uint64, limit int) (PrincipalFundsHistory, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if limit < 1 || limit > 100 { return PrincipalFundsHistory{}, errPrincipalJournalRefused }
	if err := j.authorize(ctx, binding, "history"); err != nil { return PrincipalFundsHistory{}, err }
	current, err := scanPrincipalRecord(j.db.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=?`, binding.OperationID), binding.OperationID)
	if err != nil { return PrincipalFundsHistory{}, err }
	if current.Binding != binding || afterRevision > current.Revision { return PrincipalFundsHistory{}, errPrincipalJournalConflict }
	rows, err := j.db.QueryContext(ctx, `SELECT revision,event_json FROM whole_receipt_principal_observation_events WHERE operation_id=? AND revision>? AND revision<=? ORDER BY revision ASC LIMIT ?`, binding.OperationID, afterRevision, current.Revision, limit+1)
	if err != nil { return PrincipalFundsHistory{}, errPrincipalJournalUnavailable }
	defer rows.Close()
	result := PrincipalFundsHistory{Records: []PrincipalFundsRecord{}, AfterRevision: afterRevision, NextRevision: afterRevision, SnapshotRevision: current.Revision}
	expected := afterRevision
	for rows.Next() {
		var revision uint64
		var raw []byte
		if rows.Scan(&revision,&raw) != nil { return PrincipalFundsHistory{}, errPrincipalJournalUnavailable }
		if expected == ^uint64(0) || revision != expected+1 { return PrincipalFundsHistory{}, errPrincipalJournalRefused }
		record, err := decodePrincipalRecord(raw,binding.OperationID,revision)
		if err != nil { return PrincipalFundsHistory{}, err }
		if record.Binding != binding || revision == current.Revision && record != current { return PrincipalFundsHistory{}, errPrincipalJournalRefused }
		expected = revision
		if len(result.Records) == limit { result.More = true; continue }
		result.Records = append(result.Records,record)
		result.NextRevision = revision
	}
	if rows.Err() != nil { return PrincipalFundsHistory{}, errPrincipalJournalUnavailable }
	if !result.More && expected != current.Revision { return PrincipalFundsHistory{}, errPrincipalJournalRefused }
	return result,nil
}

// Prepare creates metadata only. It never marks money frozen, reserves a grant,
// asks for a payment or invokes a Wallet action. An identical prepare is safe
// after a lost response; changed terms cannot adopt the same operation ID.
func (j *PrincipalFundsJournal) Prepare(ctx context.Context, binding PrincipalFundsBinding) (PrincipalFundsRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := j.authorize(ctx, binding, "prepare"); err != nil { return PrincipalFundsRecord{}, err }
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	defer func() { _ = tx.Rollback() }()
	current, readErr := scanPrincipalRecord(tx.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=? FOR UPDATE`, binding.OperationID), binding.OperationID)
	if readErr == nil {
		if current.Binding != binding { return PrincipalFundsRecord{}, errPrincipalJournalConflict }
		return current, nil
	}
	if !errors.Is(readErr, errPrincipalJournalMissing) { return PrincipalFundsRecord{}, readErr }
	now := j.now().UTC().UnixMilli()
	if now < 0 { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	record := PrincipalFundsRecord{Schema: "artfi-principal-observation/1", Binding: binding, Observation: PrincipalFundsObservation{Phase: "prepared"}, Revision: 1, CreatedAtMs: now, UpdatedAtMs: now}
	raw, err := json.Marshal(record)
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	if _, err = tx.ExecContext(ctx, `INSERT INTO whole_receipt_principal_observations(operation_id,revision,record_json) VALUES(?,1,?)`, binding.OperationID, string(raw)); err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	if _, err = tx.ExecContext(ctx, `INSERT INTO whole_receipt_principal_observation_events(operation_id,revision,event_json) VALUES(?,1,?)`, binding.OperationID, string(raw)); err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	if ctx.Err() != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	if err = tx.Commit(); err != nil { return PrincipalFundsRecord{}, errPrincipalJournalOutcomeUnknown }
	return record, nil
}

// Refresh records an authority-verified observation, not a requested financial
// action. The caller supplies no status, reservation or proof. Source reads
// happen before the SQL lock; CAS rejects a stale source read across processes.
func (j *PrincipalFundsJournal) Refresh(ctx context.Context, binding PrincipalFundsBinding, expectedRevision uint64) (PrincipalFundsRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := j.authorize(ctx, binding, "observe"); err != nil { return PrincipalFundsRecord{}, err }
	before, err := scanPrincipalRecord(j.db.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=?`, binding.OperationID), binding.OperationID)
	if err != nil { return PrincipalFundsRecord{}, err }
	if before.Binding != binding || before.Revision != expectedRevision { return PrincipalFundsRecord{}, errPrincipalJournalConflict }
	verified, err := j.authority.ReadPrincipalObservation(ctx, binding, before)
	if err != nil || ctx.Err() != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	validAt := func() bool {
		now := j.now().UTC().UnixMilli()
		return ctx.Err() == nil && verified.ValidUntilMs > now && verified.ValidUntilMs-now <= NFTTaskCapabilityMaxLifetime.Milliseconds()
	}
	if !validAt() { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	defer func() { _ = tx.Rollback() }()
	current, err := scanPrincipalRecord(tx.QueryRowContext(ctx, `SELECT revision,record_json FROM whole_receipt_principal_observations WHERE operation_id=? FOR UPDATE`, binding.OperationID), binding.OperationID)
	if err != nil { return PrincipalFundsRecord{}, err }
	if current != before { return PrincipalFundsRecord{}, errPrincipalJournalConflict }
	if !validAt() { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	next, write, err := nextPrincipalObservation(current, verified.Observation, j.now().UTC().UnixMilli())
	if err != nil || !write { return next, err }
	raw, err := json.Marshal(next)
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	result, err := tx.ExecContext(ctx, `UPDATE whole_receipt_principal_observations SET revision=?,record_json=? WHERE operation_id=? AND revision=?`, next.Revision, string(raw), binding.OperationID, expectedRevision)
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	count, err := result.RowsAffected()
	if err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	if count != 1 { return PrincipalFundsRecord{}, errPrincipalJournalConflict }
	if _, err = tx.ExecContext(ctx, `INSERT INTO whole_receipt_principal_observation_events(operation_id,revision,event_json) VALUES(?,?,?)`, binding.OperationID, next.Revision, string(raw)); err != nil { return PrincipalFundsRecord{}, errPrincipalJournalUnavailable }
	if !validAt() { return PrincipalFundsRecord{}, errPrincipalJournalRefused }
	if err = tx.Commit(); err != nil { return PrincipalFundsRecord{}, errPrincipalJournalOutcomeUnknown }
	return next, nil
}
