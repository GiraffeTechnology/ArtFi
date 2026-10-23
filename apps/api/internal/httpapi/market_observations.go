package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const marketObservationMaxAge = 90 * time.Second

var marketCollectionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$`)

func recentMarketObservation(now, observed time.Time) bool {
	// The writer allows at most five seconds of clock skew, never arbitrary
	// future timestamps that could keep a dead provider permanently fresh.
	age := now.Sub(observed)
	return age >= -5*time.Second && age <= marketObservationMaxAge
}

type marketObservationRequest struct {
	SchemaVersion    string   `json:"schemaVersion"`
	Source           string   `json:"source"`
	Collections      []string `json:"collections"`
	Status           string   `json:"status"`
	ObservedAtMs     int64    `json:"observedAtMs"`
	CompletedThrough int64    `json:"completedThrough,omitempty"`
}

type marketObservation struct {
	Source           string `json:"source"`
	CollectionSlug   string `json:"collectionSlug"`
	Status           string `json:"status"`
	ObservedAt       string `json:"observedAt"`
	ReceivedAt       string `json:"receivedAt"`
	LastSuccessAt    string `json:"lastSuccessAt,omitempty"`
	CompletedThrough string `json:"completedThrough,omitempty"`
}

func (service *rwaService) recordMarketObservation(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input marketObservationRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market observation", "The observation is not valid JSON.")
		return
	}
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	_, approved := service.marketplaceSources[input.Source]
	now := time.Now().UTC()
	valid := input.SchemaVersion == "1" && approved && len(input.Collections) > 0 && len(input.Collections) <= 100
	valid = valid && input.ObservedAtMs >= now.Add(-5*time.Minute).UnixMilli() && input.ObservedAtMs <= now.Add(5*time.Second).UnixMilli()
	valid = valid && ((input.Status == "complete" && input.CompletedThrough > 0 && input.CompletedThrough <= input.ObservedAtMs/1000) || (input.Status == "unavailable" && input.CompletedThrough == 0))
	seen := make(map[string]struct{}, len(input.Collections))
	for _, collection := range input.Collections {
		_, duplicate := seen[collection]
		valid = valid && marketCollectionPattern.MatchString(collection) && !duplicate
		seen[collection] = struct{}{}
	}
	if !valid {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market observation", "Use an approved source, distinct collection slugs, and a bounded complete or unavailable observation.")
		return
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The observation could not be persisted.")
		return
	}
	defer tx.Rollback()
	var completedThrough any
	var lastSuccess any
	if input.Status == "complete" {
		completedThrough = input.CompletedThrough
		lastSuccess = input.ObservedAtMs
	}
	for _, collection := range input.Collections {
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_observations
			    (source, collection_slug, last_status, observed_at_ms, received_at_ms,
			     last_success_at_ms, covered_through_seconds)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
			    last_status = IF(VALUES(observed_at_ms) > observed_at_ms, VALUES(last_status), last_status),
			    received_at_ms = IF(VALUES(observed_at_ms) > observed_at_ms, VALUES(received_at_ms), received_at_ms),
			    last_success_at_ms = IF(VALUES(observed_at_ms) > observed_at_ms AND VALUES(last_success_at_ms) IS NOT NULL,
			        VALUES(last_success_at_ms), last_success_at_ms),
			    covered_through_seconds = IF(VALUES(observed_at_ms) > observed_at_ms AND VALUES(covered_through_seconds) IS NOT NULL,
			        GREATEST(COALESCE(covered_through_seconds, 0), VALUES(covered_through_seconds)), covered_through_seconds),
			    observed_at_ms = GREATEST(observed_at_ms, VALUES(observed_at_ms))`,
			input.Source, collection, input.Status, input.ObservedAtMs, now.UnixMilli(), lastSuccess, completedThrough)
		if err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The observation could not be persisted.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The observation could not be persisted.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "recorded"})
}

func (service *rwaService) getMarketObservations(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "Durable source observations are unavailable.")
		return
	}
	source := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("source")))
	if source == "" {
		source = "opensea"
	}
	if _, approved := service.marketplaceSources[source]; !approved {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid marketplace source", "The requested source is not approved.")
		return
	}
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT collection_slug, last_status, observed_at_ms, received_at_ms,
		       last_success_at_ms, covered_through_seconds
		FROM external_market_observations WHERE source = ? ORDER BY collection_slug LIMIT 1001`, source)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The source observations could not be queried.")
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	items := make([]marketObservation, 0)
	for rows.Next() {
		var item marketObservation
		var lastStatus string
		var observedMs, receivedMs int64
		var successMs, throughSeconds sql.NullInt64
		if err := rows.Scan(&item.CollectionSlug, &lastStatus, &observedMs, &receivedMs, &successMs, &throughSeconds); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The source observations could not be decoded.")
			return
		}
		item.Source = source
		item.Status = "stale"
		item.ObservedAt = time.UnixMilli(observedMs).UTC().Format(time.RFC3339Nano)
		item.ReceivedAt = time.UnixMilli(receivedMs).UTC().Format(time.RFC3339Nano)
		if successMs.Valid {
			item.LastSuccessAt = time.UnixMilli(successMs.Int64).UTC().Format(time.RFC3339Nano)
		}
		if throughSeconds.Valid {
			item.CompletedThrough = time.Unix(throughSeconds.Int64, 0).UTC().Format(time.RFC3339)
		}
		if lastStatus == "unavailable" {
			item.Status = "unavailable"
		} else if lastStatus == "complete" && successMs.Valid && throughSeconds.Valid &&
			recentMarketObservation(now, time.UnixMilli(successMs.Int64)) &&
			recentMarketObservation(now, time.UnixMilli(receivedMs)) &&
			recentMarketObservation(now, time.Unix(throughSeconds.Int64, 0)) {
			item.Status = "fresh"
		}
		items = append(items, item)
	}
	if rows.Err() != nil || len(items) > 1000 {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market observations unavailable", "The source observation set could not be returned completely.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"schemaVersion": "1", "source": source, "runtime": true, "data": items,
		"asOf": now.Format(time.RFC3339Nano), "maxAgeSeconds": int64(marketObservationMaxAge / time.Second),
	})
}
