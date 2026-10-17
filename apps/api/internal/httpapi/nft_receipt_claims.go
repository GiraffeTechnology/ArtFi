package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

// NFTReceiptCapabilityClaims retains the producer's flat wire names. These are
// consumed authority facts, never request fields or a persisted bearer token.
// Successful decoding is structural validation, not receipt authorization.
type NFTReceiptCapabilityClaims struct {
	ReceiptPhase string `json:"receiptPhase,omitempty"`
	ReceiptNonce string `json:"receiptNonce,omitempty"`
	ReceiptPlanDigest string `json:"receiptPlanDigest,omitempty"`
	ReceiptJournalBindingHash string `json:"receiptJournalBindingHash,omitempty"`
}

var nftReceiptNonce = regexp.MustCompile(`^(0|[1-9][0-9]{0,15})$`)

func (claims NFTReceiptCapabilityClaims) receiptClaimsPresent() (bool, error) {
	present := claims.ReceiptPhase != "" || claims.ReceiptNonce != "" ||
		claims.ReceiptPlanDigest != "" || claims.ReceiptJournalBindingHash != ""
	if !present {
		return false, nil
	}
	if claims.ReceiptPhase != "funded" && claims.ReceiptPhase != "registered" && claims.ReceiptPhase != "paid" {
		return true, errUserForbidden
	}
	// The producer freezes a canonical decimal string and bounds its phase slot
	// to MAX_SAFE_INTEGER. Compare decimal strings without a float conversion.
	nonce := claims.ReceiptNonce
	if !nftReceiptNonce.MatchString(nonce) || len(nonce) == 16 && nonce > "9007199254740991" {
		return true, errUserForbidden
	}
	for _, digest := range []string{claims.ReceiptPlanDigest, claims.ReceiptJournalBindingHash} {
		if !nftTaskDigest.MatchString(digest) || digest == "0x"+strings.Repeat("0", 64) {
			return true, errUserForbidden
		}
	}
	return true, nil
}

// UnmarshalJSON rejects duplicate, aliased, null and incomplete receipt fields.
// It also retains the existing unknown-field/EOF policy for the whole capability.
// Use an alias to avoid recursively calling this method.
func (claims *NFTTaskCapability) UnmarshalJSON(raw []byte) error {
	if claims == nil {
		return errUserForbidden
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errUserForbidden
	}
	allowed := map[string]bool{
		"peerId": true, "action": true, "nativeOperationId": true,
		"planDigest": true, "requestDigest": true, "principal": true,
		"wallet": true, "chainId": true, "issuedAtMs": true, "expiresAtMs": true,
		"receiptPhase": true, "receiptNonce": true,
		"receiptPlanDigest": true, "receiptJournalBindingHash": true,
	}
	seen := make(map[string]bool)
	receiptFields := 0
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] || seen[key] {
			return errUserForbidden
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return errUserForbidden
		}
		if strings.HasPrefix(key, "receipt") {
			receiptFields++
			var text string
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &text) != nil || text == "" {
				return errUserForbidden
			}
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return errUserForbidden
	}
	var extra any
	if err = decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errUserForbidden
	}
	if receiptFields != 0 && receiptFields != 4 {
		return errUserForbidden
	}
	type capabilityWire NFTTaskCapability
	var decoded capabilityWire
	if strictNFTJSON(raw, &decoded) != nil {
		return errUserForbidden
	}
	if _, err := decoded.NFTReceiptCapabilityClaims.receiptClaimsPresent(); err != nil {
		return err
	}
	// Do not leave stale receipt facts in a reused target on a successful decode.
	*claims = NFTTaskCapability(decoded)
	return nil
}
