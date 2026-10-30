package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Opt-in export of PUBLIC synthetic test inputs for a real Go/MySQL/browser
// integration. Normal test runs write nothing. The ephemeral private source key
// stays in memory; no secret or real external signature is exported.
func TestExportIsolatedRWACatalog(t *testing.T) {
	output := os.Getenv("ARTFI_EXPORT_RWA_FIXTURE")
	if output == "" {
		t.Skip("Set ARTFI_EXPORT_RWA_FIXTURE to export public TEST_ONLY envelopes")
	}
	if !filepath.IsAbs(output) {
		t.Fatal("fixture output must be an absolute path in the isolated test workspace")
	}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	key, source := syntheticRWASource(t, service)
	records := []rwaCatalogRecord{
		{Slug: "test-only-session-whole", Title: "TEST_ONLY whole receipt", Artist: "Example maker", Year: 2026, Medium: "Synthetic test artwork", Location: "TEST_ONLY custody", Description: "Isolated source-signed receipt record. No real asset or enforceable entitlement.", Section: "whole", Rights: "TEST_ONLY delivery-receipt simulation. No real-world title, delivery or redemption right.", Provenance: []string{"Ephemeral synthetic approved-source claim"}, Binding: rwaCatalogBinding{ChainID: 560048, CollectionAddress: "0x1000000000000000000000000000000000000002", TokenID: "1", AssetID: "TEST_ONLY/Whole/1", UnderlyingAssetID: "urn:test-only:session:whole", MarketAddress: "0x1000000000000000000000000000000000000001"}},
		{Slug: "test-only-session-fractional", Title: "TEST_ONLY fractional participation", Artist: "Example maker", Year: 2026, Medium: "Synthetic test artwork", Location: "TEST_ONLY custody", Description: "Isolated source-signed fractional record. No real asset or enforceable entitlement.", Section: "fractional", Rights: "TEST_ONLY participation simulation. No physical-title, delivery or redemption entitlement.", Provenance: []string{"Ephemeral synthetic approved-source claim"}, Binding: rwaCatalogBinding{ChainID: 560048, CollectionAddress: "0x1000000000000000000000000000000000000007", TokenID: "2", AssetID: "TEST_ONLY/Fraction/2", UnderlyingAssetID: "urn:test-only:session:fractional", FractionTokenAddress: "0x1000000000000000000000000000000000000004", VaultAddress: "0x1000000000000000000000000000000000000008", MarketAddress: "0x1000000000000000000000000000000000000003"}},
	}
	publications := make([]rwaCatalogMutation, 0, 2)
	for _, record := range records {
		if err := validateCatalogRecord(record); err != nil {
			t.Fatal(err)
		}
		e := syntheticEvidence(t, service, key, source, catalogContextHash(record), record.Section)
		e.Rights = record.Rights
		e.UnderlyingAssetID = record.Binding.UnderlyingAssetID
		e.ValidUntil = service.now().Unix() + 86400
		e.SignatureR, e.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(e))
		if err := service.grounding.verify(e, catalogContextHash(record), record.Section, service.now(), false); err != nil {
			t.Fatal(err)
		}
		publications = append(publications, rwaCatalogMutation{Asset: record, Evidence: e})
	}
	body, err := json.MarshalIndent(struct {
		Mode         string               `json:"mode"`
		TestLabels   []string             `json:"testLabels"`
		Sources      []approvedRWASource  `json:"sources"`
		Publications []rwaCatalogMutation `json:"publications"`
	}{"TEST_ONLY", []string{"TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"}, []approvedRWASource{source}, publications}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(output, append(body, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("Exported only public TEST_ONLY source roots and two signed publication envelopes; private signing material remained in test memory.")
}
