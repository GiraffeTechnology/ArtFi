package httpapi

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Source private keys exist only in test memory and sign synthetic claims.
func syntheticRWASource(t *testing.T, service *rwaService) (*ecdsa.PrivateKey, approvedRWASource) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	source := approvedRWASource{ID: "test-source-" + randomID()[:12], Name: "TEST_ONLY custody source", Kind: "custody", PublicKeyX: fmt.Sprintf("0x%064x", key.X), PublicKeyY: fmt.Sprintf("0x%064x", key.Y), Mode: "TEST_ONLY"}
	service.grounding = rwaGroundingPolicy{sources: map[string]approvedRWASource{source.ID: source}, mode: "TEST_ONLY"}
	return key, source
}
func signSyntheticDigest(t *testing.T, key *ecdsa.PrivateKey, digest string) (string, string) {
	t.Helper()
	bytes, err := hex.DecodeString(strings.TrimPrefix(digest, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	r, s, err := ecdsa.Sign(rand.Reader, key, bytes)
	if err != nil {
		t.Fatal(err)
	}
	half := new(big.Int).Rsh(new(big.Int).Set(key.Params().N), 1)
	if s.Cmp(half) > 0 {
		s.Sub(key.Params().N, s)
	}
	return fmt.Sprintf("0x%064x", r), fmt.Sprintf("0x%064x", s)
}
func syntheticEvidence(t *testing.T, service *rwaService, key *ecdsa.PrivateKey, source approvedRWASource, contextHash, section string) rwaSourceEvidence {
	t.Helper()
	id := randomID()
	e := rwaSourceEvidence{SourceID: source.ID, SourceAssetID: "TEST_ONLY-record-" + id, EvidenceID: hashText(id), UnderlyingAssetID: "urn:test-only:asset:" + id, Section: section, Mode: "TEST_ONLY", SourceReference: "https://source.example.test/records/" + id, EvidenceSHA256: hashText("Synthetic source document " + id), Rights: "TEST_ONLY correspondence for an isolated synthetic asset. No real-world entitlement.", ValidFrom: service.now().Unix() - 30, ValidUntil: service.now().Unix() + 3600, ContextHash: contextHash}
	e.SignatureR, e.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(e))
	return e
}
func TestRWASourceEvidenceRejectsTamperingAndUnapprovedSources(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	key, source := syntheticRWASource(t, service)
	contextHash := hashText("synthetic context")
	e := syntheticEvidence(t, service, key, source, contextHash, "whole")
	if err := service.grounding.verify(e, contextHash, "whole", service.now(), false); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*rwaSourceEvidence){"source": func(v *rwaSourceEvidence) { v.SourceID = "unknown" }, "source asset": func(v *rwaSourceEvidence) { v.SourceAssetID += "changed" }, "underlying": func(v *rwaSourceEvidence) { v.UnderlyingAssetID += "changed" }, "rights": func(v *rwaSourceEvidence) { v.Rights += " changed" }, "model": func(v *rwaSourceEvidence) { v.Section = "fractional" }, "mode": func(v *rwaSourceEvidence) { v.Mode = "LIVE" }, "context": func(v *rwaSourceEvidence) { v.ContextHash = hashText("changed") }, "document": func(v *rwaSourceEvidence) { v.EvidenceSHA256 = hashText("changed") }, "reference": func(v *rwaSourceEvidence) { v.SourceReference = "https://other.example.test/claim" }, "evidence ID": func(v *rwaSourceEvidence) { v.EvidenceID = hashText("changed") }, "expiry": func(v *rwaSourceEvidence) { v.ValidUntil++ }, "signature": func(v *rwaSourceEvidence) { v.SignatureR = hashText("forged") }}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			copy := e
			change(&copy)
			if err := service.grounding.verify(copy, contextHash, "whole", service.now(), false); err == nil {
				t.Fatal("tampered evidence accepted")
			}
		})
	}
	high := e
	s, _ := hexInteger(high.SignatureS)
	high.SignatureS = fmt.Sprintf("0x%064x", new(big.Int).Sub(key.Params().N, s))
	if service.grounding.verify(high, contextHash, "whole", service.now(), false) == nil {
		t.Fatal("malleable high-S signature accepted")
	}
}
func TestRWASourceEvidenceExpiryRevocationStateAndRegistryMeaning(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	key, source := syntheticRWASource(t, service)
	contextHash := hashText("context")
	e := syntheticEvidence(t, service, key, source, contextHash, "fractional")
	if service.groundingStatus(e, contextHash, "fractional", true, service.now()).Status != "revoked" {
		t.Fatal("revocation not projected")
	}
	now := service.now()
	service.now = func() time.Time { return time.Unix(e.ValidUntil, 0) }
	if service.grounding.verify(e, contextHash, "fractional", service.now(), false) == nil || service.groundingStatus(e, contextHash, "fractional", false, now).Status != "expired" {
		t.Fatal("inclusive expiry not enforced")
	}
	service.now = func() time.Time { return time.Unix(e.ValidFrom-1, 0) }
	if service.groundingStatus(e, contextHash, "fractional", false, now).Status != "not-yet-valid" {
		t.Fatal("future claim active")
	}
	service.now = func() time.Time { return now }
	source.RegistryBacked = true
	service.grounding.sources[source.ID] = source
	if service.grounding.verify(e, contextHash, "fractional", now, false) == nil {
		t.Fatal("registry-backed claim missing reference accepted")
	}
	e.RegistryRecord = &rwaRegistryRecord{Reference: "https://registry.example.test/record", Version: "revision-4", ObservedAt: e.ValidFrom - 1}
	e.SignatureR, e.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(e))
	if err := service.grounding.verify(e, contextHash, "fractional", now, false); err != nil {
		t.Fatal(err)
	}
	source.Disabled = true
	service.grounding.sources[source.ID] = source
	if service.groundingStatus(e, contextHash, "fractional", false, now).Status != "source-unavailable" {
		t.Fatal("disabled source trusted")
	}
}
func TestRWAApprovedSourceConfigFailClosedAndTestOnlyIsolation(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	_, source := syntheticRWASource(t, service)
	body, _ := json.Marshal([]approvedRWASource{source})
	for _, bad := range []string{string(body) + " {}", `{"id":"bad"}`, strings.Replace(string(body), source.PublicKeyX, zeroHash, 1), strings.Replace(string(body), `"mode":"TEST_ONLY"`, `"mode":"LIVE"`, 1), strings.Replace(string(body), `"name":`, `"privateKey":"not-permitted","name":`, 1)} {
		if _, err := parseRWASources(bad, "TEST_ONLY"); err == nil {
			t.Fatal("bad source config accepted")
		}
	}
	t.Setenv("ARTFI_RWA_APPROVED_SOURCES_JSON", string(body))
	t.Setenv("ARTFI_RWA_EVIDENCE_MODE", "TEST_ONLY")
	t.Setenv("ARTFI_ENV", "production")
	if len(groundingPolicyFromEnv().sources) != 0 {
		t.Fatal("production accepted TEST_ONLY roots")
	}
	t.Setenv("ARTFI_ENV", "test")
	if len(groundingPolicyFromEnv().sources) != 1 {
		t.Fatal("isolated TEST_ONLY source disabled")
	}
}
func TestRWAMetadataPreparationIsNotExecutableAndMintRequiresEvidence(t *testing.T) {
	service := newRWAService(rwaConfig{registryAddress: "0x1111111111111111111111111111111111111111", publicBaseURL: "https://objects.example.test"}, newMemoryObjectStore())
	service.uploads["test-upload"] = &uploadSession{ID: "test-upload", ObjectKey: "test-only.png", SHA256: strings.Repeat("a", 64), Completed: true}
	h := newHandler(service)
	input := mintIntentRequest{UploadID: "test-upload", Recipient: "0x2222222222222222222222222222222222222222", Name: "Synthetic artwork", Artist: "Example maker", Year: 2026, Medium: "Test pigment", Location: "Test vault", Description: "TEST_ONLY record without real asset rights."}
	headers := map[string]string{"Idempotency-Key": "test-only-preparation-key"}
	out := jsonRequest(t, h, "POST", "/v1/rwa/metadata-preparations", input, headers)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"executable":false`) || strings.Contains(out.Body.String(), "contractArguments") || strings.Contains(out.Body.String(), "contractFunction") {
		t.Fatalf("unsafe preparation: %d %s", out.Code, out.Body)
	}
	out = jsonRequest(t, h, "POST", "/v1/rwa/intents", input, headers)
	if out.Code != 422 {
		t.Fatalf("metadata-only mint %d", out.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/rwa/assets", nil)
	out = httptest.NewRecorder()
	h.ServeHTTP(out, req)
	if out.Code != 503 {
		t.Fatal("unconnected catalog invented live assets")
	}
}
