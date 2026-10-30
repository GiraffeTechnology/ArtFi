package httpapi

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func catalogIntegrationFixture(t *testing.T) (administrationFixture, *rwaService, rwaCatalogMutation, *ecdsa.PrivateKey, approvedRWASource) {
	t.Helper()
	f := administrationIntegrationFixture(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = f.db
	service.requireDB = true
	service.now = f.auth.now
	key, source := syntheticRWASource(t, service)
	t.Setenv("ARTFI_ADMIN_WALLETS", f.admin.Session.Address)
	mux := http.NewServeMux()
	f.service.registerRoutes(mux)
	registerRWACatalog(mux, service, f.auth)
	f.handler = mux
	id := randomID()
	input := rwaCatalogMutation{Asset: rwaCatalogRecord{Slug: "asset-" + id, Title: "TEST_ONLY artwork " + id, Artist: "Example maker", Year: 2026, Medium: "Example pigment", Location: "Example custody location", Description: "TEST_ONLY source-grounding integration record, without real property rights.", Section: "whole", Rights: "TEST_ONLY source correspondence. No real-world entitlement.", Provenance: []string{"Synthetic source custody reference"}, Binding: rwaCatalogBinding{ChainID: hoodiChainID, CollectionAddress: "0x" + randomID() + "aAbB0011", TokenID: "17", AssetID: "Registry/Exact-Case-ID", UnderlyingAssetID: "urn:test-only:underlying:" + id, MarketAddress: "0x" + randomID() + "00110022"}}}
	input.Evidence = syntheticEvidence(t, service, key, source, catalogContextHash(input.Asset), input.Asset.Section)
	input.Evidence.Rights = input.Asset.Rights
	input.Evidence.UnderlyingAssetID = input.Asset.Binding.UnderlyingAssetID
	input.Evidence.SignatureR, input.Evidence.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(input.Evidence))
	out := f.request("PUT", "/v1/admin/rwa/assets/"+input.Asset.Slug, f.admin, "publish-"+id, input)
	if out.Code != 201 {
		t.Fatalf("catalog fixture: %d %s", out.Code, out.Body)
	}
	t.Cleanup(func() {
		// Scoped synthetic source cleanup; never delete a user's live catalog.
		for _, q := range []string{"DELETE FROM rwa_catalog_assets WHERE source_id=?", "DELETE FROM rwa_source_revocations WHERE source_id=?", "DELETE FROM rwa_evidence_locks WHERE source_id=?"} {
			if _, err := f.db.Exec(q, source.ID); err != nil {
				t.Error(err)
			}
		}
		actor := sha256.Sum256([]byte(source.ID))
		f.db.Exec("DELETE FROM security_audit_log WHERE actor_hash=?", actor[:])
	})
	return f, service, input, key, source
}
func resignCatalog(t *testing.T, key *ecdsa.PrivateKey, input *rwaCatalogMutation) {
	input.Evidence.ContextHash = catalogContextHash(input.Asset)
	input.Evidence.EvidenceID = hashText(randomID())
	input.Evidence.UnderlyingAssetID = input.Asset.Binding.UnderlyingAssetID
	input.Evidence.Rights = input.Asset.Rights
	input.Evidence.Section = input.Asset.Section
	input.Evidence.SignatureR, input.Evidence.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(input.Evidence))
}
func TestMySQLRWACatalogSourceVerificationRoleBindingAndRestart(t *testing.T) {
	f, service, input, key, source := catalogIntegrationFixture(t)
	path := "/v1/admin/rwa/assets/" + input.Asset.Slug
	for _, tokens := range []*userAuthTokens{nil, f.owner, f.other} {
		out := f.request("PUT", path, tokens, "unauthorized-"+randomID(), input)
		if out.Code != 401 && out.Code != 403 {
			t.Fatalf("unauthorized activation %d", out.Code)
		}
	}
	tampered := input
	tampered.Asset.Binding.CollectionAddress = "0x" + strings.Repeat("3", 40)
	tampered.Revision = 1
	if out := f.request("PUT", path, f.admin, "tampered-"+randomID(), tampered); out.Code != 422 {
		t.Fatalf("unsigned association accepted: %d %s", out.Code, out.Body)
	}
	out := f.request("GET", "/v1/rwa/assets/"+input.Asset.Slug, nil, "", nil)
	if out.Code != 200 {
		t.Fatal(out.Body)
	}
	var asset rwaCatalogAsset
	decode(t, out, &asset)
	if asset.Grounding.Status != "verified" || asset.Binding.CollectionAddress != input.Asset.Binding.CollectionAddress || asset.Binding.AssetID != "Registry/Exact-Case-ID" || asset.Grounding.Mode != "TEST_ONLY" {
		t.Fatalf("identity/signature projection: %+v", asset)
	}
	input.Revision = 1
	input.Asset.Description += " Source-approved metadata update."
	resignCatalog(t, key, &input)
	out = f.request("PUT", path, f.admin, "update-"+randomID(), input)
	if out.Code != 200 {
		t.Fatalf("signed update: %d %s", out.Code, out.Body)
	}
	// New service process reads durable rows and recomputes trust, never caches activation.
	restarted := newRWAService(rwaConfig{}, newMemoryObjectStore())
	restarted.db = f.db
	restarted.now = service.now
	restarted.grounding = service.grounding
	mux := http.NewServeMux()
	registerRWACatalog(mux, restarted, f.auth)
	out = requestWithHandler(t, mux, "GET", "/v1/rwa/assets/"+input.Asset.Slug)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"revision":2`) {
		t.Fatalf("restart lost catalog %d %s", out.Code, out.Body)
	}
	source.Disabled = true
	restarted.grounding.sources[source.ID] = source
	out = requestWithHandler(t, mux, "GET", "/v1/rwa/assets/"+input.Asset.Slug)
	if !strings.Contains(out.Body.String(), `"status":"source-unavailable"`) {
		t.Fatal("withdrawn trust root remained active")
	}
}
func TestMySQLRWACatalogUniqueSourceUnderlyingTokensAndFractions(t *testing.T) {
	f, _, input, key, _ := catalogIntegrationFixture(t)
	for _, kind := range []string{"source", "underlying", "token"} {
		copy := input
		copy.Asset.Slug = "duplicate-" + randomID()
		copy.Evidence.SourceAssetID = "new-source-" + randomID()
		copy.Asset.Binding.UnderlyingAssetID = "urn:test-only:new:" + randomID()
		copy.Asset.Binding.CollectionAddress = "0x" + randomID() + "12345678"
		if kind == "source" {
			copy.Evidence.SourceAssetID = input.Evidence.SourceAssetID
		}
		if kind == "underlying" {
			copy.Asset.Binding.UnderlyingAssetID = input.Asset.Binding.UnderlyingAssetID
		}
		if kind == "token" {
			copy.Asset.Binding.CollectionAddress = strings.ToLower(input.Asset.Binding.CollectionAddress)
		}
		resignCatalog(t, key, &copy)
		if out := f.request("PUT", "/v1/admin/rwa/assets/"+copy.Asset.Slug, f.admin, "unique-"+randomID(), copy); out.Code != 409 {
			t.Fatalf("duplicate %s status %d %s", kind, out.Code, out.Body)
		}
	}
	fraction := input
	fraction.Asset.Slug = "fraction-" + randomID()
	fraction.Asset.Section = "fractional"
	fraction.Asset.Binding.VaultAddress = "0x" + randomID() + "11112222"
	fraction.Asset.Binding.FractionTokenAddress = "0x" + randomID() + "aAbBcCdD"
	resignCatalog(t, key, &fraction)
	out := f.request("PUT", "/v1/admin/rwa/assets/"+fraction.Asset.Slug, f.admin, "fraction-"+randomID(), fraction)
	if out.Code != 201 {
		t.Fatalf("source-signed model %d %s", out.Code, out.Body)
	}
	out = f.request("GET", "/v1/rwa/assets?section=fractional&fractionTokenAddress="+strings.ToLower(fraction.Asset.Binding.FractionTokenAddress), nil, "", nil)
	if out.Code != 200 || !strings.Contains(out.Body.String(), fraction.Asset.Slug) {
		t.Fatalf("fraction binding lookup %d %s", out.Code, out.Body)
	}
	fraction.Asset.Slug = "other-fraction-" + randomID()
	fraction.Evidence.SourceAssetID = "other"
	fraction.Asset.Binding.UnderlyingAssetID = "urn:other:" + randomID()
	fraction.Asset.Binding.CollectionAddress = "0x" + randomID() + "87654321"
	resignCatalog(t, key, &fraction)
	if out := f.request("PUT", "/v1/admin/rwa/assets/"+fraction.Asset.Slug, f.admin, "fraction-"+randomID(), fraction); out.Code != 409 {
		t.Fatalf("fraction token assigned twice %d %s", out.Code, out.Body)
	}
}
func TestMySQLRWACatalogIdempotencyConcurrentRevisionAndAudit(t *testing.T) {
	f, _, input, key, _ := catalogIntegrationFixture(t)
	input.Revision = 1
	input.Asset.Description += " Source-approved concurrent update."
	resignCatalog(t, key, &input)
	path := "/v1/admin/rwa/assets/" + input.Asset.Slug
	idempotency := "concurrent-" + randomID()
	var wg sync.WaitGroup
	codes := make(chan int, 5)
	for range 5 {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- f.request("PUT", path, f.admin, idempotency, input).Code }()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 200 {
			t.Fatalf("concurrent replay %d", code)
		}
	}
	out := f.request("GET", "/v1/rwa/assets/"+input.Asset.Slug, nil, "", nil)
	if !strings.Contains(out.Body.String(), `"revision":2`) {
		t.Fatal("duplicate mutation")
	}
	var count int
	resource := sha256.Sum256([]byte(input.Asset.Slug))
	if err := f.db.QueryRow("SELECT COUNT(*) FROM security_audit_log WHERE resource_hash=? AND action='rwa.catalog.activated'", resource[:]).Scan(&count); err != nil || count != 2 {
		t.Fatalf("audit count %d err %v", count, err)
	}
	changed := input
	changed.Asset.Title = "Changed payload"
	resignCatalog(t, key, &changed)
	if out = f.request("PUT", path, f.admin, idempotency, changed); out.Code != 409 {
		t.Fatalf("idempotency payload conflict %d", out.Code)
	}
	if out = f.request("PUT", path, f.admin, "stale-revision-"+randomID(), input); out.Code != 409 {
		t.Fatalf("stale revision accepted %d", out.Code)
	}
	if err := f.auth.revokeUserSession(context.Background(), f.admin.Session.ID, ""); err != nil {
		t.Fatal(err)
	}
	if out = f.request("PUT", path, f.admin, idempotency, input); out.Code != 401 {
		t.Fatal("revoked session wrote catalog")
	}
}
func TestMySQLRWASourceRevocationPersistenceAndFailClosedRenewal(t *testing.T) {
	f, service, input, key, source := catalogIntegrationFixture(t)
	revoke := rwaRevocation{SourceID: source.ID, EvidenceID: input.Evidence.EvidenceID, RevokedAt: service.now().Unix(), Reason: "TEST_ONLY source correction", Mode: "TEST_ONLY"}
	digest := abiHash(hashText(revocationDomain), hashText(revoke.SourceID), revoke.EvidenceID, intWord(revoke.RevokedAt), hashText(revoke.Reason), hashText(revoke.Mode))
	revoke.SignatureR, revoke.SignatureS = signSyntheticDigest(t, key, digest)
	forged := revoke
	forged.Reason += "tampered"
	if out := f.request("POST", "/v1/rwa/source-revocations", nil, "", forged); out.Code != 422 {
		t.Fatalf("forged revoke %d", out.Code)
	}
	for range 2 {
		if out := f.request("POST", "/v1/rwa/source-revocations", nil, "", revoke); out.Code != 200 {
			t.Fatalf("source revoke %d %s", out.Code, out.Body)
		}
	}
	out := f.request("GET", "/v1/rwa/assets/"+input.Asset.Slug, nil, "", nil)
	if !strings.Contains(out.Body.String(), `"status":"revoked"`) {
		t.Fatalf("revocation not projected: %s", out.Body)
	}
	input.Revision = 1
	if out = f.request("PUT", "/v1/admin/rwa/assets/"+input.Asset.Slug, f.admin, "revoked-"+randomID(), input); out.Code != 409 {
		t.Fatalf("revoked evidence activated %d %s", out.Code, out.Body)
	}
	if service.requireGroundedUnderlying(context.Background(), input.Asset.Binding.CollectionAddress, input.Asset.Binding.TokenID) == nil {
		t.Fatal("revoked underlying accepted for fractions")
	}
	input.Evidence.ValidFrom = service.now().Unix() - 10
	input.Evidence.ValidUntil = service.now().Unix() + 100
	resignCatalog(t, key, &input)
	if out = f.request("PUT", "/v1/admin/rwa/assets/"+input.Asset.Slug, f.admin, "renewal-"+randomID(), input); out.Code != 200 {
		t.Fatalf("independently signed replacement %d %s", out.Code, out.Body)
	}
	service.now = func() time.Time { return time.Unix(input.Evidence.ValidUntil, 0) }
	out = f.request("GET", "/v1/rwa/assets/"+input.Asset.Slug, nil, "", nil)
	if !strings.Contains(out.Body.String(), `"status":"expired"`) {
		t.Fatal("expired evidence stayed active")
	}
}
func TestMySQLRWACatalogQueriesAndUnsignedPreview(t *testing.T) {
	f, _, input, _, _ := catalogIntegrationFixture(t)
	out := f.request("POST", "/v1/admin/rwa/catalog-drafts", f.admin, "", input.Asset)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"executable":false`) {
		t.Fatalf("proposal %d %s", out.Code, out.Body)
	}
	for _, query := range []string{"?sort=updated&pageSize=1", "?q=TEST_ONLY&section=whole", "?chainId=560048&collectionAddress=" + input.Asset.Binding.CollectionAddress + "&tokenId=17"} {
		out = f.request("GET", "/v1/rwa/assets"+query, nil, "", nil)
		if out.Code != 200 {
			t.Fatalf("query %s %d", query, out.Code)
		}
		var page struct {
			Data  []rwaCatalogAsset `json:"data"`
			Total int               `json:"total"`
		}
		if json.Unmarshal(out.Body.Bytes(), &page) != nil || page.Total < 1 {
			t.Fatal("catalog records not readable")
		}
	}
	for _, query := range []string{"?sort=bad", "?chainId=1", "?tokenId=01", "?section=nft", "?section=whole&section=fractional", "?fractionTokenAddress=invalid"} {
		if out = f.request("GET", "/v1/rwa/assets"+query, nil, "", nil); out.Code != 400 {
			t.Fatalf("invalid query %s %d", query, out.Code)
		}
	}
}

func TestMySQLRWAGroundedMintRestartConcurrencyRevocationAndUnderlyingUniqueness(t *testing.T) {
	f, service, _, key, source := catalogIntegrationFixture(t)
	service.config.registryAddress = "0x" + randomID() + "12121212"
	service.config.publicBaseURL = "https://objects.example.test"
	upload := &uploadSession{ID: randomID(), ObjectKey: "test-only/" + randomID() + ".png", FileName: "test.png", ContentType: "image/png", SHA256: strings.Repeat("a", 64), Size: 68, Completed: true, CreatedAt: service.now()}
	service.uploads[upload.ID] = upload
	if err := service.persistUpload(context.Background(), upload); err != nil {
		t.Fatal(err)
	}
	if err := service.persistUploadCompletion(context.Background(), upload.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.db.Exec("DELETE e FROM rwa_mint_evidence e JOIN rwa_mint_intents i ON i.intent_id=e.intent_id WHERE i.upload_id=?", upload.ID)
		f.db.Exec("DELETE FROM rwa_mint_intents WHERE upload_id=?", upload.ID)
		f.db.Exec("DELETE FROM rwa_uploads WHERE upload_id=?", upload.ID)
	})
	handler := newHandler(service)
	input := mintIntentRequest{UploadID: upload.ID, Recipient: f.owner.Session.Address, Name: "TEST_ONLY grounded issuance", Artist: "Example maker", Year: 2026, Medium: "Test medium", Location: "Test custody", Description: "Synthetic source-attested issuance for isolated testing only."}
	headers := map[string]string{"Idempotency-Key": "grounded-mint-" + randomID()}
	out := jsonRequest(t, handler, "POST", "/v1/rwa/metadata-preparations", input, headers)
	if out.Code != 200 {
		t.Fatal(out.Body)
	}
	var draft rwaMetadataPreparation
	decode(t, out, &draft)
	proof := syntheticEvidence(t, service, key, source, draft.ContextHash, "fractional")
	input.Evidence = &proof
	restarted := newRWAService(service.config, newMemoryObjectStore())
	restarted.db = f.db
	restarted.requireDB = true
	restarted.now = service.now
	restarted.grounding = service.grounding
	if err := restarted.hydratePersistence(context.Background()); err != nil {
		t.Fatal(err)
	}
	handlers := []http.Handler{handler, newHandler(restarted)}
	var wg sync.WaitGroup
	codes := make(chan int, 6)
	bodies := make(chan string, 6)
	for i := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := jsonRequest(t, handlers[i%2], "POST", "/v1/rwa/intents", input, headers)
			codes <- out.Code
			bodies <- out.Body.String()
		}()
	}
	wg.Wait()
	close(codes)
	close(bodies)
	for code := range codes {
		if code != 200 && code != 201 {
			t.Fatalf("cross-process mint replay %d", code)
		}
	}
	var intent mintIntent
	for body := range bodies {
		var got mintIntent
		if json.Unmarshal([]byte(body), &got) != nil {
			t.Fatal("invalid mint response")
		}
		if intent.IntentID != "" && intent.IntentID != got.IntentID {
			t.Fatal("duplicate intent")
		}
		intent = got
	}
	var count int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM rwa_mint_intents WHERE upload_id=?", upload.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("mint count %d %v", count, err)
	}
	fresh := newRWAService(service.config, newMemoryObjectStore())
	fresh.db = f.db
	fresh.requireDB = true
	fresh.now = service.now
	fresh.grounding = service.grounding
	if err := fresh.hydratePersistence(context.Background()); err != nil {
		t.Fatal(err)
	}
	out = requestWithHandler(t, newHandler(fresh), "GET", "/v1/rwa/intents/"+intent.IntentID)
	if out.Code != 200 || !strings.Contains(out.Body.String(), "createAssetWithEvidence") || !strings.Contains(out.Body.String(), proof.EvidenceID) {
		t.Fatalf("source evidence lost on restart: %d %s", out.Code, out.Body)
	}
	// Another source-approved request cannot create a second token for this underlying.
	secondHeaders := map[string]string{"Idempotency-Key": "second-mint-" + randomID()}
	out = jsonRequest(t, handler, "POST", "/v1/rwa/metadata-preparations", input, secondHeaders)
	decode(t, out, &draft)
	secondProof := proof
	secondProof.EvidenceID = hashText(randomID())
	secondProof.ContextHash = draft.ContextHash
	secondProof.SignatureR, secondProof.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(secondProof))
	second := input
	second.Evidence = &secondProof
	if out = jsonRequest(t, handler, "POST", "/v1/rwa/intents", second, secondHeaders); out.Code != 409 {
		t.Fatalf("duplicate underlying issuance %d %s", out.Code, out.Body)
	}
	revocation := rwaRevocation{SourceID: source.ID, EvidenceID: proof.EvidenceID, RevokedAt: service.now().Unix(), Reason: "TEST_ONLY issuance revoked", Mode: "TEST_ONLY"}
	digest := abiHash(hashText(revocationDomain), hashText(source.ID), proof.EvidenceID, intWord(revocation.RevokedAt), hashText(revocation.Reason), hashText(revocation.Mode))
	revocation.SignatureR, revocation.SignatureS = signSyntheticDigest(t, key, digest)
	if out = jsonRequest(t, handler, "POST", "/v1/rwa/source-revocations", revocation, nil); out.Code != 200 {
		t.Fatal(out.Body)
	}
	if out = requestWithHandler(t, newHandler(fresh), "GET", "/v1/rwa/intents/"+intent.IntentID); out.Code != 409 {
		t.Fatalf("revoked prepared intent executable %d", out.Code)
	}
	if out = jsonRequest(t, handler, "POST", "/v1/rwa/intents", input, headers); out.Code != 409 {
		t.Fatalf("cached replay bypassed revocation %d", out.Code)
	}
}

func TestMySQLRWAOrdinaryAuthenticatedPublisherNeedsSourceNotAdmin(t *testing.T) {
	f, _, input, key, _ := catalogIntegrationFixture(t)
	if out := f.request("POST", "/v1/user/rwa/catalog-drafts", f.owner, "", input.Asset); out.Code != 200 {
		t.Fatalf("ordinary proposal %d %s", out.Code, out.Body)
	}
	input.Revision = 1
	input.Asset.Description += " New source-approved public description."
	resignCatalog(t, key, &input)
	if out := f.request("PUT", "/v1/user/rwa/assets/"+input.Asset.Slug, f.owner, "ordinary-publication-"+randomID(), input); out.Code != 200 {
		t.Fatalf("ordinary publisher blocked %d %s", out.Code, out.Body)
	}
	bad := input
	bad.Revision = 2
	bad.Asset.Description += " Unapproved alteration."
	if out := f.request("PUT", "/v1/user/rwa/assets/"+input.Asset.Slug, f.owner, "ordinary-unapproved-"+randomID(), bad); out.Code != 422 {
		t.Fatalf("ordinary user minted authenticity %d", out.Code)
	}
}

func TestMySQLRWAUnderlyingStatusTracksCurrentSource(t *testing.T) {
	f, service, input, _, _ := catalogIntegrationFixture(t)
	path := "/v1/rwa/underlying-status?chainId=560048&collectionAddress=" + input.Asset.Binding.CollectionAddress + "&tokenId=" + input.Asset.Binding.TokenID
	out := f.request("GET", path, nil, "", nil)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"grounded":true`) {
		t.Fatalf("source status %d %s", out.Code, out.Body)
	}
	for _, extra := range []string{"&url=https://other.test", "&tokenId=2"} {
		if out = f.request("GET", path+extra, nil, "", nil); out.Code != 400 {
			t.Fatalf("unbounded identity query %d", out.Code)
		}
	}
	service.now = func() time.Time { return time.Unix(input.Evidence.ValidUntil, 0) }
	if out = f.request("GET", path, nil, "", nil); out.Code != 409 {
		t.Fatalf("expired underlying still ready %d", out.Code)
	}
}
