package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type objectRedirectTransport func(*http.Request) (*http.Response, error)

func (transport objectRedirectTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func redirectFixture(transport http.RoundTripper) (*s3ObjectStore, []byte, string) {
	endpoint, _ := url.Parse("https://storage-fixture.invalid/original")
	body := []byte("TEST_ONLY object bytes, no institution record or credential")
	digest := sha256.Sum256(body)
	return &s3ObjectStore{endpoint: endpoint, region: "auto", bucket: "test-only", accessKey: "test-only-access", secretKey: "test-only-secret", client: &http.Client{Transport: transport, Timeout: time.Second}, now: func() time.Time { return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC) }}, body, hex.EncodeToString(digest[:])
}

func assertObjectRedirectRejected(t *testing.T, status int) {
	t.Helper()
	requests := 0
	store, body, digest := redirectFixture(objectRedirectTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		if requests > 1 {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
		}
		if request.URL.Host != "storage-fixture.invalid" || request.Method != http.MethodPut {
			t.Fatal("initial configured write changed")
		}
		actual, err := io.ReadAll(request.Body)
		if err != nil || string(actual) != string(bodyFixtureBytes()) {
			t.Fatal("initial object bytes changed")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Location": []string{"https://unrelated-fixture.invalid/redirected-object"}}, Body: http.NoBody, Request: request}, nil
	}))
	if err := store.Put(context.Background(), "rwa/metadata/test.json", body, "application/json", digest); err == nil {
		t.Fatal("redirected object write reported success")
	}
	if requests != 1 {
		t.Fatalf("left configured object endpoint: %d requests", requests)
	}
}

func bodyFixtureBytes() []byte {
	return []byte("TEST_ONLY object bytes, no institution record or credential")
}
func TestS3StoreRedirect301(t *testing.T) { assertObjectRedirectRejected(t, 301) }
func TestS3StoreRedirect302(t *testing.T) { assertObjectRedirectRejected(t, 302) }
func TestS3StoreRedirect303(t *testing.T) { assertObjectRedirectRejected(t, 303) }
func TestS3StoreRedirect307(t *testing.T) { assertObjectRedirectRejected(t, 307) }
func TestS3StoreRedirect308(t *testing.T) { assertObjectRedirectRejected(t, 308) }

func TestS3StoreRedirectPolicyDoesNotMutateSharedClient(t *testing.T) {
	requests, policyCalls := 0, 0
	store, body, digest := redirectFixture(objectRedirectTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: 307, Header: http.Header{"Location": []string{"https://unrelated-fixture.invalid/next"}}, Body: http.NoBody, Request: request}, nil
	}))
	originalPolicyError := errors.New("TEST_ONLY original caller policy")
	store.client.CheckRedirect = func(*http.Request, []*http.Request) error { policyCalls++; return originalPolicyError }
	if err := store.Put(context.Background(), "rwa/test.json", body, "application/json", digest); err == nil {
		t.Fatal("redirect accepted")
	}
	if policyCalls != 0 || requests != 1 {
		t.Fatal("object write delegated endpoint authority to caller redirect policy")
	}
	_, err := store.client.Get("https://storage-fixture.invalid/probe")
	if !errors.Is(err, originalPolicyError) || policyCalls != 1 || requests != 2 {
		t.Fatal("original shared-client policy was changed")
	}
}

func TestS3StoreDigestMismatchNeverSendsObject(t *testing.T) {
	calls := 0
	store, body, _ := redirectFixture(objectRedirectTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("unexpected TEST_ONLY send")
	}))
	if err := store.Put(context.Background(), "rwa/test.json", body, "application/json", strings.Repeat("0", 64)); err == nil || calls != 0 {
		t.Fatal("mismatched digest left caller")
	}
}

func TestS3StoreDeniedObjectResponseIsNotSuccess(t *testing.T) {
	calls := 0
	store, body, digest := redirectFixture(objectRedirectTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 403, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	}))
	if err := store.Put(context.Background(), "rwa/test.json", body, "application/json", digest); err == nil || calls != 1 {
		t.Fatal("denied write reported success or repeated")
	}
}
