package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestMySQLUploadAndMintPreparationCrossLiveInstances(t *testing.T) {
	f, a, _, _, _ := catalogIntegrationFixture(t)
	a.config.registryAddress = "0x1111111111111111111111111111111111111111"
	a.config.publicBaseURL = "https://objects.example.test"
	b := newRWAService(a.config, a.store)
	b.db = f.db
	b.requireDB = true
	b.now = a.now
	b.grounding = a.grounding
	handlers := []http.Handler{newHandler(a), newHandler(b)}
	image, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	digest := sha256.Sum256(image)
	digestHex := hex.EncodeToString(digest[:])
	out := jsonRequest(t, handlers[0], "POST", "/v1/uploads/intents", map[string]any{"fileName": "TEST_ONLY.png", "contentType": "image/png", "sha256": digestHex, "size": len(image)}, nil)
	if out.Code != 201 {
		t.Fatalf("upload prepare %d %s", out.Code, out.Body)
	}
	var upload struct {
		ID  string `json:"uploadId"`
		URL string `json:"uploadUrl"`
	}
	decode(t, out, &upload)
	t.Cleanup(func() { f.db.Exec("DELETE FROM rwa_uploads WHERE upload_id=?", upload.ID) })
	// Node B existed before A created this upload and has no cached entry.
	if b.uploads[upload.ID] != nil {
		t.Fatal("fixture unexpectedly shares a cache")
	}
	request := httptest.NewRequest("PUT", upload.URL, bytes.NewReader(image))
	request.Header.Set("Content-Type", "image/png")
	request.Header.Set("Content-SHA256", digestHex)
	response := httptest.NewRecorder()
	handlers[1].ServeHTTP(response, request)
	if response.Code != 204 {
		t.Fatalf("second-node upload %d %s", response.Code, response.Body)
	}
	input := mintIntentRequest{UploadID: upload.ID, Recipient: f.owner.Session.Address, Name: "TEST_ONLY multi-instance upload", Artist: "Example maker", Year: 2026, Medium: "Synthetic PNG", Location: "Isolated test custody", Description: "TESTNET. NO REAL-WORLD VALUE. NO LEGAL EFFECT. Multi-instance upload fixture."}
	// A's cached upload is still pending; the durable completed record controls preparation.
	if a.uploads[upload.ID].Completed {
		t.Fatal("fixture no longer tests a stale cache")
	}
	for _, h := range handlers {
		out = jsonRequest(t, h, "POST", "/v1/rwa/metadata-preparations", input, map[string]string{"Idempotency-Key": "cluster-upload-" + upload.ID})
		if out.Code != 200 {
			t.Fatalf("cross-node completed preparation %d %s", out.Code, out.Body)
		}
	}
}

func TestMySQLVaultCrossInstanceReplayAndSubmission(t *testing.T) {
	f, a, asset, _, _ := catalogIntegrationFixture(t)
	a.config.vaultFactoryAddress = "0x1111111111111111111111111111111111111111"
	b := newRWAService(a.config, newMemoryObjectStore())
	b.db = f.db
	b.requireDB = true
	b.now = a.now
	b.grounding = a.grounding
	handlers := []http.Handler{newHandler(a), newHandler(b)}
	input := vaultIntentRequest{CollectionAddress: asset.Asset.Binding.CollectionAddress, TokenID: asset.Asset.Binding.TokenID, VaultName: "TEST_ONLY shared Vault", AdminAddress: f.owner.Session.Address, PauserAddress: f.owner.Session.Address, FractionalizerAddress: f.owner.Session.Address}
	key := "cluster-vault-" + randomID()
	headers := map[string]string{"Idempotency-Key": key}
	var wait sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for i := range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- jsonRequest(t, handlers[i%2], "POST", "/v1/vault/intents", input, headers)
		}()
	}
	wait.Wait()
	close(results)
	var saved vaultIntent
	for out := range results {
		if out.Code != 200 && out.Code != 201 {
			t.Fatalf("shared create %d %s", out.Code, out.Body)
		}
		var got vaultIntent
		decode(t, out, &got)
		if saved.IntentID != "" && saved.IntentID != got.IntentID {
			t.Fatal("duplicate Vault operation")
		}
		saved = got
	}
	t.Cleanup(func() { f.db.Exec("DELETE FROM vaults WHERE vault_id=?", saved.IntentID) })
	for _, h := range handlers {
		out := requestWithHandler(t, h, "GET", "/v1/vault/intents/"+saved.IntentID)
		if out.Code != 200 {
			t.Fatalf("cross-node lookup %d", out.Code)
		}
	}
	// Both nodes retain identical public submission recording across retries.
	hash := "0x" + strings.Repeat("c", 64)
	path := "/v1/vault/intents/" + saved.IntentID + "/submission"
	for _, h := range []http.Handler{handlers[1], handlers[0], handlers[1]} {
		out := jsonRequest(t, h, "POST", path, map[string]string{"transactionHash": hash}, nil)
		if out.Code != 200 {
			t.Fatalf("submission replay %d %s", out.Code, out.Body)
		}
	}
	out := jsonRequest(t, handlers[0], "POST", path, map[string]string{"transactionHash": "0x" + strings.Repeat("d", 64)}, nil)
	if out.Code != 409 {
		t.Fatalf("distinct submission status %d", out.Code)
	}
	current, err := b.readVaultIntent(context.Background(), saved.IntentID)
	if err != nil || current.TransactionHash != hash {
		t.Fatalf("shared result %v", err)
	}
	changed := input
	changed.VaultName = "Another reviewed Vault"
	if out = jsonRequest(t, handlers[1], "POST", "/v1/vault/intents", changed, headers); out.Code != 409 {
		t.Fatalf("changed request status %d", out.Code)
	}
}
