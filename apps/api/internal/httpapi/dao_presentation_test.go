package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func exampleDAOPresentation() *daoPresentation {
	return &daoPresentation{Version: 1, Description: "TEST_ONLY descriptive profile", Avatar: daoAvatar{Text: "DAO", Palette: "teal"}}
}
func TestDAOPresentationValidationAndStorageDecode(t *testing.T) {
	if !validDAOPresentation(nil) {
		t.Fatal("legacy omission refused")
	}
	for _, text := range []string{"DAO", "中文", "A1"} {
		p := exampleDAOPresentation()
		p.Avatar.Text = text
		encoded, err := daoPresentationJSON(p)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := decodeDAOPresentation([]byte(encoded.(string)))
		if err != nil || !reflect.DeepEqual(decoded, p) {
			t.Fatalf("roundtrip %v", err)
		}
	}
	escaped := exampleDAOPresentation()
	escaped.Description = strings.Repeat("<", 2000)
	encoded, err := daoPresentationJSON(escaped)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = decodeDAOPresentation([]byte(encoded.(string))); err != nil {
		t.Fatal("valid HTML-escaped text exceeds incorrect storage bound", err)
	}
	for _, modify := range []func(*daoPresentation){
		func(p *daoPresentation) { p.Version = 2 },
		func(p *daoPresentation) { p.Description = strings.Repeat("界", 667) },
		func(p *daoPresentation) { p.Description = "private\x00text" },
		func(p *daoPresentation) { p.Avatar.Text = "FOUR" },
		func(p *daoPresentation) { p.Avatar.Text = "<b>" },
		func(p *daoPresentation) { p.Avatar.Palette = "https://test.invalid" },
	} {
		p := exampleDAOPresentation()
		modify(p)
		if validDAOPresentation(p) {
			t.Fatalf("invalid accepted %+v", p)
		}
	}
	for _, raw := range []string{`null`, `[]`, `{"version":1,"description":"","avatar":{"text":"DAO","palette":"teal"},"extra":true}`, `{"version":1,"description":"","avatar":{"text":"DAO","palette":"teal","src":"https://test.invalid"}}`, `{"version":1,"description":"","avatar":{"text":"DAO","palette":"teal"}} {}`} {
		if _, err := decodeDAOPresentation([]byte(raw)); err == nil {
			t.Fatal("invalid persisted profile accepted")
		}
	}
	if value, err := decodeDAOPresentation(nil); err != nil || value != nil {
		t.Fatal("SQL NULL legacy changed")
	}
}
func TestDAOPresentationOmissionKeepsLegacyPayloadBytes(t *testing.T) {
	input := vaultIntentRequest{CollectionAddress: "0x1111111111111111111111111111111111111111", TokenID: "1", VaultName: "TEST_ONLY Vault", AdminAddress: "0x2222222222222222222222222222222222222222", PauserAddress: "0x3333333333333333333333333333333333333333", FractionalizerAddress: "0x4444444444444444444444444444444444444444"}
	old := struct {
		CollectionAddress     string `json:"collectionAddress"`
		TokenID               string `json:"tokenId"`
		VaultName             string `json:"vaultName"`
		AdminAddress          string `json:"adminAddress"`
		PauserAddress         string `json:"pauserAddress"`
		FractionalizerAddress string `json:"fractionalizerAddress"`
	}{input.CollectionAddress, input.TokenID, input.VaultName, input.AdminAddress, input.PauserAddress, input.FractionalizerAddress}
	before, _ := json.Marshal(old)
	after, _ := json.Marshal(input)
	if !bytes.Equal(before, after) {
		t.Fatal("legacy payload/hash input changed")
	}
	input.Presentation = exampleDAOPresentation()
	withProfile, _ := json.Marshal(input)
	if bytes.Equal(before, withProfile) {
		t.Fatal("presentation not bound into hash input")
	}
}
func TestDAOPresentationCachedReadsAreIndependent(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.vaultIntents["test"] = &vaultIntent{IntentID: "test", Presentation: exampleDAOPresentation()}
	copy, err := service.readVaultIntent(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	copy.Presentation.Avatar.Text = "NEW"
	if service.vaultIntents["test"].Presentation.Avatar.Text != "DAO" {
		t.Fatal("mutable profile escaped cache")
	}
}
