package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var (
	errMarketHealthOutOfOrder = errors.New("market provider health report is older than the durable report")
	errMarketHealthConflict   = errors.New("market provider health report conflicts with the durable report")
)

var marketProviderHealthStates = map[string]struct{}{
	"starting": {}, "healthy": {}, "degraded": {}, "stale": {}, "stopped": {},
}

type marketProviderHealthInput struct {
	SchemaVersion         string  `json:"schemaVersion"`
	Source                string  `json:"source"`
	State                 string  `json:"state"`
	Stale                 *bool   `json:"stale"`
	RealtimeConnected     *bool   `json:"realtimeConnected"`
	ConsecutiveFailures   *uint64 `json:"consecutiveFailures"`
	ObservedAt            string  `json:"observedAt"`
	LastBackfillSuccessAt string  `json:"lastBackfillSuccessAt"`
	LastEventAt           string  `json:"lastEventAt"`
	LastFailureAt         string  `json:"lastFailureAt"`
	FreshnessLagSeconds   *uint64 `json:"freshnessLagSeconds"`
	StaleAfterSeconds     *uint64 `json:"staleAfterSeconds"`
}

type marketProviderHealthPayload struct {
	SchemaVersion         string  `json:"schemaVersion"`
	Source                string  `json:"source"`
	State                 string  `json:"state"`
	Stale                 bool    `json:"stale"`
	RealtimeConnected     bool    `json:"realtimeConnected"`
	ConsecutiveFailures   uint64  `json:"consecutiveFailures"`
	ObservedAt            string  `json:"observedAt"`
	LastBackfillSuccessAt string  `json:"lastBackfillSuccessAt,omitempty"`
	LastEventAt           string  `json:"lastEventAt,omitempty"`
	LastFailureAt         string  `json:"lastFailureAt,omitempty"`
	FreshnessLagSeconds   *uint64 `json:"freshnessLagSeconds,omitempty"`
	StaleAfterSeconds     uint64  `json:"staleAfterSeconds"`
}

type normalizedMarketProviderHealth struct {
	payload               marketProviderHealthPayload
	observedAt            time.Time
	lastBackfillSuccessAt *time.Time
	lastEventAt           *time.Time
	lastFailureAt         *time.Time
	payloadHash           [32]byte
}

type marketProviderHealthResponse struct {
	marketProviderHealthPayload
	ReceivedAt       string `json:"receivedAt"`
	ReportLagSeconds uint64 `json:"reportLagSeconds"`
	ReportingStale   bool   `json:"reportingStale"`
	Available        bool   `json:"available"`
}

func (service *rwaService) ingestMarketProviderHealth(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input marketProviderHealthInput
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market provider health", err.Error())
		return
	}
	normalized, err := service.normalizeMarketProviderHealth(input)
	if err != nil {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market provider health", err.Error())
		return
	}
	status, err := service.persistMarketProviderHealth(request, normalized)
	if errors.Is(err, errMarketHealthOutOfOrder) || errors.Is(err, errMarketHealthConflict) {
		writeProblem(writer, request, http.StatusConflict, "Market provider health conflict", err.Error())
		return
	}
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "The provider health report could not be stored durably.")
		return
	}
	service.bumpCacheNamespace(request.Context(), "market")
	writeJSON(writer, status, map[string]any{
		"source": normalized.payload.Source, "observedAt": normalized.payload.ObservedAt, "status": "recorded",
	})
}

func (service *rwaService) normalizeMarketProviderHealth(input marketProviderHealthInput) (normalizedMarketProviderHealth, error) {
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	input.State = strings.ToLower(strings.TrimSpace(input.State))
	if input.SchemaVersion != "1" {
		return normalizedMarketProviderHealth{}, fmt.Errorf("unsupported market provider health schema version")
	}
	if _, ok := service.marketplaceSources[input.Source]; !ok {
		return normalizedMarketProviderHealth{}, fmt.Errorf("marketplace source is not approved")
	}
	if _, ok := marketProviderHealthStates[input.State]; !ok {
		return normalizedMarketProviderHealth{}, fmt.Errorf("market provider health state is invalid")
	}
	if input.Stale == nil || input.RealtimeConnected == nil || input.ConsecutiveFailures == nil || input.StaleAfterSeconds == nil {
		return normalizedMarketProviderHealth{}, fmt.Errorf("complete market provider health state is required")
	}
	if *input.ConsecutiveFailures > 1_000_000 || *input.StaleAfterSeconds < 1 || *input.StaleAfterSeconds > 86_400 {
		return normalizedMarketProviderHealth{}, fmt.Errorf("market provider health counters exceed their bounds")
	}
	observedAt, err := time.Parse(time.RFC3339Nano, input.ObservedAt)
	if err != nil || observedAt.After(service.now().UTC().Add(5*time.Minute)) {
		return normalizedMarketProviderHealth{}, fmt.Errorf("market provider observedAt is invalid")
	}
	observedAt = observedAt.UTC().Truncate(time.Microsecond)
	lastBackfill, err := optionalHealthTime(input.LastBackfillSuccessAt, observedAt)
	if err != nil {
		return normalizedMarketProviderHealth{}, fmt.Errorf("lastBackfillSuccessAt is invalid")
	}
	lastEvent, err := optionalHealthTime(input.LastEventAt, observedAt)
	if err != nil {
		return normalizedMarketProviderHealth{}, fmt.Errorf("lastEventAt is invalid")
	}
	lastFailure, err := optionalHealthTime(input.LastFailureAt, observedAt)
	if err != nil {
		return normalizedMarketProviderHealth{}, fmt.Errorf("lastFailureAt is invalid")
	}
	if *input.ConsecutiveFailures > 0 && lastFailure == nil {
		return normalizedMarketProviderHealth{}, fmt.Errorf("lastFailureAt is required after a provider failure")
	}
	freshness := latestHealthTime(lastBackfill, lastEvent)
	var expectedLag *uint64
	expectedStale := true
	if freshness != nil {
		seconds := uint64(observedAt.Sub(*freshness) / time.Second)
		expectedLag = &seconds
		expectedStale = seconds > *input.StaleAfterSeconds
	}
	if !sameOptionalUint64(input.FreshnessLagSeconds, expectedLag) || *input.Stale != expectedStale {
		return normalizedMarketProviderHealth{}, fmt.Errorf("market provider freshness evidence is inconsistent")
	}
	expectedState := "starting"
	if input.State == "stopped" {
		if *input.RealtimeConnected {
			return normalizedMarketProviderHealth{}, fmt.Errorf("a stopped provider cannot be realtime connected")
		}
		expectedState = "stopped"
	} else if *input.ConsecutiveFailures > 0 {
		expectedState = "degraded"
	} else if freshness == nil {
		expectedState = "starting"
	} else if expectedStale {
		expectedState = "stale"
	} else {
		expectedState = "healthy"
	}
	if input.State != expectedState {
		return normalizedMarketProviderHealth{}, fmt.Errorf("market provider state contradicts its evidence")
	}
	payload := marketProviderHealthPayload{
		SchemaVersion: input.SchemaVersion, Source: input.Source, State: input.State,
		Stale: *input.Stale, RealtimeConnected: *input.RealtimeConnected,
		ConsecutiveFailures: *input.ConsecutiveFailures, ObservedAt: observedAt.Format(time.RFC3339Nano),
		LastBackfillSuccessAt: formatOptionalHealthTime(lastBackfill), LastEventAt: formatOptionalHealthTime(lastEvent),
		LastFailureAt: formatOptionalHealthTime(lastFailure), FreshnessLagSeconds: expectedLag,
		StaleAfterSeconds: *input.StaleAfterSeconds,
	}
	canonical, err := json.Marshal(payload)
	if err != nil {
		return normalizedMarketProviderHealth{}, err
	}
	return normalizedMarketProviderHealth{
		payload: payload, observedAt: observedAt, lastBackfillSuccessAt: lastBackfill,
		lastEventAt: lastEvent, lastFailureAt: lastFailure, payloadHash: sha256.Sum256(canonical),
	}, nil
}

func (service *rwaService) persistMarketProviderHealth(request *http.Request, normalized normalizedMarketProviderHealth) (int, error) {
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(request.Context(), `
		SELECT observed_at, payload_hash FROM external_market_provider_health
		WHERE source = ? FOR UPDATE`, normalized.payload.Source)
	if err != nil {
		return 0, err
	}
	var priorObserved time.Time
	var priorHash []byte
	exists := rows.Next()
	if exists {
		if err := rows.Scan(&priorObserved, &priorHash); err != nil {
			rows.Close()
			return 0, err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if exists {
		if normalized.observedAt.Before(priorObserved.UTC()) {
			return 0, errMarketHealthOutOfOrder
		}
		if normalized.observedAt.Equal(priorObserved.UTC()) {
			if subtle.ConstantTimeCompare(priorHash, normalized.payloadHash[:]) != 1 {
				return 0, errMarketHealthConflict
			}
			if err := tx.Commit(); err != nil {
				return 0, err
			}
			return http.StatusOK, nil
		}
	}
	arguments := []any{
		normalized.payload.SchemaVersion, normalized.payload.State, normalized.payload.Stale,
		normalized.payload.RealtimeConnected, normalized.payload.ConsecutiveFailures, normalized.observedAt,
		optionalHealthTimeArgument(normalized.lastBackfillSuccessAt), optionalHealthTimeArgument(normalized.lastEventAt),
		optionalHealthTimeArgument(normalized.lastFailureAt), optionalUint64Argument(normalized.payload.FreshnessLagSeconds),
		normalized.payload.StaleAfterSeconds, normalized.payloadHash[:], normalized.payload.Source,
	}
	if exists {
		_, err = tx.ExecContext(request.Context(), `
			UPDATE external_market_provider_health
			SET schema_version = ?, state = ?, stale = ?, realtime_connected = ?, consecutive_failures = ?,
			    observed_at = ?, last_backfill_success_at = ?, last_event_at = ?, last_failure_at = ?,
			    freshness_lag_seconds = ?, stale_after_seconds = ?, payload_hash = ?, received_at = CURRENT_TIMESTAMP(6)
			WHERE source = ?`, arguments...)
	} else {
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_provider_health
			    (schema_version, state, stale, realtime_connected, consecutive_failures, observed_at,
			     last_backfill_success_at, last_event_at, last_failure_at, freshness_lag_seconds,
			     stale_after_seconds, payload_hash, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, arguments...)
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if exists {
		return http.StatusOK, nil
	}
	return http.StatusCreated, nil
}

func (service *rwaService) getMarketProviderHealth(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "Durable provider health is unavailable; provider availability cannot be inferred.")
		return
	}
	source := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("source")))
	if source == "" {
		source = "opensea"
	}
	if _, ok := service.marketplaceSources[source]; !ok {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid marketplace source", "The requested source is not approved.")
		return
	}
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT schema_version, source, state, stale, realtime_connected, consecutive_failures,
		       observed_at, last_backfill_success_at, last_event_at, last_failure_at,
		       freshness_lag_seconds, stale_after_seconds, received_at
		FROM external_market_provider_health WHERE source = ?`, source)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "The durable provider health record could not be queried.")
		return
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "The durable provider health query was interrupted.")
			return
		}
		writeProblem(writer, request, http.StatusNotFound, "Market provider health not found", "No runtime health report exists for the requested provider.")
		return
	}
	var payload marketProviderHealthPayload
	var observedAt, receivedAt time.Time
	var lastBackfill, lastEvent, lastFailure sql.NullTime
	var freshnessLag sql.NullInt64
	if err := rows.Scan(
		&payload.SchemaVersion, &payload.Source, &payload.State, &payload.Stale,
		&payload.RealtimeConnected, &payload.ConsecutiveFailures, &observedAt,
		&lastBackfill, &lastEvent, &lastFailure, &freshnessLag, &payload.StaleAfterSeconds, &receivedAt,
	); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market provider health unavailable", "The durable provider health record could not be decoded.")
		return
	}
	payload.ObservedAt = observedAt.UTC().Format(time.RFC3339Nano)
	payload.LastBackfillSuccessAt = formatNullHealthTime(lastBackfill)
	payload.LastEventAt = formatNullHealthTime(lastEvent)
	payload.LastFailureAt = formatNullHealthTime(lastFailure)
	if freshnessLag.Valid {
		value := uint64(freshnessLag.Int64)
		payload.FreshnessLagSeconds = &value
	}
	reportLag := uint64(max(time.Duration(0), service.now().UTC().Sub(receivedAt.UTC())) / time.Second)
	reportingStale := reportLag > payload.StaleAfterSeconds
	writeJSON(writer, http.StatusOK, marketProviderHealthResponse{
		marketProviderHealthPayload: payload, ReceivedAt: receivedAt.UTC().Format(time.RFC3339Nano),
		ReportLagSeconds: reportLag, ReportingStale: reportingStale,
		Available: !payload.Stale && !reportingStale && payload.State == "healthy" && payload.RealtimeConnected,
	})
}

func optionalHealthTime(value string, observedAt time.Time) (*time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.After(observedAt) {
		return nil, errors.New("invalid health timestamp")
	}
	parsed = parsed.UTC().Truncate(time.Microsecond)
	return &parsed, nil
}

func latestHealthTime(first, second *time.Time) *time.Time {
	if first == nil {
		return second
	}
	if second == nil || first.After(*second) {
		return first
	}
	return second
}

func sameOptionalUint64(first, second *uint64) bool {
	if first == nil || second == nil {
		return first == nil && second == nil
	}
	return *first == *second
}

func formatOptionalHealthTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func formatNullHealthTime(value sql.NullTime) string {
	if !value.Valid {
		return ""
	}
	return value.Time.UTC().Format(time.RFC3339Nano)
}

func optionalHealthTimeArgument(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalUint64Argument(value *uint64) any {
	if value == nil {
		return nil
	}
	return *value
}
