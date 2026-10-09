package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Ordinary isolated renewal regression: one source-bound issuance survives proof expiry.
func TestMySQLPreparedMintEvidenceRenewalPreservesImmutableIssuance(t *testing.T) {
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
	h := newHandler(service)
	input := mintIntentRequest{UploadID: upload.ID, Recipient: f.owner.Session.Address, Name: "TEST_ONLY legitimate recovery", Artist: "Example maker", Year: 2026, Medium: "Test medium", Location: "Test custody", Description: "Synthetic isolated source-proof expiry recovery reproduction."}
	headers := map[string]string{"Idempotency-Key": "review-mint-" + randomID()}
	out := jsonRequest(t, h, "POST", "/v1/rwa/metadata-preparations", input, headers)
	if out.Code != 200 {
		t.Fatal(out.Body)
	}
	var draft rwaMetadataPreparation
	decode(t, out, &draft)
	proof := syntheticEvidence(t, service, key, source, draft.ContextHash, "fractional")
	input.Evidence = &proof
	out = jsonRequest(t, h, "POST", "/v1/rwa/intents", input, headers)
	if out.Code != 201 {
		t.Fatalf("initial prepare: %d %s", out.Code, out.Body)
	}
	var intent mintIntent
	decode(t, out, &intent)
	service.now = func() time.Time { return time.Unix(proof.ValidUntil+1, 0) }
	out = requestWithHandler(t, h, "GET", "/v1/rwa/intents/"+intent.IntentID)
	if out.Code != 409 {
		t.Fatalf("expired proof lookup: %d %s", out.Code, out.Body)
	}
	t.Logf("Expired, never-submitted intent is unavailable: %d %s", out.Code, out.Body)
	renewed := proof
	renewed.EvidenceID = hashText(randomID())
	renewed.ValidFrom = service.now().Unix() - 1
	renewed.ValidUntil = service.now().Unix() + 3600
	renewed.SignatureR, renewed.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(renewed))
	input.Evidence = &renewed
	// The first creation response may have been lost before the caller learned
	// its intent ID. The durable key must recover that same issuance with a
	// current independently signed proof rather than allocate another request.
	out = jsonRequest(t, h, "POST", "/v1/rwa/intents", input, headers)
	if out.Code != 200 {
		t.Fatalf("lost-response source renewal: %d %s", out.Code, out.Body)
	}
	var recovered mintIntent
	decode(t, out, &recovered)
	if recovered.IntentID != intent.IntentID || recovered.RequestID != intent.RequestID || recovered.SourceEvidence.EvidenceID != renewed.EvidenceID {
		t.Fatal("lost response recovery changed immutable issuance")
	}
	renewed.EvidenceID = hashText(randomID())
	renewed.ValidUntil += 3600
	renewed.SignatureR, renewed.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(renewed))
	renewalPath := "/v1/rwa/intents/" + intent.IntentID + "/evidence"
	for _, kind := range []string{"asset", "source asset", "rights", "context"} {
		altered := renewed
		switch kind {
		case "asset":
			altered.UnderlyingAssetID += "-changed"
		case "source asset":
			altered.SourceAssetID += "-changed"
		case "rights":
			altered.Rights += " Changed rights."
		case "context":
			altered.ContextHash = hashText("another-context")
		}
		altered.EvidenceID = hashText(randomID())
		altered.SignatureR, altered.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(altered))
		bad := jsonRequest(t, h, "POST", renewalPath, map[string]any{"evidence": altered}, nil)
		if bad.Code != 409 {
			t.Fatalf("changed %s accepted: %d %s", kind, bad.Code, bad.Body)
		}
	}
	for range 2 {
		out = jsonRequest(t, h, "POST", renewalPath, map[string]any{"evidence": renewed}, nil)
		if out.Code != 200 {
			t.Fatalf("same-request renewal: %d %s", out.Code, out.Body)
		}
		var current mintIntent
		decode(t, out, &current)
		if current.IntentID != intent.IntentID || current.RequestID != intent.RequestID || current.MetadataSHA256 != intent.MetadataSHA256 || current.SourceEvidence.EvidenceID != renewed.EvidenceID {
			t.Fatal("renewal changed issuance or lost proof")
		}
	}
	var audits int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM security_audit_log WHERE action='rwa.mint.evidence-renewed' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.intentId'))=?", intent.IntentID).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("renewal audit count %d %v", audits, err)
	}
	out = requestWithHandler(t, h, "GET", "/v1/rwa/intents/"+intent.IntentID)
	if out.Code != 200 {
		t.Fatalf("renewed lookup: %d %s", out.Code, out.Body)
	}
	restarted := newRWAService(service.config, newMemoryObjectStore())
	restarted.db = f.db
	restarted.requireDB = true
	restarted.now = service.now
	restarted.grounding = service.grounding
	out = requestWithHandler(t, newHandler(restarted), "GET", "/v1/rwa/intents/"+intent.IntentID)
	if out.Code != 200 || !strings.Contains(out.Body.String(), renewed.EvidenceID) {
		t.Fatalf("restart renewal: %d %s", out.Code, out.Body)
	}
	headers["Idempotency-Key"] = "review-fresh-mint-" + randomID()
	out = jsonRequest(t, h, "POST", "/v1/rwa/metadata-preparations", input, headers)
	if out.Code != 200 {
		t.Fatalf("fresh preparation: %d %s", out.Code, out.Body)
	}
	decode(t, out, &draft)
	renewed.EvidenceID = hashText(randomID())
	renewed.ContextHash = draft.ContextHash
	renewed.SignatureR, renewed.SignatureS = signSyntheticDigest(t, key, sourceEvidenceDigest(renewed))
	if err := service.grounding.verify(renewed, draft.ContextHash, "fractional", service.now(), false); err != nil {
		t.Fatal(err)
	}
	out = jsonRequest(t, h, "POST", "/v1/rwa/intents", input, headers)
	if out.Code != 409 {
		t.Fatalf("fresh-key renewal: %d %s", out.Code, out.Body)
	}
	t.Logf("Independent source's valid fresh context cannot use a new key: %d %s", out.Code, out.Body)
	var n int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM rwa_mint_intents WHERE upload_id=? AND transaction_hash IS NULL", upload.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("expected exactly one unsubmitted intent, got %d, err %v", n, err)
	}
}
