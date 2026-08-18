package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	recorder := request(t, http.MethodGet, "/healthz")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}
	var response statusResponse
	decode(t, recorder, &response)
	if response.Service != "artfi-api" || response.Status != "ok" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestConfigIsSepoliaReadOnly(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/config")
	var response configResponse
	decode(t, recorder, &response)
	if response.ChainID != 11155111 || !response.ReadOnly || response.Network != "sepolia" {
		t.Fatalf("unsafe config: %+v", response)
	}
}

func TestAssetLookup(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/blue-hour-archive")
	var response asset
	decode(t, recorder, &response)
	if response.Slug != "blue-hour-archive" || response.ValuationUSD <= 0 {
		t.Fatalf("unexpected asset: %+v", response)
	}
}

func TestMissingAssetUsesProblemJSON(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/missing")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/problem+json; charset=utf-8" {
		t.Fatalf("unexpected content type: %s", got)
	}
	var response problem
	decode(t, recorder, &response)
	if response.RequestID == "" {
		t.Fatal("expected request id")
	}
}

func TestPortfolioRejectsInvalidAddress(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/portfolio/not-an-address")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recorder.Code)
	}
}

func TestPreflight(t *testing.T) {
	recorder := request(t, http.MethodOptions, "/v1/assets")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("unexpected origin: %s", got)
	}
}

func request(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, req)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder, value interface{}) {
	t.Helper()
	if err := json.NewDecoder(recorder.Body).Decode(value); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}
