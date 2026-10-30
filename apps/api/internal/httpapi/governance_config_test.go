package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func governanceDescriptorTestDefaults() map[string]string {
	return map[string]string{
		"ARTFI_GOVERNOR_ADDRESS":         "0x" + strings.Repeat("01", 20),
		"ARTFI_GOVERNANCE_TOKEN_ADDRESS": "0x" + strings.Repeat("23", 20),
		"ARTFI_DAO_ACTIONS_ADDRESS":      "0x" + strings.Repeat("45", 20),
		"ARTFI_RWA_VAULT_ADDRESS":        "0x" + strings.Repeat("67", 20),
	}
}

func governanceDescriptorTestRequest(t *testing.T, values map[string]string) (governanceConfigResponse, map[string]json.RawMessage, string) {
	t.Helper()
	for name, value := range values {
		t.Setenv(name, value)
	}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	recorder := httptest.NewRecorder()
	// This is the real public route, with no wallet session or contract calls.
	newHandler(service).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/governance/config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("public governance descriptor returned HTTP %d", recorder.Code)
	}
	var result governanceConfigResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if result.ChainID != hoodiChainID ||
		result.MembershipAuthority != "onchain-rwa-token-snapshot" ||
		result.ProposalThresholdPPM != 100_000 ||
		!reflect.DeepEqual(result.ApprovalPPM, map[string]int{
			"marketMigration": 500_000,
			"physicalAction":  666_667,
			"forcedBuyout":    800_000,
		}) {
		t.Fatal("address validation changed the existing chain or governance rules")
	}
	return result, fields, recorder.Body.String()
}

func TestGovernancePublicDescriptorCanonicalizesAddresses(t *testing.T) {
	values := governanceDescriptorTestDefaults()
	values["ARTFI_GOVERNOR_ADDRESS"] = " \t0x" + strings.Repeat("aB", 20) + "\n"
	got, fields, _ := governanceDescriptorTestRequest(t, values)
	if !got.Enabled || len(fields) != 9 ||
		got.GovernorAddress != "0x"+strings.Repeat("ab", 20) ||
		got.TokenAddress != values["ARTFI_GOVERNANCE_TOKEN_ADDRESS"] ||
		got.ActionRegistryAddress != values["ARTFI_DAO_ACTIONS_ADDRESS"] ||
		got.VaultAddress != values["ARTFI_RWA_VAULT_ADDRESS"] {
		t.Fatal("valid public deployment addresses were not preserved canonically")
	}
}

func TestGovernancePublicDescriptorOmitsInvalidAddressFields(t *testing.T) {
	keys := map[string]string{
		"ARTFI_GOVERNOR_ADDRESS":         "governorAddress",
		"ARTFI_GOVERNANCE_TOKEN_ADDRESS": "tokenAddress",
		"ARTFI_DAO_ACTIONS_ADDRESS":      "actionRegistryAddress",
		"ARTFI_RWA_VAULT_ADDRESS":        "vaultAddress",
	}
	invalid := []struct {
		name, value string
	}{
		{"missing", ""},
		{"whitespace", " \t\n"},
		{"zero", "0x" + strings.Repeat("0", 40)},
		{"zero with whitespace", " \t0x" + strings.Repeat("0", 40) + "\n"},
		{"short", "0x" + strings.Repeat("e", 39)},
		{"long", "0x" + strings.Repeat("e", 41)},
		{"non hex", "0x" + strings.Repeat("e", 39) + "g"},
		{"private text", "private-invalid-deployment-descriptor"},
		{"oversized", strings.Repeat("private-invalid-", 512)},
		{"invalid utf8", string([]byte{0xff, 0xfe})},
	}
	for key, field := range keys {
		for _, item := range invalid {
			t.Run(key+"/"+item.name, func(t *testing.T) {
				values := governanceDescriptorTestDefaults()
				values[key] = item.value
				got, fields, body := governanceDescriptorTestRequest(t, values)
				if got.Enabled {
					t.Fatal("an incomplete or invalid address set was advertised as enabled")
				}
				if _, exists := fields[field]; exists || len(fields) != 8 {
					t.Fatal("invalid public address field was retained or other valid fields were lost")
				}
				// Whitespace-only input has no public value to compare; all other
				// nonempty test values are distinct from valid addresses/metadata.
				if strings.TrimSpace(item.value) != "" &&
					strings.Contains(body, item.value) {
					t.Fatal("invalid configuration text was published")
				}
				for otherKey, otherField := range keys {
					if otherKey == key {
						continue
					}
					var published string
					if err := json.Unmarshal(fields[otherField], &published); err != nil || published != values[otherKey] {
						t.Fatal("a different valid address field changed")
					}
				}
			})
		}
	}
}

func TestGovernancePublicDescriptorEmptyConfigurationStaysPublicAndDisabled(t *testing.T) {
	values := governanceDescriptorTestDefaults()
	for name := range values {
		values[name] = ""
	}
	got, fields, _ := governanceDescriptorTestRequest(t, values)
	if got.Enabled || len(fields) != 5 ||
		got.GovernorAddress != "" || got.TokenAddress != "" ||
		got.ActionRegistryAddress != "" || got.VaultAddress != "" {
		t.Fatal("missing configuration fabricated a deployment address")
	}
}

func TestGovernancePublicDescriptorPreservesValidPartialConfiguration(t *testing.T) {
	values := governanceDescriptorTestDefaults()
	values["ARTFI_GOVERNOR_ADDRESS"] = "private-invalid-partial-descriptor"
	values["ARTFI_DAO_ACTIONS_ADDRESS"] = "0x" + strings.Repeat("0", 40)
	values["ARTFI_RWA_VAULT_ADDRESS"] = ""
	got, fields, body := governanceDescriptorTestRequest(t, values)
	if got.Enabled || len(fields) != 6 || got.TokenAddress != values["ARTFI_GOVERNANCE_TOKEN_ADDRESS"] ||
		got.GovernorAddress != "" || got.ActionRegistryAddress != "" || got.VaultAddress != "" ||
		strings.Contains(body, values["ARTFI_GOVERNOR_ADDRESS"]) {
		t.Fatal("partial configuration exposed invalid inputs or lost the valid address")
	}
}
