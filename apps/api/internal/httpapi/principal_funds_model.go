package httpapi

// This is an ArtFi observation model, not a Wallet wire protocol, balance
// ledger, permission to move funds or replacement for the approved source.
import (
	"encoding/json"
	"errors"
	"math/big"
	"strings"
)

var errPrincipalJournalConflict = errors.New("PRINCIPAL_JOURNAL_CONFLICT")
var errPrincipalJournalRefused = errors.New("PRINCIPAL_JOURNAL_REFUSED")
var errPrincipalJournalUnavailable = errors.New("PRINCIPAL_JOURNAL_UNAVAILABLE")
var errPrincipalJournalMissing = errors.New("PRINCIPAL_JOURNAL_MISSING")
var errPrincipalJournalOutcomeUnknown = errors.New("PRINCIPAL_JOURNAL_COMMIT_OUTCOME_UNKNOWN")

// PrincipalFundsBinding is an immutable application-local association. The
// installer must independently match it to the approved catalog/mint terms and
// actual Wallet authority. No browser-selected source or classification flag is
// accepted. Digests retain their original producer's encoding; none is derived
// here or treated as financial authority.
type PrincipalFundsBinding struct {
	OperationID string `json:"operationId"`
	Principal NFTTaskPrincipal `json:"principal"`
	ChainID uint64 `json:"chainId"`
	Buyer string `json:"buyer"`
	Seller string `json:"seller"`
	Collection string `json:"collection"`
	TokenID string `json:"tokenId"`
	PaymentToken string `json:"paymentToken"`
	Amount string `json:"amount"`
	PlanDigest string `json:"planDigest"`
	JournalBindingHash string `json:"journalBindingHash"`
	SegmentID string `json:"segmentId"`
	AssetRecordHash string `json:"assetRecordHash"`
	SourceID string `json:"sourceId"`
	OracleContract string `json:"oracleContract"`
	OracleRuntimeCodeHash string `json:"oracleRuntimeCodeHash"`
	RegisterID string `json:"registerId"`
	SourceAuthority string `json:"sourceAuthority"`
	MintPolicyHash string `json:"mintPolicyHash"`
	RegistrationDeadline string `json:"registrationDeadline"`
}

// Registration is the exact historical entry for this segment, not a claim
// that today's token owner equals the registered holder. Only the installed
// authority can validate canonicality, finality and its source association.
type PrincipalRegistrationObservation struct {
	SegmentID string `json:"segmentId"`
	Version string `json:"version"`
	Holder string `json:"holder"`
	EffectiveAt string `json:"effectiveAt"`
	RecordCommitment string `json:"recordCommitment"`
	ReceiptDocumentHash string `json:"receiptDocumentHash"`
	BlockHash string `json:"blockHash"`
}

// A rollback observation identifies the bounded unresolved suffix and owner
// restoration. Its reference alone is not proof: the installed source adapter
// must verify the scope and preservation of every settled prefix.
type PrincipalRollbackObservation struct {
	Reference string `json:"reference"`
	SegmentID string `json:"segmentId"`
	Holder string `json:"holder"`
	Owner string `json:"owner"`
	BlockHash string `json:"blockHash"`
}

type PrincipalFundsObservation struct {
	Phase string `json:"phase"`
	PendingAction string `json:"pendingAction"`
	FreezeOperation string `json:"freezeOperation"`
	ReleaseOperation string `json:"releaseOperation"`
	RefundOperation string `json:"refundOperation"`
	Reservation string `json:"reservation"`
	ReservationKind string `json:"reservationKind"`
	WalletEvidence string `json:"walletEvidence"`
	OutcomeAction string `json:"outcomeAction"`
	ActionOutcome string `json:"actionOutcome"`
	Registration PrincipalRegistrationObservation `json:"registration"`
	Rollback PrincipalRollbackObservation `json:"rollback"`
	ReconcilesUnknown bool `json:"reconcilesUnknown"`
}

type PrincipalFundsRecord struct {
	Schema string `json:"schema"`
	Binding PrincipalFundsBinding `json:"binding"`
	Observation PrincipalFundsObservation `json:"observation"`
	Revision uint64 `json:"revision"`
	CreatedAtMs int64 `json:"createdAtMs"`
	UpdatedAtMs int64 `json:"updatedAtMs"`
}

func principalAmount(value string, bits int, positive bool) bool {
	if value == "" || len(value) > 78 || (len(value) > 1 && value[0] == '0') || strings.Trim(value, "0123456789") != "" { return false }
	n, ok := new(big.Int).SetString(value, 10)
	return ok && n.Sign() >= 0 && n.BitLen() <= bits && (!positive || n.Sign() > 0)
}

func principalAddress(value string, allowZero bool) bool {
	return len(value) == 42 && value[:2] == "0x" && value == strings.ToLower(value) && strings.Trim(value[2:], "0123456789abcdef") == "" && (allowZero || value != zeroAddress)
}

func principalHash(value string) bool { return nftTaskDigest.MatchString(value) && value != zeroHash }
func principalReference(value string) bool { return nftTaskIdentifier.MatchString(value) }

func validPrincipalBinding(b PrincipalFundsBinding) bool {
	raw, err := json.Marshal(b.Principal)
	var principal NFTTaskPrincipal
	if err != nil || decodeNFTTaskPrincipal(raw, &principal) != nil || principal != b.Principal || principal.TaskDigest == zeroHash || principal.ExecutorDigest == zeroHash || !principalAmount(principal.GrantPolicyVersion, 256, true) { return false }
	return nftOperationID.MatchString(b.OperationID) && (b.ChainID == 31337 || b.ChainID == 560048) &&
		principalAddress(b.Buyer, false) && principalAddress(b.Seller, false) && b.Buyer != b.Seller &&
		principalAddress(b.Collection, false) && principalAddress(b.PaymentToken, true) &&
		principalAmount(b.TokenID, 256, false) && principalAmount(b.Amount, 256, true) &&
		principalHash(b.PlanDigest) && principalHash(b.JournalBindingHash) && principalHash(b.SegmentID) &&
		principalHash(b.AssetRecordHash) && sourceIDPattern.MatchString(b.SourceID) &&
		principalAddress(b.OracleContract, false) && principalAddress(b.SourceAuthority, false) &&
		principalHash(b.OracleRuntimeCodeHash) && principalHash(b.RegisterID) && principalHash(b.MintPolicyHash) &&
		principalAmount(b.RegistrationDeadline, 64, true)
}

func validPrincipalRegistration(b PrincipalFundsBinding, r PrincipalRegistrationObservation) bool {
	if r.SegmentID != b.SegmentID || r.Holder != b.Buyer || !principalAmount(r.Version, 64, true) || !principalAmount(r.EffectiveAt, 64, false) || !principalHash(r.RecordCommitment) || !principalHash(r.ReceiptDocumentHash) || !principalHash(r.BlockHash) { return false }
	version, _ := new(big.Int).SetString(r.Version, 10)
	instant, _ := new(big.Int).SetString(r.EffectiveAt, 10)
	deadline, _ := new(big.Int).SetString(b.RegistrationDeadline, 10)
	return version.Cmp(big.NewInt(2)) >= 0 && instant.Cmp(deadline) <= 0
}

func validPrincipalRollback(b PrincipalFundsBinding, r PrincipalRollbackObservation) bool {
	return principalReference(r.Reference) && r.SegmentID == b.SegmentID && principalAddress(r.Holder, false) && r.Owner == r.Holder && principalHash(r.BlockHash)
}

func validPrincipalObservation(b PrincipalFundsBinding, o PrincipalFundsObservation) bool {
	for _, ref := range []string{o.FreezeOperation, o.ReleaseOperation, o.RefundOperation, o.Reservation, o.WalletEvidence} {
		if ref != "" && !principalReference(ref) { return false }
	}
	if o.Reservation != "" && (o.ReservationKind != "PRINCIPAL_FUNDS" || o.Reservation == b.Principal.GrantReference) { return false }
	if o.Reservation == "" && o.ReservationKind != "" { return false }
	if o.Registration != (PrincipalRegistrationObservation{}) && !validPrincipalRegistration(b, o.Registration) { return false }
	if o.Rollback != (PrincipalRollbackObservation{}) && !validPrincipalRollback(b, o.Rollback) { return false }
	// A completed holder registration is a settled prefix, never an unresolved
	// segment that can be rolled back to refund its principal.
	if o.Registration != (PrincipalRegistrationObservation{}) && o.Rollback != (PrincipalRollbackObservation{}) { return false }
	registrationAbsent := o.Registration == (PrincipalRegistrationObservation{})
	rollbackAbsent := o.Rollback == (PrincipalRollbackObservation{})
	if o.Phase == "prepared" { return o == (PrincipalFundsObservation{Phase: "prepared"}) }
	if o.WalletEvidence == "" || o.FreezeOperation == "" { return false }
	switch o.Phase {
	case "freeze-pending":
		return o.PendingAction == "freeze" && o.OutcomeAction == "freeze" && o.ActionOutcome == "PENDING" && o.ReleaseOperation == "" && o.RefundOperation == "" && registrationAbsent && rollbackAbsent
	case "refused":
		return o.PendingAction == "" && o.OutcomeAction == "freeze" && o.ActionOutcome == "NOT_APPLIED" && o.ReleaseOperation == "" && o.RefundOperation == "" && registrationAbsent && rollbackAbsent
	case "frozen":
		return o.PendingAction == "" && o.Reservation != "" && (o.OutcomeAction == "freeze" && o.ActionOutcome == "APPLIED" && o.ReleaseOperation == "" && o.RefundOperation == "" && registrationAbsent && rollbackAbsent || o.OutcomeAction == "release" && o.ActionOutcome == "NOT_APPLIED" && o.ReleaseOperation != "" && o.RefundOperation == "" && validPrincipalRegistration(b,o.Registration) && rollbackAbsent || o.OutcomeAction == "refund" && o.ActionOutcome == "NOT_APPLIED" && o.RefundOperation != "" && o.ReleaseOperation == "" && validPrincipalRollback(b,o.Rollback) && registrationAbsent)
	case "release-pending", "released":
		return o.Reservation != "" && o.ReleaseOperation != "" && o.RefundOperation == "" && o.OutcomeAction == "release" && validPrincipalRegistration(b, o.Registration) && rollbackAbsent && ((o.Phase == "release-pending" && o.PendingAction == "release" && o.ActionOutcome == "PENDING") || (o.Phase == "released" && o.PendingAction == "" && o.ActionOutcome == "APPLIED"))
	case "refund-pending", "refunded":
		return o.Reservation != "" && o.RefundOperation != "" && o.ReleaseOperation == "" && o.OutcomeAction == "refund" && validPrincipalRollback(b, o.Rollback) && registrationAbsent && ((o.Phase == "refund-pending" && o.PendingAction == "refund" && o.ActionOutcome == "PENDING") || (o.Phase == "refunded" && o.PendingAction == "" && o.ActionOutcome == "APPLIED"))
	case "unknown":
		if o.ActionOutcome != "UNKNOWN" || o.OutcomeAction != o.PendingAction { return false }
		switch o.PendingAction {
		case "freeze": return o.ReleaseOperation == "" && o.RefundOperation == "" && registrationAbsent && rollbackAbsent
		case "release": return o.Reservation != "" && o.ReleaseOperation != "" && o.RefundOperation == "" && validPrincipalRegistration(b, o.Registration) && rollbackAbsent
		case "refund": return o.Reservation != "" && o.RefundOperation != "" && o.ReleaseOperation == "" && validPrincipalRollback(b, o.Rollback) && registrationAbsent
		}
	}
	return false
}

// Pure transition check for observations already verified by the fixed actual
// Wallet/source adapter. It neither verifies a credential nor dispatches funds.
func nextPrincipalObservation(current PrincipalFundsRecord, next PrincipalFundsObservation, nowMs int64) (PrincipalFundsRecord, bool, error) {
	if !validPrincipalRecord(current) || nowMs < current.UpdatedAtMs || !validPrincipalObservation(current.Binding, next) { return PrincipalFundsRecord{}, false, errPrincipalJournalRefused }
	old := current.Observation
	// ReconcilesUnknown records how this event was reached, not a different
	// financial result. A later identical source read need not replay that
	// transition marker and must not append a new event.
	sameResult := next
	sameResult.ReconcilesUnknown = old.ReconcilesUnknown
	if sameResult == old { return current, false, nil }
	// Once an external action or reservation is known its identity cannot be
	// replaced, dropped or turned into a fresh buyer payment on recovery.
	for _, pair := range [][2]string{{old.FreezeOperation,next.FreezeOperation},{old.ReleaseOperation,next.ReleaseOperation},{old.RefundOperation,next.RefundOperation},{old.Reservation,next.Reservation}} {
		if pair[0] != "" && pair[0] != pair[1] { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	}
	if old.Registration != (PrincipalRegistrationObservation{}) && old.Registration != next.Registration { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	if old.Rollback != (PrincipalRollbackObservation{}) && old.Rollback != next.Rollback { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	releaseResult := next.Phase == "release-pending" || next.Phase == "released" || next.Phase == "unknown" && next.PendingAction == "release"
	refundResult := next.Phase == "refund-pending" || next.Phase == "refunded" || next.Phase == "unknown" && next.PendingAction == "refund"
	if old.ReleaseOperation == "" && next.ReleaseOperation != "" && !releaseResult || old.RefundOperation == "" && next.RefundOperation != "" && !refundResult { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	if old.Registration == (PrincipalRegistrationObservation{}) && next.Registration != (PrincipalRegistrationObservation{}) && !releaseResult { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	if old.Rollback == (PrincipalRollbackObservation{}) && next.Rollback != (PrincipalRollbackObservation{}) && !refundResult { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	allowed := false
	if old.Phase == "unknown" {
		// Only an actual read/reconciliation of the original pending operation
		// can leave UNKNOWN. No new pending action/replay is inferred here.
		if !next.ReconcilesUnknown || next.OutcomeAction != old.PendingAction { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
		switch old.PendingAction {
		case "freeze": allowed = next.Phase == "frozen" || next.Phase == "refused"
		case "release": allowed = next.Phase == "released" || next.Phase == "frozen"
		case "refund": allowed = next.Phase == "refunded" || next.Phase == "frozen"
		}
	} else {
		if next.ReconcilesUnknown { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
		if old.PendingAction != "" && next.Phase == "frozen" && next.OutcomeAction != old.PendingAction { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
		switch old.Phase {
		// A restarted observer may first see a verified completed result. It
		// need not invent a pending event or dispatch the action again.
		case "prepared": allowed = next.Phase == "freeze-pending" || next.Phase == "frozen" || next.Phase == "released" || next.Phase == "refunded" || next.Phase == "refused"
		case "freeze-pending": allowed = next.Phase == "frozen" || next.Phase == "released" || next.Phase == "refunded" || next.Phase == "refused" || next.Phase == "unknown" && next.PendingAction == "freeze"
		case "frozen": allowed = next.Phase == "release-pending" || next.Phase == "released" || next.Phase == "refund-pending" || next.Phase == "refunded"
		case "release-pending": allowed = next.Phase == "released" || next.Phase == "frozen" || next.Phase == "unknown" && next.PendingAction == "release"
		case "refund-pending": allowed = next.Phase == "refunded" || next.Phase == "frozen" || next.Phase == "unknown" && next.PendingAction == "refund"
		}
	}
	if !allowed || current.Revision == ^uint64(0) { return PrincipalFundsRecord{}, false, errPrincipalJournalConflict }
	current.Observation = next
	current.Revision++
	current.UpdatedAtMs = nowMs
	return current, true, nil
}
