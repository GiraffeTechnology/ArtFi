package httpapi

import (
    "encoding/json"
    "strings"
    "testing"
    "time"
)

// Exact authenticated Wallet receipt claim shape; TEST_ONLY principal.
func TestNFTReceiptConsumedClaimWire(t *testing.T) {
    claims := syntheticNFTRegistry(time.Now()).claims
    raw, err := json.Marshal(claims)
    if err != nil { t.Fatal(err) }
    var body map[string]any
    if json.Unmarshal(raw, &body) != nil { t.Fatal("claim fixture encoding") }
    fields := map[string]string{
        "receiptPhase": "funded",
        "receiptNonce": "0",
        "receiptPlanDigest": "0x" + strings.Repeat("3", 64),
        "receiptJournalBindingHash": "0x" + strings.Repeat("4", 64),
    }
    for key, value := range fields { body[key] = value }
    raw, _ = json.Marshal(body)
    var result NFTTaskCapability
    if err := strictNFTJSON(raw, &result); err != nil {
        t.Fatalf("authenticated four-field receipt claim refused: %v", err)
    }
    roundTrip, _ := json.Marshal(result)
    var decoded map[string]any
    _ = json.Unmarshal(roundTrip, &decoded)
    for key, value := range fields {
        if decoded[key] != value { t.Fatalf("receipt field %s lost or coerced", key) }
    }
    body["unexpectedReceiptAuthority"] = "TEST_ONLY"
    raw, _ = json.Marshal(body)
    if strictNFTJSON(raw, &result) == nil { t.Fatal("unknown claim field accepted") }
    delete(body, "unexpectedReceiptAuthority")
    body["receiptNonce"] = 0
    raw, _ = json.Marshal(body)
    if strictNFTJSON(raw, &result) == nil { t.Fatal("numeric nonce coerced to canonical string") }
}
