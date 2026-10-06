package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIndexedReadOnlyEndpointsRejectMissingPersistence(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	for _, path := range []string{"/v1/market/assets", "/v1/market/activity", "/v1/nfts", "/v1/portfolio/0x2222222222222222222222222222222222222222"} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			newHandler(service).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("missing persistence must be unavailable, got %d", recorder.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["runtime"] == true || body["data"] != nil || body["positions"] != nil || body["transactions"] != nil {
				t.Fatal("missing persistence was represented as live indexed data")
			}
			if body["status"] != float64(http.StatusServiceUnavailable) {
				t.Fatal("bounded problem response missing unavailable status")
			}
		})
	}
}
