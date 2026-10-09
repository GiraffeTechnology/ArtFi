package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Moderators reuse ordinary revocable wallet sessions. A registrar credential,
// indexer key, or seller identity never grants this application-only role.
type administrationService struct {
	auth   *userAuthService
	admins map[string]bool
}

type moderationCase struct {
	ID              string    `json:"id"`
	Reporter        string    `json:"reporter"`
	Target          string    `json:"target"`
	Category        string    `json:"category"`
	Details         string    `json:"details"`
	Status          string    `json:"status"`
	Decision        string    `json:"decision"`
	DecisionReason  string    `json:"decisionReason"`
	PublicNotice    string    `json:"publicNotice"`
	Revision        uint64    `json:"revision"`
	AppealStatus    string    `json:"appealStatus"`
	AppealStatement string    `json:"appealStatement"`
	AppealResponse  string    `json:"appealResponse"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type platformConfiguration struct {
	Revision      uint64    `json:"revision"`
	NoticeEnabled bool      `json:"noticeEnabled"`
	NoticeText    string    `json:"noticeText"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type adminProblem struct {
	status int
	detail string
}

func (e *adminProblem) Error() string            { return e.detail }
func adminError(status int, detail string) error { return &adminProblem{status, detail} }

var adminIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var adminKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

func parseAdminWallets(value string) map[string]bool {
	result := make(map[string]bool)
	if strings.TrimSpace(value) == "" {
		return result
	}
	for _, candidate := range strings.Split(value, ",") {
		address := strings.ToLower(strings.TrimSpace(candidate))
		// Invalid deployment configuration disables the whole role, never a
		// partial interpretation or an implicit registrar/operator fallback.
		if !addressPattern.MatchString(address) || address == "0x"+strings.Repeat("0", 40) {
			return map[string]bool{}
		}
		result[address] = true
	}
	return result
}

func registerAdministration(mux *http.ServeMux, auth *userAuthService) {
	service := &administrationService{auth: auth, admins: parseAdminWallets(os.Getenv("ARTFI_ADMIN_WALLETS"))}
	service.registerRoutes(mux)
}
func (service *administrationService) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/admin/session", service.protect(true, service.session))
	mux.HandleFunc("GET /v1/admin/moderation/cases", service.protect(true, service.listCases))
	mux.HandleFunc("GET /v1/admin/moderation/cases/{caseID}", service.protect(true, service.getCase))
	mux.HandleFunc("POST /v1/admin/moderation/cases/{caseID}/decisions", service.protect(true, service.decideCase))
	mux.HandleFunc("GET /v1/admin/audit", service.protect(true, service.audit))
	mux.HandleFunc("GET /v1/admin/config", service.protect(true, service.getConfig))
	mux.HandleFunc("PUT /v1/admin/config", service.protect(true, service.updateConfig))
	mux.HandleFunc("GET /v1/user/moderation/cases", service.protect(false, service.listCases))
	mux.HandleFunc("POST /v1/user/moderation/cases", service.protect(false, service.createCase))
	mux.HandleFunc("GET /v1/user/moderation/cases/{caseID}", service.protect(false, service.getCase))
	mux.HandleFunc("POST /v1/user/moderation/cases/{caseID}/appeals", service.protect(false, service.appealCase))
	mux.HandleFunc("GET /v1/platform/config", func(w http.ResponseWriter, r *http.Request) { service.getConfig(w, r, nil) })
	mux.HandleFunc("GET /v1/moderation/notices", service.notices)
}

type administrationHandler func(http.ResponseWriter, *http.Request, *userAuthSession)

func (service *administrationService) protect(admin bool, next administrationHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		authorization := r.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") {
			service.fail(w, r, errUserUnauthorized)
			return
		}
		session, err := service.auth.authenticate(r.Context(), strings.TrimPrefix(authorization, "Bearer "), false)
		if err != nil {
			service.fail(w, r, err)
			return
		}
		if admin && !service.admins[session.Address] {
			service.fail(w, r, adminError(403, "This wallet has no application moderation role."))
			return
		}
		next(w, r, session)
	}
}
func (service *administrationService) fail(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	var problem *adminProblem
	if errors.As(err, &problem) {
		writeProblem(w, r, problem.status, "Administration request rejected", problem.detail)
		return
	}
	if errors.Is(err, errUserUnauthorized) || errors.Is(err, errUserForbidden) {
		service.auth.writeError(w, r, err)
		return
	}
	writeProblem(w, r, 503, "Administration unavailable", "Durable moderation and configuration records are unavailable. No change was confirmed.")
}
func adminReadJSON(r *http.Request, value any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16385))
	if err != nil || len(body) > 16384 {
		return adminError(413, "The request is too large.")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(value); err != nil {
		return adminError(400, "A valid request with only supported fields is required.")
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return adminError(400, "A single JSON request is required.")
	}
	return nil
}
func adminText(value string, minimum, maximum int) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	length := utf8.RuneCountInString(value)
	if length < minimum || length > maximum {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}
func validModerationTarget(value string) bool {
	// A bounded descriptive asset/order/content reference, not an executable URL.
	// The console renders this as text; arbitrary URLs are never followed.
	return adminText(value, 3, 256)
}
func adminOnlyQuery(r *http.Request, allowed ...string) bool {
	for key, values := range r.URL.Query() {
		ok := false
		for _, candidate := range allowed {
			if key == candidate {
				ok = true
			}
		}
		if !ok || len(values) != 1 {
			return false
		}
	}
	return true
}
func adminPage(r *http.Request) (int, int, error) {
	page, size := 1, 20
	for _, entry := range []struct {
		key  string
		dest *int
		max  int
	}{{"page", &page, 1000000}, {"pageSize", &size, 100}} {
		if v := r.URL.Query().Get(entry.key); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > entry.max {
				return 0, 0, adminError(400, "Invalid pagination.")
			}
			*entry.dest = n
		}
	}
	return page, size, nil
}
func (service *administrationService) session(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	if !adminOnlyQuery(r) {
		service.fail(w, r, adminError(400, "Unsupported query."))
		return
	}
	writeJSON(w, 200, map[string]any{"address": s.Address, "role": "content_moderator", "scope": "Content reports, appeals, service notices and audit records only. No asset or trading authority."})
}

const moderationSelect = `SELECT case_id,reporter_address,target,category,details,status,decision,decision_reason,public_notice,revision,appeal_status,appeal_statement,appeal_response,created_at,updated_at FROM moderation_cases`

func scanModerationCase(row userSessionScanner) (*moderationCase, error) {
	c := new(moderationCase)
	err := row.Scan(&c.ID, &c.Reporter, &c.Target, &c.Category, &c.Details, &c.Status, &c.Decision, &c.DecisionReason, &c.PublicNotice, &c.Revision, &c.AppealStatus, &c.AppealStatement, &c.AppealResponse, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, adminError(404, "The case was not found.")
	}
	return c, err
}
func (service *administrationService) listCases(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	if !adminOnlyQuery(r, "page", "pageSize", "status") {
		service.fail(w, r, adminError(400, "Unsupported query."))
		return
	}
	page, size, err := adminPage(r)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	query, args := " WHERE 1=1", []any{}
	// Role does not broaden the owner API: even admins see only their own here.
	if strings.HasPrefix(r.URL.Path, "/v1/user/") {
		query += " AND reporter_address=?"
		args = append(args, s.Address)
	}
	if status := r.URL.Query().Get("status"); status != "" {
		if status != "open" && status != "reviewing" && status != "resolved" && status != "appealed" {
			service.fail(w, r, adminError(400, "Invalid case status."))
			return
		}
		query += " AND status=?"
		args = append(args, status)
	}
	rows, err := service.auth.db.QueryContext(r.Context(), moderationSelect+query+" ORDER BY created_at DESC, case_id DESC LIMIT ? OFFSET ?", append(args, size+1, (page-1)*size)...)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer rows.Close()
	data := make([]moderationCase, 0)
	for rows.Next() {
		c, err := scanModerationCase(rows)
		if err != nil {
			service.fail(w, r, err)
			return
		}
		data = append(data, *c)
	}
	if err = rows.Err(); err != nil {
		service.fail(w, r, err)
		return
	}
	more := len(data) > size
	if more {
		data = data[:size]
	}
	writeJSON(w, 200, map[string]any{"data": data, "page": page, "pageSize": size, "hasMore": more})
}
func (service *administrationService) getCase(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	id := r.PathValue("caseID")
	if !adminIDPattern.MatchString(id) || !adminOnlyQuery(r) {
		service.fail(w, r, adminError(404, "The case was not found."))
		return
	}
	query, args := moderationSelect+" WHERE case_id=?", []any{id}
	if strings.HasPrefix(r.URL.Path, "/v1/user/") {
		query += " AND reporter_address=?"
		args = append(args, s.Address)
	}
	rows, err := service.auth.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer rows.Close()
	if !rows.Next() {
		if rows.Err() != nil {
			service.fail(w, r, rows.Err())
		} else {
			service.fail(w, r, adminError(404, "The case was not found."))
		}
		return
	}
	c, err := scanModerationCase(rows)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	writeJSON(w, 200, c)
}

type administrationMutation func(*sql.Tx) (any, int, error)

// A single transaction owns the idempotency receipt, revision-locked state and
// append-only security audit. Failure of any part rolls back the entire action.
func (service *administrationService) mutate(w http.ResponseWriter, r *http.Request, s *userAuthSession, input any, apply administrationMutation) {
	key := r.Header.Get("Idempotency-Key")
	if !adminKeyPattern.MatchString(key) || !adminOnlyQuery(r) {
		service.fail(w, r, adminError(400, "A 16–128 character Idempotency-Key and no query parameters are required."))
		return
	}
	payload, _ := json.Marshal(input)
	hash := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), payload...))
	actorHash, keyHash := sha256.Sum256([]byte(s.Address)), sha256.Sum256([]byte(key))
	tx, err := service.auth.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer tx.Rollback()
	// Prevent a session revoked before this transaction from making a write;
	// the shared lock orders a concurrent logout after an in-flight mutation.
	live, err := scanUserSession(tx.QueryRowContext(r.Context(), selectUserSession+" FOR SHARE", s.ID))
	if err != nil || live.revoked || live.ExpiresAt <= service.auth.now().UnixMilli() {
		if err == nil {
			err = errUserUnauthorized
		}
		service.fail(w, r, err)
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO administration_requests (actor_hash,key_hash,payload_hash,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE key_hash=key_hash`, actorHash[:], keyHash[:], hash[:], service.auth.now())
	if err != nil {
		service.fail(w, r, err)
		return
	}
	var storedHash, body []byte
	var code sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT payload_hash,response,response_status FROM administration_requests WHERE actor_hash=? AND key_hash=? FOR UPDATE`, actorHash[:], keyHash[:]).Scan(&storedHash, &body, &code)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	if !bytes.Equal(storedHash, hash[:]) {
		service.fail(w, r, adminError(409, "This idempotency key was already used for a different request."))
		return
	}
	if code.Valid {
		writeJSON(w, int(code.Int64), json.RawMessage(body))
		return
	}
	result, status, err := apply(tx)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	body, err = json.Marshal(result)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE administration_requests SET response=?,response_status=? WHERE actor_hash=? AND key_hash=?`, body, status, actorHash[:], keyHash[:])
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		service.fail(w, r, err)
		return
	}
	writeJSON(w, status, json.RawMessage(body))
}
func adminAudit(ctx context.Context, tx *sql.Tx, r *http.Request, s *userAuthSession, now time.Time, action, resourceType, id string, before uint64, snapshot any) error {
	actor, resource := sha256.Sum256([]byte(s.Address)), sha256.Sum256([]byte(id))
	metadata, err := json.Marshal(map[string]any{"actor": s.Address, "resourceId": id, "previousRevision": before, "snapshot": snapshot})
	if err != nil {
		return err
	}
	requestID := r.Header.Get("X-Request-ID")
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`).MatchString(requestID) {
		requestID = newRequestID()
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO security_audit_log (occurred_at,actor_hash,action,resource_type,resource_hash,decision,request_id,metadata) VALUES (?,?,?,?,?,'allow',?,?)`, now, actor[:], action, resourceType, resource[:], requestID, metadata)
	return err
}

func (service *administrationService) createCase(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input struct {
		Target   string `json:"target"`
		Category string `json:"category"`
		Details  string `json:"details"`
	}
	if err := adminReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	if !validModerationTarget(input.Target) || !adminText(input.Details, 10, 4000) || (input.Category != "misleading_metadata" && input.Category != "inappropriate_content" && input.Category != "suspected_fraud" && input.Category != "other") {
		service.fail(w, r, adminError(422, "Provide a content reference, supported category, and a 10–4000 character explanation."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx) (any, int, error) {
		id, err := userRandomToken(16)
		if err != nil {
			return nil, 0, err
		}
		now := service.auth.now().UTC()
		c := moderationCase{ID: id, Reporter: s.Address, Target: input.Target, Category: input.Category, Details: input.Details, Status: "open", Decision: "none", Revision: 1, AppealStatus: "none", CreatedAt: now, UpdatedAt: now}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO moderation_cases (case_id,reporter_address,target,category,details,decision_reason,appeal_statement,appeal_response,created_at,updated_at) VALUES (?,?,?,?,?,'','','',?,?)`, id, s.Address, input.Target, input.Category, input.Details, now, now)
		if err == nil {
			err = adminAudit(r.Context(), tx, r, s, now, "moderation.report", "moderation_case", id, 0, c)
		}
		return c, 201, err
	})
}
func lockModerationCase(ctx context.Context, tx *sql.Tx, id string, revision uint64, owner string) (*moderationCase, error) {
	if !adminIDPattern.MatchString(id) {
		return nil, adminError(404, "The case was not found.")
	}
	c, err := scanModerationCase(tx.QueryRowContext(ctx, moderationSelect+" WHERE case_id=? FOR UPDATE", id))
	if err != nil {
		return nil, err
	}
	if owner != "" && c.Reporter != owner {
		return nil, adminError(404, "The case was not found.")
	}
	if revision == 0 || revision != c.Revision {
		return nil, adminError(409, "This record has changed. Refresh it before submitting again.")
	}
	return c, nil
}
func saveModerationCase(ctx context.Context, tx *sql.Tx, c *moderationCase) error {
	_, err := tx.ExecContext(ctx, `UPDATE moderation_cases SET status=?,decision=?,decision_reason=?,public_notice=?,revision=?,appeal_status=?,appeal_statement=?,appeal_response=?,updated_at=? WHERE case_id=?`, c.Status, c.Decision, c.DecisionReason, c.PublicNotice, c.Revision, c.AppealStatus, c.AppealStatement, c.AppealResponse, c.UpdatedAt, c.ID)
	return err
}
func (service *administrationService) appealCase(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input struct {
		Revision  uint64 `json:"revision"`
		Statement string `json:"statement"`
	}
	if err := adminReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	if input.Revision == 0 || !adminText(input.Statement, 10, 4000) {
		service.fail(w, r, adminError(422, "A current revision and 10–4000 character appeal are required."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx) (any, int, error) {
		c, err := lockModerationCase(r.Context(), tx, r.PathValue("caseID"), input.Revision, s.Address)
		if err != nil {
			return nil, 0, err
		}
		if c.Status != "resolved" || c.AppealStatus != "none" {
			return nil, 0, adminError(409, "Only a resolved case without an earlier appeal may be appealed.")
		}
		c.Status, c.AppealStatus, c.AppealStatement = "appealed", "pending", input.Statement
		c.Revision++
		c.UpdatedAt = service.auth.now().UTC()
		err = saveModerationCase(r.Context(), tx, c)
		if err == nil {
			err = adminAudit(r.Context(), tx, r, s, c.UpdatedAt, "moderation.appeal", "moderation_case", c.ID, input.Revision, c)
		}
		return c, 200, err
	})
}

type moderationDecisionInput struct {
	Revision     uint64 `json:"revision"`
	Action       string `json:"action"`
	Reason       string `json:"reason"`
	Decision     string `json:"decision"`
	PublicNotice string `json:"publicNotice"`
}

func validateModerationDecision(input moderationDecisionInput) bool {
	if input.Revision == 0 || !adminText(input.Reason, 10, 4000) {
		return false
	}
	switch input.Action {
	case "start_review", "reject_appeal":
		return input.Decision == "" && input.PublicNotice == ""
	case "resolve", "uphold_appeal":
		return (input.Decision == "no_action" && input.PublicNotice == "") || (input.Decision == "content_warning" && adminText(input.PublicNotice, 10, 500))
	}
	return false
}
func transitionModerationCase(c *moderationCase, input moderationDecisionInput) error {
	switch input.Action {
	case "start_review":
		if c.Status != "open" {
			return adminError(409, "Only an open case can enter review.")
		}
		c.Status = "reviewing"
	case "resolve":
		if c.Status != "open" && c.Status != "reviewing" {
			return adminError(409, "This case already has a decision.")
		}
		c.Status, c.Decision, c.DecisionReason, c.PublicNotice = "resolved", input.Decision, input.Reason, input.PublicNotice
	case "uphold_appeal", "reject_appeal":
		if c.Status != "appealed" || c.AppealStatus != "pending" {
			return adminError(409, "This case has no pending appeal.")
		}
		c.Status, c.AppealResponse = "resolved", input.Reason
		if input.Action == "uphold_appeal" {
			c.AppealStatus = "upheld"
			c.Decision, c.DecisionReason, c.PublicNotice = input.Decision, input.Reason, input.PublicNotice
		} else {
			c.AppealStatus = "rejected"
		}
	default:
		return adminError(422, "Unsupported moderation action.")
	}
	c.Revision++
	return nil
}
func (service *administrationService) decideCase(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input moderationDecisionInput
	if err := adminReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	if !validateModerationDecision(input) {
		service.fail(w, r, adminError(422, "Provide a supported action, current revision, explanation, and a public notice only for content warnings."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx) (any, int, error) {
		c, err := lockModerationCase(r.Context(), tx, r.PathValue("caseID"), input.Revision, "")
		if err != nil {
			return nil, 0, err
		}
		if err = transitionModerationCase(c, input); err != nil {
			return nil, 0, err
		}
		c.UpdatedAt = service.auth.now().UTC()
		err = saveModerationCase(r.Context(), tx, c)
		if err == nil {
			err = adminAudit(r.Context(), tx, r, s, c.UpdatedAt, "moderation."+input.Action, "moderation_case", c.ID, input.Revision, map[string]any{"case": c, "reason": input.Reason})
		}
		return c, 200, err
	})
}
func scanPlatformConfiguration(row userSessionScanner) (*platformConfiguration, error) {
	c := new(platformConfiguration)
	err := row.Scan(&c.Revision, &c.NoticeEnabled, &c.NoticeText, &c.UpdatedAt)
	return c, err
}

const platformConfigurationSelect = `SELECT revision,notice_enabled,notice_text,updated_at FROM platform_configuration WHERE configuration_id=1`

func (service *administrationService) getConfig(w http.ResponseWriter, r *http.Request, _ *userAuthSession) {
	w.Header().Set("Cache-Control", "no-store")
	if !adminOnlyQuery(r) {
		service.fail(w, r, adminError(400, "Unsupported query."))
		return
	}
	if service.auth.db == nil {
		service.fail(w, r, errUserAuthUnavailable)
		return
	}
	rows, err := service.auth.db.QueryContext(r.Context(), platformConfigurationSelect)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer rows.Close()
	if !rows.Next() {
		service.fail(w, r, errUserAuthUnavailable)
		return
	}
	c, err := scanPlatformConfiguration(rows)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	// A disabled draft is visible only to moderators, not to public readers.
	if r.URL.Path == "/v1/platform/config" && !c.NoticeEnabled {
		c.NoticeText = ""
	}
	writeJSON(w, 200, c)
}
func (service *administrationService) updateConfig(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input struct {
		Revision      uint64 `json:"revision"`
		NoticeEnabled *bool  `json:"noticeEnabled"`
		NoticeText    string `json:"noticeText"`
		Reason        string `json:"reason"`
	}
	if err := adminReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	if input.Revision == 0 || input.NoticeEnabled == nil || !adminText(input.Reason, 10, 4000) || !adminText(input.NoticeText, 0, 500) || (*input.NoticeEnabled && !adminText(input.NoticeText, 10, 500)) {
		service.fail(w, r, adminError(422, "Provide the current revision, an explanation, and a 10–500 character notice when enabled."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx) (any, int, error) {
		c, err := scanPlatformConfiguration(tx.QueryRowContext(r.Context(), platformConfigurationSelect+" FOR UPDATE"))
		if err != nil {
			return nil, 0, err
		}
		if c.Revision != input.Revision {
			return nil, 0, adminError(409, "Configuration has changed. Refresh before saving again.")
		}
		c.Revision++
		c.NoticeEnabled, c.NoticeText, c.UpdatedAt = *input.NoticeEnabled, input.NoticeText, service.auth.now().UTC()
		_, err = tx.ExecContext(r.Context(), `UPDATE platform_configuration SET revision=?,notice_enabled=?,notice_text=?,updated_at=? WHERE configuration_id=1`, c.Revision, c.NoticeEnabled, c.NoticeText, c.UpdatedAt)
		if err == nil {
			err = adminAudit(r.Context(), tx, r, s, c.UpdatedAt, "platform.configure", "platform_configuration", "service_notice", input.Revision, map[string]any{"configuration": c, "reason": input.Reason})
		}
		return c, 200, err
	})
}
func (service *administrationService) notices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !adminOnlyQuery(r, "page", "pageSize") {
		service.fail(w, r, adminError(400, "Unsupported query."))
		return
	}
	page, size, err := adminPage(r)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	if service.auth.db == nil {
		service.fail(w, r, errUserAuthUnavailable)
		return
	}
	rows, err := service.auth.db.QueryContext(r.Context(), `SELECT case_id,target,public_notice,updated_at FROM moderation_cases WHERE decision='content_warning' ORDER BY updated_at DESC,case_id DESC LIMIT ? OFFSET ?`, size+1, (page-1)*size)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer rows.Close()
	type notice struct {
		ID        string    `json:"id"`
		Target    string    `json:"target"`
		Notice    string    `json:"notice"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	data := make([]notice, 0)
	for rows.Next() {
		var n notice
		if err = rows.Scan(&n.ID, &n.Target, &n.Notice, &n.UpdatedAt); err != nil {
			service.fail(w, r, err)
			return
		}
		data = append(data, n)
	}
	if err = rows.Err(); err != nil {
		service.fail(w, r, err)
		return
	}
	more := len(data) > size
	if more {
		data = data[:size]
	}
	writeJSON(w, 200, map[string]any{"data": data, "page": page, "pageSize": size, "hasMore": more})
}
func (service *administrationService) audit(w http.ResponseWriter, r *http.Request, _ *userAuthSession) {
	if !adminOnlyQuery(r, "before") {
		service.fail(w, r, adminError(400, "Unsupported query."))
		return
	}
	query, args := `SELECT audit_id,occurred_at,action,resource_type,request_id,metadata FROM security_audit_log WHERE resource_type IN ('moderation_case','platform_configuration','rwa_catalog_asset','rwa_source_evidence')`, []any{}
	if cursor := r.URL.Query().Get("before"); cursor != "" {
		id, err := strconv.ParseUint(cursor, 10, 64)
		if err != nil || id == 0 {
			service.fail(w, r, adminError(400, "Invalid audit cursor."))
			return
		}
		query += " AND audit_id < ?"
		args = append(args, id)
	}
	rows, err := service.auth.db.QueryContext(r.Context(), query+" ORDER BY audit_id DESC LIMIT 51", args...)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer rows.Close()
	type entry struct {
		ID           string          `json:"id"`
		OccurredAt   time.Time       `json:"occurredAt"`
		Action       string          `json:"action"`
		ResourceType string          `json:"resourceType"`
		RequestID    string          `json:"requestId"`
		Metadata     json.RawMessage `json:"metadata"`
	}
	data := make([]entry, 0)
	for rows.Next() {
		var v entry
		if err = rows.Scan(&v.ID, &v.OccurredAt, &v.Action, &v.ResourceType, &v.RequestID, &v.Metadata); err != nil {
			service.fail(w, r, err)
			return
		}
		data = append(data, v)
	}
	if err = rows.Err(); err != nil {
		service.fail(w, r, err)
		return
	}
	next := ""
	if len(data) > 50 {
		data = data[:50]
		next = data[49].ID
	}
	writeJSON(w, 200, map[string]any{"data": data, "nextCursor": next})
}
