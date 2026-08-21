package httpapi

import (
	"math/big"
	"testing"
)

func TestMarketOrchestrationSafetyHelpers(t *testing.T) {
	payload := map[string]any{
		"nested": map[string]any{
			"protocol_address": "0x1111111111111111111111111111111111111111",
		},
	}
	if got := findJSONText(payload, "protocol_address"); got != "0x1111111111111111111111111111111111111111" {
		t.Fatalf("protocol address not found: %q", got)
	}
	value := big.NewInt(1_000_000_000_000_000)
	if !consistentHexValue(value, "0x038d7ea4c68000") {
		t.Fatal("matching decimal and hexadecimal values were rejected")
	}
	if consistentHexValue(value, "0x00") || consistentHexValue(value, "not-hex") {
		t.Fatal("unsafe value encoding was accepted")
	}
}
