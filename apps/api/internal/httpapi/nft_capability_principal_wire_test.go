package httpapi

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// All principals and claims are synthetic. These cases exercise the actual
// capability decoder, not a replacement JSON parser or a source authority.
func TestNFTTaskCapabilityPrincipalRejectsNonExactWire(t *testing.T) {
	base := syntheticNFTRegistry(time.Now()).claims
	base.NFTReceiptCapabilityClaims = syntheticReceiptClaims()
	raw, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		t.Fatal("synthetic envelope")
	}
	var principal map[string]json.RawMessage
	if json.Unmarshal(envelope["principal"], &principal) != nil {
		t.Fatal("synthetic principal")
	}
	for _, key := range []string{"kind", "taskId", "taskDigest", "executorDigest", "grantReference", "grantPolicyVersion", "operationId"} {
		for _, change := range []string{"alias", "duplicate", "missing", "null"} {
			t.Run(key+"/"+change, func(t *testing.T) {
				body := make(map[string]json.RawMessage)
				for k, v := range principal {
					body[k] = append(json.RawMessage(nil), v...)
				}
				switch change {
				case "alias":
					body[strings.ToUpper(key[:1])+key[1:]] = body[key]
					delete(body, key)
				case "missing":
					delete(body, key)
				case "null":
					body[key] = json.RawMessage("null")
				}
				p, _ := json.Marshal(body)
				if change == "duplicate" {
					p = append(bytes.TrimSuffix(p, []byte("}")), []byte(`,"`+key+`":`+string(principal[key])+`}`)...)
				}
				changed := make(map[string]json.RawMessage)
				for k, v := range envelope {
					changed[k] = v
				}
				changed["principal"] = p
				wire, _ := json.Marshal(changed)
				var decoded NFTTaskCapability
				if err := json.Unmarshal(wire, &decoded); err == nil {
					t.Fatal("accepted a non-exact nested capability principal")
				}
			})
		}
	}
	for _, bad := range []json.RawMessage{json.RawMessage("null"), json.RawMessage(`{}`), json.RawMessage(`[]`)} {
		changed := make(map[string]json.RawMessage)
		for k, v := range envelope {
			changed[k] = v
		}
		changed["principal"] = bad
		wire, _ := json.Marshal(changed)
		var decoded NFTTaskCapability
		if json.Unmarshal(wire, &decoded) == nil {
			t.Fatalf("accepted null/empty/non-object principal: %s", bad)
		}
	}
}

func TestNFTTaskCapabilityPrincipalPreservesListingAndReceiptWire(t *testing.T) {
	legacy := syntheticNFTRegistry(time.Now()).claims
	var decoded NFTTaskCapability
	for _, phase := range []string{"funded", "registered", "paid", ""} {
		original := legacy
		if phase != "" {
			original.NFTReceiptCapabilityClaims = syntheticReceiptClaims()
			original.ReceiptPhase = phase
		}
		raw, err := json.Marshal(original)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &decoded); err != nil || decoded != original {
			t.Fatalf("valid %q capability changed: %v", phase, err)
		}
		if phase == "" {
			present, err := decoded.receiptClaimsPresent()
			if present || err != nil {
				t.Fatal("listing inherited stale receipt fields")
			}
		}
	}
}
