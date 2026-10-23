package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"
)

type marketStreamRequest struct {
	SchemaVersion  string   `json:"schemaVersion"`
	Source         string   `json:"source"`
	Collections    []string `json:"collections"`
	TransportState string   `json:"transportState"`
	ObservedAtMs   int64    `json:"observedAtMs"`
}

type marketStreamObservation struct {
	Source         string `json:"source"`
	CollectionSlug string `json:"collectionSlug"`
	TransportState string `json:"transportState"`
	Freshness      string `json:"freshness"`
	ObservedAt     string `json:"observedAt"`
	ReceivedAt     string `json:"receivedAt"`
}

func validMarketTransportState(state string) bool {
	return state == "connecting" || state == "connected" || state == "disconnected" || state == "stopped"
}

func (service *rwaService) recordMarketStream(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input marketStreamRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid stream observation", "Use the bounded transport observation schema.")
		return
	}
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	_, approved := service.marketplaceSources[input.Source]
	now := time.Now().UTC()
	valid := input.SchemaVersion == "1" && approved && validMarketTransportState(input.TransportState)
	valid = valid && len(input.Collections) > 0 && len(input.Collections) <= 100
	valid = valid && input.ObservedAtMs >= now.Add(-5*time.Minute).UnixMilli() && input.ObservedAtMs <= now.Add(5*time.Second).UnixMilli()
	seen := make(map[string]struct{}, len(input.Collections))
	for _, collection := range input.Collections {
		_, duplicate := seen[collection]
		valid = valid && marketCollectionPattern.MatchString(collection) && !duplicate
		seen[collection] = struct{}{}
	}
	if !valid {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid stream observation", "Use an approved source, distinct collection scope, bounded observation time and a transport state.")
		return
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The observation could not be persisted.")
		return
	}
	defer tx.Rollback()
	for _, collection := range input.Collections {
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_stream_observations
			    (source, collection_slug, transport_state, observed_at_ms, received_at_ms)
			VALUES (?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
			    transport_state = IF(VALUES(observed_at_ms) > observed_at_ms, VALUES(transport_state), transport_state),
			    received_at_ms = IF(VALUES(observed_at_ms) > observed_at_ms, VALUES(received_at_ms), received_at_ms),
			    observed_at_ms = GREATEST(observed_at_ms, VALUES(observed_at_ms))`,
			input.Source, collection, input.TransportState, input.ObservedAtMs, now.UnixMilli())
		if err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The observation could not be persisted.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The observation could not be persisted.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "recorded"})
}

func (service *rwaService) getMarketStreams(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "Durable transport observations are unavailable.")
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
		SELECT collection_slug, transport_state, observed_at_ms, received_at_ms
		FROM external_market_stream_observations WHERE source = ? ORDER BY collection_slug LIMIT 1001`, source)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The source observations could not be queried.")
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	items := make([]marketStreamObservation, 0)
	for rows.Next() {
		var item marketStreamObservation
		var observedMs, receivedMs int64
		if err := rows.Scan(&item.CollectionSlug, &item.TransportState, &observedMs, &receivedMs); err != nil ||
			!marketCollectionPattern.MatchString(item.CollectionSlug) || !validMarketTransportState(item.TransportState) || observedMs <= 0 || receivedMs <= 0 {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The source observations could not be decoded.")
			return
		}
		item.Source = source
		item.ObservedAt = time.UnixMilli(observedMs).UTC().Format(time.RFC3339Nano)
		item.ReceivedAt = time.UnixMilli(receivedMs).UTC().Format(time.RFC3339Nano)
		item.Freshness = "stale"
		if recentMarketObservation(now, time.UnixMilli(observedMs)) && recentMarketObservation(now, time.UnixMilli(receivedMs)) {
			item.Freshness = "fresh"
		}
		items = append(items, item)
	}
	if rows.Err() != nil || len(items) > 1000 {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Stream observations unavailable", "The complete source observations could not be read.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"schemaVersion": "1", "source": source, "runtime": true, "data": items,
		"asOf": now.Format(time.RFC3339Nano), "maxAgeSeconds": int64(marketObservationMaxAge / time.Second),
		"scope": "transport-only",
	})
}
