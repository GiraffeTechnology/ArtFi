package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdministrationRoleConfigurationFailsClosed(t *testing.T) {
	address := userAuthTestAddress
	for _, value := range []string{"", address + ",invalid", address + ",", "0x" + strings.Repeat("0", 40)} {
		if len(parseAdminWallets(value)) != 0 {
			t.Fatalf("invalid role enabled: %q", value)
		}
	}
	if !parseAdminWallets(" " + address + " ")[address] {
		t.Fatal("valid configured role disabled")
	}
}
func TestAdministrationDecisionBoundaries(t *testing.T) {
	tests := []struct {
		status, appeal, action, decision, notice string
		valid                                    bool
	}{
		{"open", "none", "start_review", "", "", true},
		{"open", "none", "resolve", "content_warning", "Review this metadata before relying on it.", true},
		{"resolved", "none", "resolve", "no_action", "", false},
		{"appealed", "pending", "reject_appeal", "", "", true},
		{"appealed", "pending", "uphold_appeal", "no_action", "", true},
		{"resolved", "rejected", "uphold_appeal", "no_action", "", false},
		{"open", "none", "freeze_assets", "", "", false},
		{"open", "none", "resolve", "block_seller", "", false},
		{"open", "none", "resolve", "content_warning", "", false},
		{"open", "none", "resolve", "no_action", "unexpected disclosure", false},
	}
	for _, test := range tests {
		t.Run(test.status+test.action+test.decision, func(t *testing.T) {
			input := moderationDecisionInput{Revision: 1, Action: test.action, Decision: test.decision, PublicNotice: test.notice, Reason: "A documented moderation explanation."}
			c := moderationCase{Status: test.status, AppealStatus: test.appeal, Decision: "content_warning", PublicNotice: "Existing warning", Revision: 1}
			valid := validateModerationDecision(input)
			if valid {
				valid = transitionModerationCase(&c, input) == nil
			}
			if valid != test.valid {
				t.Fatalf("transition valid=%v want %v", valid, test.valid)
			}
			if valid && test.action == "reject_appeal" && (c.Decision != "content_warning" || c.PublicNotice != "Existing warning") {
				t.Fatal("rejecting appeal changed prior outcome")
			}
		})
	}
}
func TestAdministrationReadJSONIsStrictAndBounded(t *testing.T) {
	for _, body := range []string{`{"revision":1,"freezeAssets":true}`, `{"revision":1} {}`, strings.Repeat("x", 16385), `{`} {
		var input struct {
			Revision uint64 `json:"revision"`
		}
		if adminReadJSON(httptest.NewRequest("POST", "/", strings.NewReader(body)), &input) == nil {
			t.Fatalf("invalid JSON accepted")
		}
	}
	for _, text := range []string{" trailing ", "bad\x00text"} {
		if adminText(text, 0, 500) {
			t.Fatal("invalid text accepted")
		}
	}
}
func TestAdministrationNeverUsesOperatorOrIndexerCredential(t *testing.T) {
	auth := userAuthTestService(unavailableUserAuthDB{}, time.Now)
	service := &administrationService{auth: auth, admins: parseAdminWallets(userAuthTestAddress)}
	mux := http.NewServeMux()
	service.registerRoutes(mux)
	for _, path := range []string{"/v1/admin/session", "/v1/admin/moderation/cases", "/v1/admin/audit", "/v1/admin/config", "/v1/user/moderation/cases"} {
		for _, credential := range []string{"", "Bearer operator-only-credential", "Bearer " + string(auth.bridgeToken)} {
			req := httptest.NewRequest("GET", path, nil)
			req.Header.Set("Authorization", credential)
			out := httptest.NewRecorder()
			mux.ServeHTTP(out, req)
			if out.Code != 401 {
				t.Fatalf("%s status=%d body=%s", path, out.Code, out.Body)
			}
			if out.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private data cacheable")
			}
		}
	}
}
func TestAdministrationPublicReadsFailClosedWithoutPersistence(t *testing.T) {
	service := &administrationService{auth: userAuthTestService(nil, time.Now)}
	mux := http.NewServeMux()
	service.registerRoutes(mux)
	for _, path := range []string{"/v1/moderation/notices", "/v1/platform/config"} {
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest("GET", path, nil))
		if out.Code != 503 || out.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s returned %d", path, out.Code)
		}
	}
}
