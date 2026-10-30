package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func syntheticReceiptClaims() NFTReceiptCapabilityClaims {
	return NFTReceiptCapabilityClaims{
		ReceiptPhase:              "funded",
		ReceiptNonce:              "0",
		ReceiptPlanDigest:         "0x" + strings.Repeat("3", 64),
		ReceiptJournalBindingHash: "0x" + strings.Repeat("4", 64),
	}
}

func TestNFTReceiptCapabilityTypedRoundTripAndLegacyReuse(t *testing.T) {
	for _, phase := range []string{"funded", "registered", "paid"} {
		for _, nonce := range []string{"0", "1", "9007199254740991"} {
			original := syntheticNFTRegistry(time.Now()).claims
			original.NFTReceiptCapabilityClaims = syntheticReceiptClaims()
			original.ReceiptPhase, original.ReceiptNonce = phase, nonce
			raw, err := json.Marshal(original)
			if err != nil {
				t.Fatal(err)
			}
			var decoded NFTTaskCapability
			if err := strictNFTJSON(raw, &decoded); err != nil || decoded != original {
				t.Fatalf("typed roundtrip %s/%s: %+v %v", phase, nonce, decoded, err)
			}
			present, err := decoded.receiptClaimsPresent()
			if !present || err != nil {
				t.Fatalf("typed facts lost: %v", err)
			}
			legacy := syntheticNFTRegistry(time.Now()).claims
			raw, _ = json.Marshal(legacy)
			if bytes.Contains(raw, []byte("receiptPhase")) {
				t.Fatal("absent group was serialized as a receipt")
			}
			if err := strictNFTJSON(raw, &decoded); err != nil || decoded != legacy {
				t.Fatalf("reused target retained old receipt facts: %v", err)
			}
		}
	}
}

func TestNFTReceiptCapabilityRejectsMalformedAtomicClaimGroups(t *testing.T) {
	base := syntheticNFTRegistry(time.Now()).claims
	base.NFTReceiptCapabilityClaims = syntheticReceiptClaims()
	valid, _ := json.Marshal(base)
	for _, field := range []string{"receiptPhase", "receiptNonce", "receiptPlanDigest", "receiptJournalBindingHash"} {
		for _, change := range []string{"missing", "null", "number", "empty", "array", "object"} {
			t.Run(field+"/"+change, func(t *testing.T) {
				var values map[string]json.RawMessage
				_ = json.Unmarshal(valid, &values)
				switch change {
				case "missing":
					delete(values, field)
				case "null":
					values[field] = json.RawMessage("null")
				case "number":
					values[field] = json.RawMessage("0")
				case "empty":
					values[field] = json.RawMessage(`""`)
				case "array":
					values[field] = json.RawMessage("[]")
				case "object":
					values[field] = json.RawMessage("{}")
				}
				raw, _ := json.Marshal(values)
				var decoded NFTTaskCapability
				if strictNFTJSON(raw, &decoded) == nil {
					t.Fatalf("accepted %s %s", field, change)
				}
			})
		}
	}
	cases := map[string]string{
		"phase alias":          strings.Replace(string(valid), `"funded"`, `"Funded"`, 1),
		"foreign phase":        strings.Replace(string(valid), `"funded"`, `"confirmed"`, 1),
		"leading zero":         strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"00"`, 1),
		"negative":             strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"-1"`, 1),
		"fraction":             strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"1.0"`, 1),
		"exponent":             strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"1e3"`, 1),
		"slot overflow":        strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"9007199254740992"`, 1),
		"uint256 overflow":     strings.Replace(string(valid), `"receiptNonce":"0"`, `"receiptNonce":"`+strings.Repeat("9", 79)+`"`, 1),
		"duplicate nonce":      strings.TrimSuffix(string(valid), "}") + `,"receiptNonce":"1"}`,
		"duplicate same phase": strings.TrimSuffix(string(valid), "}") + `,"receiptPhase":"funded"}`,
		"case alias":           strings.Replace(string(valid), `"receiptPhase"`, `"ReceiptPhase"`, 1),
		"unknown field":        strings.TrimSuffix(string(valid), "}") + `,"receiptPurpose":"read"}`,
		"trailing object":      string(valid) + "{}",
		"null capability":      "null",
	}
	for _, field := range []string{"receiptPlanDigest", "receiptJournalBindingHash"} {
		var values map[string]json.RawMessage
		_ = json.Unmarshal(valid, &values)
		for name, digest := range map[string]string{
			"zero":      "0x" + strings.Repeat("0", 64),
			"bare":      strings.Repeat("a", 64),
			"uppercase": "0x" + strings.Repeat("A", 64),
			"short":     "0x01",
		} {
			values[field], _ = json.Marshal(digest)
			raw, _ := json.Marshal(values)
			cases[field+"/"+name] = string(raw)
		}
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			var decoded NFTTaskCapability
			if strictNFTJSON([]byte(raw), &decoded) == nil {
				t.Fatalf("accepted malformed capability: %s", name)
			}
		})
	}
}

type receiptBoundaryDB struct {
	persistenceDB
	begins int
}

func (db *receiptBoundaryDB) BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error) {
	db.begins++
	return nil, errUserAuthUnavailable
}

func TestNFTReceiptCapabilityCannotReachSQLWithoutAuthoritativeBinding(t *testing.T) {
	now := time.Now()
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	for _, action := range []string{"get", "create", "update"} {
		for _, invalid := range []bool{false, true} {
			registry := syntheticNFTRegistry(now)
			registry.claims.NFTReceiptCapabilityClaims = syntheticReceiptClaims()
			if invalid {
				registry.claims.ReceiptNonce = "01"
			}
			db := &receiptBoundaryDB{}
			handler := newNFTTaskJournalHandler(&nftOperationStore{db: db, now: func() time.Time { return now }},
				peer, registry, func() time.Time { return now }, true)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, syntheticNFTTaskRequest(action, syntheticNFTTaskOperation()))
			want := 503
			if invalid {
				want = 403
			}
			if response.Code != want || db.begins != 0 || registry.calls != 1 || !registry.used ||
				response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("action=%s invalid=%v status=%d SQL=%d calls=%d",
					action, invalid, response.Code, db.begins, registry.calls)
			}
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, syntheticNFTTaskRequest(action, syntheticNFTTaskOperation()))
			if response.Code != 403 || db.begins != 0 {
				t.Fatal("unsupported receipt capability was replayed or reached SQL")
			}
		}
	}
}

func TestNFTReceiptPlanCannotDowngradeBeforeGetOrIdempotentReturn(t *testing.T) {
	task := syntheticNFTTaskPrincipal()
	principal := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, task: &task}
	now := time.Now()
	for _, key := range []string{"wholeReceipt", "WholeReceipt", "wholereceipt"} {
		for _, value := range []any{nil, map[string]any{"phase": "funded"}} {
			row := syntheticNFTTaskOperation()
			var plan map[string]any
			_ = json.Unmarshal(row.Plan, &plan)
			plan[key] = value
			row.Plan, _ = json.Marshal(plan)
			for _, action := range []string{"get", "create", "update"} {
				_, write, err := decideNFTMutation(principal, action, row, &row, now)
				if err == nil || write {
					t.Fatalf("downgraded stored receipt %s/%s", key, action)
				}
			}
			_, write, err := decideNFTMutation(principal, "create", row, nil, now)
			if err == nil || write {
				t.Fatal("created a receipt through ordinary task authority")
			}
		}
	}
	// Ordinary task listings retain their established repository lifecycle.
	row := syntheticNFTTaskOperation()
	stored, write, err := decideNFTMutation(principal, "create", row, nil, now)
	if err != nil || !write {
		t.Fatalf("ordinary task create refused: %v", err)
	}
	if _, write, err = decideNFTMutation(principal, "get", nftOperation{ID: row.ID}, &stored, now); err != nil || write {
		t.Fatalf("ordinary task read changed: %v", err)
	}
}
