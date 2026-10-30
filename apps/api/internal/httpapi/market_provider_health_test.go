package httpapi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func marketHealthBool(value bool) *bool     { return &value }
func marketHealthUint(value uint64) *uint64 { return &value }

func validMarketProviderHealthInput() marketProviderHealthInput {
	return marketProviderHealthInput{
		SchemaVersion: "1", Source: "opensea", State: "healthy",
		Stale: marketHealthBool(false), RealtimeConnected: marketHealthBool(true),
		ConsecutiveFailures: marketHealthUint(0), ObservedAt: "2026-09-14T00:00:30Z",
		LastBackfillSuccessAt: "2026-09-14T00:00:00Z", LastEventAt: "2026-09-14T00:00:20Z",
		FreshnessLagSeconds: marketHealthUint(10), StaleAfterSeconds: marketHealthUint(60),
	}
}

func TestMarketProviderHealthValidationAndCanonicalization(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 1, 0, 0, time.UTC) }
	normalized, err := service.normalizeMarketProviderHealth(validMarketProviderHealthInput())
	if err != nil {
		t.Fatal(err)
	}
	if normalized.payload.Source != "opensea" || normalized.payload.State != "healthy" || normalized.payload.FreshnessLagSeconds == nil || *normalized.payload.FreshnessLagSeconds != 10 {
		t.Fatalf("unexpected normalized provider health: %+v", normalized.payload)
	}
	second, err := service.normalizeMarketProviderHealth(validMarketProviderHealthInput())
	if err != nil {
		t.Fatal(err)
	}
	if normalized.payloadHash != second.payloadHash || !reflect.DeepEqual(normalized.payload, second.payload) {
		t.Fatal("provider health canonicalization is not deterministic")
	}
}

func TestMarketProviderHealthRejectsContradictoryEvidence(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 1, 0, 0, time.UTC) }
	tests := map[string]func(*marketProviderHealthInput){
		"unknown-source":       func(value *marketProviderHealthInput) { value.Source = "unapproved" },
		"unknown-state":        func(value *marketProviderHealthInput) { value.State = "online" },
		"missing-required":     func(value *marketProviderHealthInput) { value.Stale = nil },
		"counter-out-of-range": func(value *marketProviderHealthInput) { value.ConsecutiveFailures = marketHealthUint(1_000_001) },
		"future-observation":   func(value *marketProviderHealthInput) { value.ObservedAt = "2026-09-14T00:07:00Z" },
		"future-event":         func(value *marketProviderHealthInput) { value.LastEventAt = "2026-09-14T00:00:31Z" },
		"wrong-lag":            func(value *marketProviderHealthInput) { value.FreshnessLagSeconds = marketHealthUint(11) },
		"wrong-stale":          func(value *marketProviderHealthInput) { value.Stale = marketHealthBool(true) },
		"wrong-state":          func(value *marketProviderHealthInput) { value.State = "degraded" },
		"failure-without-time": func(value *marketProviderHealthInput) {
			value.ConsecutiveFailures = marketHealthUint(1)
			value.State = "degraded"
		},
		"stopped-connected": func(value *marketProviderHealthInput) { value.State = "stopped" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			input := validMarketProviderHealthInput()
			mutate(&input)
			if _, err := service.normalizeMarketProviderHealth(input); err == nil {
				t.Fatalf("invalid provider health %s was accepted", name)
			}
		})
	}
}

func TestMarketProviderHealthAcceptsStartingStaleAndStopped(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 2, 0, 0, time.UTC) }
	starting := marketProviderHealthInput{
		SchemaVersion: "1", Source: "opensea", State: "starting",
		Stale: marketHealthBool(true), RealtimeConnected: marketHealthBool(false),
		ConsecutiveFailures: marketHealthUint(0), ObservedAt: "2026-09-14T00:00:00Z",
		StaleAfterSeconds: marketHealthUint(60),
	}
	if _, err := service.normalizeMarketProviderHealth(starting); err != nil {
		t.Fatal(err)
	}
	stale := validMarketProviderHealthInput()
	stale.ObservedAt = "2026-09-14T00:01:30Z"
	stale.State = "stale"
	stale.Stale = marketHealthBool(true)
	stale.FreshnessLagSeconds = marketHealthUint(70)
	if _, err := service.normalizeMarketProviderHealth(stale); err != nil {
		t.Fatal(err)
	}
	stopped := stale
	stopped.State = "stopped"
	stopped.RealtimeConnected = marketHealthBool(false)
	if _, err := service.normalizeMarketProviderHealth(stopped); err != nil {
		t.Fatal(err)
	}
}

func TestMarketProviderHealthEndpointsFailClosedWithoutPersistence(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	handler := newHandler(service)
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/v1/market/health?source=opensea", nil),
		httptest.NewRequest(http.MethodPost, "/v1/indexer/market-health", nil),
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("missing durable provider health must be unavailable, got %d", recorder.Code)
		}
	}
}

func TestMarketProviderHealthRetainsFractionalSecondStaleness(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 2, 0, 0, time.UTC) }
	input := validMarketProviderHealthInput()
	input.ObservedAt = "2026-09-14T00:01:00.500Z"
	input.LastBackfillSuccessAt = "2026-09-14T00:00:00Z"
	input.LastEventAt = ""
	input.State = "stale"
	input.Stale = marketHealthBool(true)
	input.FreshnessLagSeconds = marketHealthUint(60)
	if _, err := service.normalizeMarketProviderHealth(input); err != nil {
		t.Fatal(err)
	}
	input.State = "healthy"
	input.Stale = marketHealthBool(false)
	if _, err := service.normalizeMarketProviderHealth(input); err == nil {
		t.Fatal("floored lag incorrectly renewed freshness")
	}
}

func TestMarketProviderHealthDelayedObservationsNeverBecomeAvailableOnReceipt(t *testing.T) {
	now := time.Date(2026, 10, 30, 0, 5, 0, 0, time.UTC)
	cases := []struct {
		name     string
		observed time.Time
		received time.Time
		source   time.Time
		stale    bool
		current  bool
	}{
		{"fresh", now.Add(-10 * time.Second), now.Add(-5 * time.Second), now.Add(-15 * time.Second), false, true},
		{"delayed-report", now.Add(-5 * time.Minute), now, now.Add(-5 * time.Minute), true, false},
		{"fractional-report", now, now.Add(-60500 * time.Millisecond), now, true, true},
		{"old-source-fresh-envelope", now.Add(-40 * time.Second), now, now.Add(-70 * time.Second), false, false},
		{"future-source", now.Add(time.Second), now, now.Add(time.Second), false, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			_, stale, current := marketHealthAvailability(now, item.observed, item.received, &item.source, 60)
			if stale != item.stale || current != item.current {
				t.Fatalf("stale=%v current=%v", stale, current)
			}
		})
	}
}
