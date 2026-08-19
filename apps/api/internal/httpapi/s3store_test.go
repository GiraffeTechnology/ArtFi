package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestS3StoreSignsAndUploadsImmutableObject(t *testing.T) {
	body := []byte("immutable metadata")
	digest := sha256.Sum256(body)
	digestHex := hex.EncodeToString(digest[:])

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/artfi/rwa/metadata/test.json" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("X-Amz-Content-Sha256") != digestHex || request.Header.Get("X-Amz-Meta-Sha256") != digestHex {
			t.Fatal("missing immutable digest headers")
		}
		authorization := request.Header.Get("Authorization")
		if !strings.Contains(authorization, "Credential=test-access/20260819/auto/s3/aws4_request") || !strings.Contains(authorization, "Signature=") {
			t.Fatalf("unexpected authorization: %s", authorization)
		}
		actual, _ := io.ReadAll(request.Body)
		if string(actual) != string(body) {
			t.Fatal("body mismatch")
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	endpoint, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &s3ObjectStore{
		endpoint:  endpoint.URL,
		region:    "auto",
		bucket:    "artfi",
		accessKey: "test-access",
		secretKey: "test-secret",
		client:    server.Client(),
		now: func() time.Time {
			return time.Date(2026, 8, 19, 4, 0, 0, 0, time.UTC)
		},
	}
	if err := store.Put(context.Background(), "rwa/metadata/test.json", body, "application/json", digestHex); err != nil {
		t.Fatal(err)
	}
}
