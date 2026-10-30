package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Every server is an ephemeral loopback fixture. No real venue or credential is used.
func TestMarketHTTPRefusesCredentialedRedirects(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, status := range []int{301, 302, 303, 307, 308} {
			t.Run(fmt.Sprintf("%s/%d", method, status), func(t *testing.T) {
				var targetRequests, sourceRequests atomic.Int32
				var targetKey, targetBody, sourceKey atomic.Bool
				destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					targetRequests.Add(1)
					targetKey.Store(r.Header.Get("X-API-Key") != "")
					body, _ := io.ReadAll(r.Body)
					targetBody.Store(len(body) != 0)
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{ "unexpected": true }`)
				}))
				defer destination.Close()
				source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					sourceRequests.Add(1)
					sourceKey.Store(r.Header.Get("X-API-Key") == "TEST_ONLY_market_key")
					http.Redirect(w, r, destination.URL+"/unexpected", status)
				}))
				defer source.Close()
				service := newRWAService(rwaConfig{}, newMemoryObjectStore())
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				request, err := http.NewRequestWithContext(ctx, method, source.URL+"/reviewed", bytes.NewBufferString(`{"TEST_ONLY":"order-body"}`))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("X-API-Key", "TEST_ONLY_market_key")
				response, err := service.marketHTTPClient.Do(request)
				if err != nil {
					t.Fatalf("retain redirect response: %v", err)
				}
				defer response.Body.Close()
				_, _ = io.Copy(io.Discard, response.Body)
				if sourceRequests.Load() != 1 || !sourceKey.Load() {
					t.Fatal("the original credentialed request was not exercised")
				}
				if targetRequests.Load() != 0 || targetKey.Load() || targetBody.Load() {
					t.Errorf("redirect target was contacted: requests=%d keyPresent=%t bodyPresent=%t", targetRequests.Load(), targetKey.Load(), targetBody.Load())
				}
				if response.StatusCode != status {
					t.Errorf("redirect status = %d; want original %d", response.StatusCode, status)
				}
			})
		}
	}
}

func TestMarketHTTPDirectDiscoveryResponse(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var requests atomic.Int32
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet || r.URL.Path != "/api/v2/chains" || r.Header.Get("X-API-Key") != "TEST_ONLY_market_key" || r.Header.Get("Accept") != "application/json" {
					t.Error("unexpected direct venue request")
				}
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"TEST_ONLY":"direct response"}`)
			}))
			defer source.Close()
			service := newRWAService(rwaConfig{}, newMemoryObjectStore())
			service.openseaAPIBaseURL = source.URL
			service.openseaAPIKey = "TEST_ONLY_market_key"
			actual, body, err := service.openSeaGET(httptest.NewRequest(http.MethodGet, "/", nil), "/api/v2/chains")
			if err != nil || actual != status || string(body) != `{"TEST_ONLY":"direct response"}` || requests.Load() != 1 {
				t.Fatalf("direct response changed: status=%d requests=%d error=%v", actual, requests.Load(), err)
			}
		})
	}
}

func TestMarketHTTPDiscoveryRedirectDoesNotBecomeEvidence(t *testing.T) {
	var destinationRequests atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationRequests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"chains":[{"chain":"ethereum"}]}`)
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/unreviewed", http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.openseaAPIBaseURL = source.URL
	service.openseaAPIKey = "TEST_ONLY_market_key"
	response := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/rwa/discovery-checks", map[string]string{"source": "opensea", "chain": "hoodi", "contractAddress": "0x1111111111111111111111111111111111111111", "tokenId": "42"}, nil)
	if response.Code != http.StatusBadGateway || destinationRequests.Load() != 0 {
		t.Errorf("redirect produced discovery response: status=%d targetRequests=%d", response.Code, destinationRequests.Load())
	}
	if strings.Contains(response.Body.String(), "TEST_ONLY_market_key") || strings.Contains(response.Body.String(), "evidenceSha256") {
		t.Fatal("rejected redirect exposed a credential or discovery evidence")
	}
}
