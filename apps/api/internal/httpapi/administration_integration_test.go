package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type administrationFixture struct {
	db                  *sql.DB
	auth                *userAuthService
	service             *administrationService
	handler             http.Handler
	owner, admin, other *userAuthTokens
}

func administrationIntegrationFixture(t *testing.T) administrationFixture {
	t.Helper()
	db, auth, _, owner := walletAuthIntegrationFixture(t)
	if _, err := db.Exec("SELECT case_id FROM moderation_cases LIMIT 0"); err != nil {
		t.Fatalf("Apply migration 000012: %v", err)
	}
	a, _ := userRandomToken(20)
	b, _ := userRandomToken(20)
	admins := []string{"0x" + a, "0x" + b}
	service := &administrationService{auth: auth, admins: parseAdminWallets(admins[0])}
	mux := http.NewServeMux()
	service.registerRoutes(mux)
	fixture := administrationFixture{db: db, auth: auth, service: service, handler: mux, owner: walletAuthIntegrationLogin(t, auth, owner), admin: walletAuthIntegrationLogin(t, auth, admins[0]), other: walletAuthIntegrationLogin(t, auth, admins[1])}
	t.Cleanup(func() {
		for _, address := range append(admins, owner) {
			h := sha256.Sum256([]byte(address))
			for _, stmt := range []string{"DELETE FROM administration_requests WHERE actor_hash=?", "DELETE FROM security_audit_log WHERE actor_hash=?"} {
				if _, err := db.Exec(stmt, h[:]); err != nil {
					t.Error(err)
				}
			}
			if _, err := db.Exec("DELETE FROM moderation_cases WHERE reporter_address=?", address); err != nil {
				t.Error(err)
			}
		}
		for _, address := range admins {
			db.Exec("DELETE FROM wallet_user_sessions WHERE wallet_address=?", address)
			db.Exec("DELETE FROM wallet_user_challenges WHERE wallet_address=?", address)
		}
	})
	return fixture
}
func (f administrationFixture) request(method, path string, tokens *userAuthTokens, key string, body any) *httptest.ResponseRecorder {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(string(payload)))
	if tokens != nil {
		req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	out := httptest.NewRecorder()
	f.handler.ServeHTTP(out, req)
	return out
}
func readAdminCase(t *testing.T, out *httptest.ResponseRecorder, status int) moderationCase {
	t.Helper()
	if out.Code != status {
		t.Fatalf("status=%d want=%d body=%s", out.Code, status, out.Body)
	}
	var c moderationCase
	if err := json.Unmarshal(out.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	return c
}
func reportInput() map[string]any {
	return map[string]any{"target": "Hoodi receipt token 17, metadata description", "category": "misleading_metadata", "details": "Private reporter detail. Please review the content evidence."}
}
func (f administrationFixture) report(t *testing.T) moderationCase {
	key, _ := userRandomToken(16)
	return readAdminCase(t, f.request("POST", "/v1/user/moderation/cases", f.owner, key, reportInput()), 201)
}
func (f administrationFixture) decide(t *testing.T, c moderationCase, action, decision, notice string) moderationCase {
	key, _ := userRandomToken(16)
	return readAdminCase(t, f.request("POST", "/v1/admin/moderation/cases/"+c.ID+"/decisions", f.admin, key, moderationDecisionInput{Revision: c.Revision, Action: action, Decision: decision, PublicNotice: notice, Reason: "Reviewed the submitted content evidence."}), 200)
}
func TestMySQLAdministrationPrivacyAppealAuditRestart(t *testing.T) {
	f := administrationIntegrationFixture(t)
	for _, path := range []string{"/v1/admin/session", "/v1/admin/moderation/cases", "/v1/admin/audit", "/v1/admin/config"} {
		if out := f.request("GET", path, f.owner, "", nil); out.Code != 403 {
			t.Fatalf("ordinary user accessed %s: %d", path, out.Code)
		}
	}
	c := f.report(t)
	// Owner-filtered reads remain owner-scoped even when the caller is an admin.
	for _, other := range []*userAuthTokens{f.other, f.admin} {
		out := f.request("GET", "/v1/user/moderation/cases/"+c.ID, other, "", nil)
		if out.Code != 404 || strings.Contains(out.Body.String(), "Private reporter") {
			t.Fatal("private case detail leaked")
		}
		out = f.request("GET", "/v1/user/moderation/cases", other, "", nil)
		if out.Code != 200 || strings.Contains(out.Body.String(), c.ID) {
			t.Fatal("private case list leaked")
		}
		out = f.request("POST", "/v1/user/moderation/cases/"+c.ID+"/appeals", other, "wrong-owner-appeal-key", map[string]any{"revision": 1, "statement": "An unrelated wallet attempts to appeal."})
		if out.Code != 404 {
			t.Fatalf("other owner appeal status %d", out.Code)
		}
	}
	c = f.decide(t, c, "start_review", "", "")
	c = f.decide(t, c, "resolve", "content_warning", "The metadata description is under a documented content warning.")
	out := f.request("GET", "/v1/moderation/notices", nil, "", nil)
	if out.Code != 200 || !strings.Contains(out.Body.String(), c.PublicNotice) || strings.Contains(out.Body.String(), f.owner.Session.Address) || strings.Contains(out.Body.String(), "Private reporter") {
		t.Fatal("public notice missing or private data leaked")
	}
	c = readAdminCase(t, f.request("POST", "/v1/user/moderation/cases/"+c.ID+"/appeals", f.owner, "appeal-idempotent-key", map[string]any{"revision": c.Revision, "statement": "Private appeal evidence for reconsideration."}), 200)
	if c.Status != "appealed" || c.AppealStatus != "pending" {
		t.Fatal("appeal not queued")
	}
	c = f.decide(t, c, "uphold_appeal", "no_action", "")
	if c.Revision != 5 || c.AppealStatus != "upheld" || c.PublicNotice != "" {
		t.Fatal("appeal decision incorrect")
	}
	// Reconstruct the service: neither the case, its decision nor its audit is memory-only.
	restarted := &administrationService{auth: f.auth, admins: f.service.admins}
	mux := http.NewServeMux()
	restarted.registerRoutes(mux)
	f.handler = mux
	stored := readAdminCase(t, f.request("GET", "/v1/user/moderation/cases/"+c.ID, f.owner, "", nil), 200)
	if stored.AppealStatement != c.AppealStatement || stored.Revision != 5 {
		t.Fatal("restart lost appeal")
	}
	out = f.request("GET", "/v1/moderation/notices", nil, "", nil)
	if strings.Contains(out.Body.String(), c.ID) {
		t.Fatal("upheld warning remains public")
	}
	out = f.request("GET", "/v1/admin/audit", f.admin, "", nil)
	if out.Code != 200 || !strings.Contains(out.Body.String(), "moderation.uphold_appeal") {
		t.Fatal("durable audit unavailable")
	}
	var count int
	resource := sha256.Sum256([]byte(c.ID))
	if err := f.db.QueryRow("SELECT COUNT(*) FROM security_audit_log WHERE resource_hash=?", resource[:]).Scan(&count); err != nil || count != 5 {
		t.Fatalf("audit count=%d err=%v", count, err)
	}
	out = f.request("POST", "/v1/user/moderation/cases/"+c.ID+"/appeals", f.owner, "second-appeal-key", map[string]any{"revision": 5, "statement": "A repeat appeal must not overwrite the earlier record."})
	if out.Code != 409 {
		t.Fatal("repeat appeal overwrote record")
	}
}
func TestMySQLAdministrationIdempotencyAndRevisionConcurrency(t *testing.T) {
	f := administrationIntegrationFixture(t)
	const key = "concurrent-report-key"
	outcomes := make(chan *httptest.ResponseRecorder, 8)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			outcomes <- f.request("POST", "/v1/user/moderation/cases", f.owner, key, reportInput())
		}()
	}
	close(start)
	workers.Wait()
	close(outcomes)
	var c moderationCase
	for out := range outcomes {
		got := readAdminCase(t, out, 201)
		if c.ID != "" && got.ID != c.ID {
			t.Fatal("duplicate report")
		}
		c = got
	}
	changed := reportInput()
	changed["details"] = "A different payload cannot reuse an existing key."
	if out := f.request("POST", "/v1/user/moderation/cases", f.owner, key, changed); out.Code != 409 {
		t.Fatal("idempotency conflict accepted")
	}
	outcomes = make(chan *httptest.ResponseRecorder, 2)
	start = make(chan struct{})
	for i := range 2 {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			<-start
			outcomes <- f.request("POST", "/v1/admin/moderation/cases/"+c.ID+"/decisions", f.admin, fmt.Sprintf("revision-racing-key-%d", i), moderationDecisionInput{Revision: 1, Action: "resolve", Decision: "no_action", Reason: "The report has been assessed for content concerns."})
		}(i)
	}
	close(start)
	workers.Wait()
	close(outcomes)
	successes, conflicts := 0, 0
	for out := range outcomes {
		if out.Code == 200 {
			successes++
		} else if out.Code == 409 {
			conflicts++
		} else {
			t.Fatalf("concurrency error: %d %s", out.Code, out.Body)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflict=%d", successes, conflicts)
	}
	var count int
	resource := sha256.Sum256([]byte(c.ID))
	f.db.QueryRow("SELECT COUNT(*) FROM security_audit_log WHERE resource_hash=?", resource[:]).Scan(&count)
	if count != 2 {
		t.Fatalf("replay/conflict duplicated audit %d", count)
	}
}
func TestMySQLAdministrationAuditFailureRollsBack(t *testing.T) {
	f := administrationIntegrationFixture(t)
	c := f.report(t)
	trigger := "audit_failure_" + c.ID
	// This trigger exists only in the isolated test database and only rejects
	// this test's case. It proves audit failure cannot leave a successful write.
	stmt := fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON security_audit_log FOR EACH ROW BEGIN IF NEW.action='moderation.resolve' AND JSON_UNQUOTE(JSON_EXTRACT(NEW.metadata,'$.resourceId'))='%s' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated audit failure'; END IF; END`, trigger, c.ID)
	if _, err := f.db.Exec(stmt); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.db.Exec("DROP TRIGGER IF EXISTS " + trigger) })
	input := moderationDecisionInput{Revision: 1, Action: "resolve", Decision: "no_action", Reason: "The report has been reviewed and documented."}
	path := "/v1/admin/moderation/cases/" + c.ID + "/decisions"
	out := f.request("POST", path, f.admin, "audit-rollback-key", input)
	if out.Code != 503 || strings.Contains(out.Body.String(), "isolated audit") {
		t.Fatal("audit failure accepted or internal error leaked")
	}
	got := readAdminCase(t, f.request("GET", "/v1/user/moderation/cases/"+c.ID, f.owner, "", nil), 200)
	if got.Revision != 1 || got.Status != "open" {
		t.Fatal("state survived failed audit")
	}
	f.db.Exec("DROP TRIGGER " + trigger)
	got = readAdminCase(t, f.request("POST", path, f.admin, "audit-rollback-key", input), 200)
	if got.Revision != 2 {
		t.Fatal("safe retry failed")
	}
}
func TestMySQLAdministrationConfigurationAndRevocation(t *testing.T) {
	f := administrationIntegrationFixture(t)
	out := f.request("GET", "/v1/admin/config", f.admin, "", nil)
	if out.Code != 200 {
		t.Fatalf("config status=%d %s", out.Code, out.Body)
	}
	var original platformConfiguration
	json.Unmarshal(out.Body.Bytes(), &original)
	t.Cleanup(func() {
		f.db.Exec("UPDATE platform_configuration SET revision=?,notice_enabled=?,notice_text=?,updated_at=? WHERE configuration_id=1", original.Revision, original.NoticeEnabled, original.NoticeText, original.UpdatedAt)
	})
	input := map[string]any{"revision": original.Revision, "noticeEnabled": false, "noticeText": "Private unpublished draft notice.", "reason": "Prepare a bounded application service notice."}
	out = f.request("PUT", "/v1/admin/config", f.admin, "config-draft-key", input)
	if out.Code != 200 {
		t.Fatalf("config failed %d %s", out.Code, out.Body)
	}
	if pub := f.request("GET", "/v1/platform/config", nil, "", nil); strings.Contains(pub.Body.String(), "Private unpublished") {
		t.Fatal("unpublished draft leaked")
	}
	if stale := f.request("PUT", "/v1/admin/config", f.admin, "config-stale-key", input); stale.Code != 409 {
		t.Fatal("stale config accepted")
	}
	input["revision"], input["noticeEnabled"], input["noticeText"] = original.Revision+1, true, "Scheduled application maintenance is in progress."
	out = f.request("PUT", "/v1/admin/config", f.admin, "config-publish-key", input)
	if out.Code != 200 {
		t.Fatalf("publish %d %s", out.Code, out.Body)
	}
	if pub := f.request("GET", "/v1/platform/config", nil, "", nil); !strings.Contains(pub.Body.String(), "Scheduled application") {
		t.Fatal("published notice missing")
	}
	// Unknown settings cannot widen the bounded moderation authority.
	input["freezeAssets"] = true
	if bad := f.request("PUT", "/v1/admin/config", f.admin, "config-unknown-key", input); bad.Code != 400 {
		t.Fatal("unknown configuration accepted")
	}
	if err := f.auth.revokeUserSession(context.Background(), f.admin.Session.ID, ""); err != nil {
		t.Fatal(err)
	}
	if revoked := f.request("GET", "/v1/admin/audit", f.admin, "", nil); revoked.Code != 401 {
		t.Fatal("revoked admin retained access")
	}
	delete(f.service.admins, f.admin.Session.Address)
	// Role configuration never touches the underlying wallet session/holdings.
	if _, err := f.auth.authenticate(context.Background(), f.owner.AccessToken, false); err != nil {
		t.Fatal("moderation changed unrelated user access")
	}
}
