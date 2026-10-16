package httpapi

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func validNFTTaskReceiptClaims() NFTTaskCapability {
	return NFTTaskCapability{
		ReceiptPhase:              "funded",
		ReceiptNonce:              "9007199254740991",
		ReceiptPlanDigest:         "0x" + strings.Repeat("a", 64),
		ReceiptJournalBindingHash: "0x" + strings.Repeat("b", 64),
	}
}

func TestNFTTaskReceiptClaimsAcceptCanonicalWalletCommitments(t *testing.T) {
	for _, phase := range []string{"funded", "registered", "paid"} {
		claims := validNFTTaskReceiptClaims()
		claims.ReceiptPhase = phase
		if err := validateNFTTaskReceiptClaims(claims); err != nil {
			t.Fatalf("phase %q refused: %v", phase, err)
		}
	}
	claims := validNFTTaskReceiptClaims()
	claims.ReceiptNonce = "0"
	if err := validateNFTTaskReceiptClaims(claims); err != nil {
		t.Fatalf("zero uint nonce refused: %v", err)
	}
}

func TestNFTTaskReceiptClaimsRejectMissingOrMalformedFields(t *testing.T) {
	cases := map[string]func(*NFTTaskCapability){
		"missing phase": func(c *NFTTaskCapability) { c.ReceiptPhase = "" },
		"missing nonce": func(c *NFTTaskCapability) { c.ReceiptNonce = "" },
		"missing plan digest": func(c *NFTTaskCapability) { c.ReceiptPlanDigest = "" },
		"missing journal binding": func(c *NFTTaskCapability) { c.ReceiptJournalBindingHash = "" },
		"zero plan digest": func(c *NFTTaskCapability) { c.ReceiptPlanDigest = "0x" + strings.Repeat("0", 64) },
		"zero journal binding": func(c *NFTTaskCapability) { c.ReceiptJournalBindingHash = "0x" + strings.Repeat("0", 64) },
		"unknown phase": func(c *NFTTaskCapability) { c.ReceiptPhase = "settled" },
		"phase case changed": func(c *NFTTaskCapability) { c.ReceiptPhase = "Funded" },
		"leading zero nonce": func(c *NFTTaskCapability) { c.ReceiptNonce = "01" },
		"non decimal nonce": func(c *NFTTaskCapability) { c.ReceiptNonce = "+1" },
		"unsafe nonce": func(c *NFTTaskCapability) { c.ReceiptNonce = "9007199254740992" },
		"plan digest without prefix": func(c *NFTTaskCapability) { c.ReceiptPlanDigest = strings.Repeat("a", 64) },
		"uppercase plan digest": func(c *NFTTaskCapability) { c.ReceiptPlanDigest = "0x" + strings.Repeat("A", 64) },
		"short journal binding": func(c *NFTTaskCapability) { c.ReceiptJournalBindingHash = "0x" + strings.Repeat("b", 63) },
		"non hex journal binding": func(c *NFTTaskCapability) { c.ReceiptJournalBindingHash = "0x" + strings.Repeat("g", 64) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			claims := validNFTTaskReceiptClaims()
			mutate(&claims)
			if err := validateNFTTaskReceiptClaims(claims); !errors.Is(err, errUserForbidden) {
				t.Fatalf("invalid claim accepted: %v", err)
			}
		})
	}
}

func TestNFTTaskHandlerRejectsInvalidReceiptClaimsBeforeJournalAccess(t *testing.T) {
	now := time.Now()
	peer, err := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*NFTTaskCapability){
		"missing nonce": func(c *NFTTaskCapability) { c.ReceiptNonce = "" },
		"partial claims": func(c *NFTTaskCapability) { c.ReceiptJournalBindingHash = "" },
		"invalid digest": func(c *NFTTaskCapability) { c.ReceiptPlanDigest = "0xabc" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			registry := syntheticNFTRegistry(now)
			registry.mutate = mutate
			handler := newNFTTaskJournalHandler(
				&nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }},
				peer, registry, func() time.Time { return now }, true,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
			if response.Code != 403 {
				t.Fatalf("invalid receipt claims reached journal: status=%d body=%s", response.Code, response.Body.String())
			}
			if registry.calls != 1 {
				t.Fatalf("capability consume count=%d", registry.calls)
			}
		})
	}
}
