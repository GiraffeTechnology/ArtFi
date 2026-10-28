package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type notificationService struct {
	auth *userAuthService
}

type notificationEvent struct {
	TransactionHash string `json:"transactionHash"`
	LogIndex        uint32 `json:"logIndex"`
	ContractAddress string `json:"contractAddress"`
	EventName       string `json:"eventName"`
	BlockNumber     string `json:"blockNumber"`
}

type inboxNotification struct {
	ID             string             `json:"id"`
	SourceKey      string             `json:"sourceKey"`
	SourceKind     string             `json:"sourceKind"`
	SourceRevision string             `json:"sourceRevision"`
	State          string             `json:"state"`
	Read           bool               `json:"read"`
	ReadAt         *string            `json:"readAt"`
	MessageCode    string             `json:"messageCode"`
	Event          *notificationEvent `json:"event"`
	Text           *string            `json:"text"`
}

type notificationPreferences struct {
	Revision            string `json:"revision"`
	TransactionAlerts   bool   `json:"transactionAlerts"`
	SystemMessageAlerts bool   `json:"systemMessageAlerts"`
}

type notificationPage struct {
	allNotifications     []inboxNotification
	Address              string                  `json:"address"`
	ChainID              int                     `json:"chainId"`
	Notifications        []inboxNotification     `json:"notifications"`
	Preferences          notificationPreferences `json:"preferences"`
	ChainEventsAvailable bool                    `json:"chainEventsAvailable"`
}

type notificationReadInput struct {
	ID                     string `json:"id"`
	ExpectedSourceRevision string `json:"expectedSourceRevision"`
}

type notificationPreferenceInput struct {
	Revision            string `json:"revision"`
	TransactionAlerts   *bool  `json:"transactionAlerts"`
	SystemMessageAlerts *bool  `json:"systemMessageAlerts"`
}

var notificationRevisionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,19})$`)
var notificationEventNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{1,79}$`)

func notificationRevision(value string, zero bool) (uint64, bool) {
	if !notificationRevisionPattern.MatchString(value) {
		return 0, false
	}
	n, err := strconv.ParseUint(value, 10, 64)
	return n, err == nil && (zero || n > 0)
}

// Inputs are flat typed objects. Reject duplicate keys before typed decoding;
// DisallowUnknownFields by itself does not reject duplicate JSON members.
func notificationReadJSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(body) > 4096 {
		return adminError(413, "The notification request is too large.")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return adminError(400, "A single notification object is required.")
	}
	allowed := map[string]bool{}
	switch target.(type) {
	case *notificationReadInput:
		allowed["id"], allowed["expectedSourceRevision"] = true, true
	case *notificationPreferenceInput:
		allowed["revision"], allowed["transactionAlerts"], allowed["systemMessageAlerts"] = true, true, true
	default:
		return adminError(400, "Unsupported notification input.")
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || !allowed[name] || seen[name] {
			return adminError(400, "Duplicate notification fields are not supported.")
		}
		seen[name] = true
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return adminError(400, "Invalid notification JSON.")
		}
	}
	if _, err := d.Token(); err != nil {
		return adminError(400, "Invalid notification JSON.")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return adminError(400, "A single notification object is required.")
	}
	d = json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return adminError(400, "Only supported notification fields are accepted.")
	}
	return nil
}

func registerNotifications(mux *http.ServeMux, auth *userAuthService) {
	service := &notificationService{auth: auth}
	service.registerRoutes(mux)
}

func (service *notificationService) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/user/notifications", service.protect(service.list))
	mux.HandleFunc("POST /v1/user/notifications/read", service.protect(service.markRead))
	mux.HandleFunc("GET /v1/user/notification-preferences", service.protect(service.getPreferences))
	mux.HandleFunc("PUT /v1/user/notification-preferences", service.protect(service.savePreferences))
}

func (service *notificationService) fail(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	var p *adminProblem
	if errors.As(err, &p) {
		writeProblem(w, r, p.status, "Notification request rejected", p.detail)
	} else if errors.Is(err, errUserUnauthorized) || errors.Is(err, errUserForbidden) {
		service.auth.writeError(w, r, err)
	} else {
		writeProblem(w, r, 503, "Notifications unavailable", "The durable notification state could not be confirmed.")
	}
}

func (service *notificationService) protect(next administrationHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		token := r.Header.Get("Authorization")
		if !strings.HasPrefix(token, "Bearer ") {
			service.fail(w, r, errUserUnauthorized)
			return
		}
		s, err := service.auth.authenticate(r.Context(), strings.TrimPrefix(token, "Bearer "), false)
		if err != nil {
			service.fail(w, r, err)
			return
		}
		if r.URL.RawQuery != "" {
			service.fail(w, r, adminError(400, "Notification query parameters are not supported."))
			return
		}
		next(w, r, s)
	}
}

func (service *notificationService) lockSession(ctx context.Context, tx *sql.Tx, s *userAuthSession) error {
	live, err := scanUserSession(tx.QueryRowContext(ctx, selectUserSession+" FOR SHARE", s.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return errUserUnauthorized
	}
	if err != nil {
		return err
	}
	now := service.auth.now().UnixMilli()
	if live.revoked || live.ExpiresAt <= now || s.AccessExpiresAt <= now ||
		live.ID != s.ID || live.Address != s.Address || live.ChainID != s.ChainID ||
		live.origin != s.origin || live.origin != service.auth.origin ||
		!userAuthChainEnabled(live.ChainID) {
		return errUserUnauthorized
	}
	return nil
}

func (service *notificationService) preferences(ctx context.Context, tx *sql.Tx, s *userAuthSession) (notificationPreferences, error) {
	p := notificationPreferences{}
	// This existing-owner/chain row serializes materialization and preference
	// writes across sessions without inventing an authorization capability.
	_, err := tx.ExecContext(ctx, `INSERT INTO notification_preferences
		(owner_address,chain_id,updated_at) VALUES (?,?,?)
		ON DUPLICATE KEY UPDATE owner_address=owner_address`, s.Address, s.ChainID, service.auth.now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return p, err
	}
	var revision uint64
	err = tx.QueryRowContext(ctx, `SELECT revision,transaction_alerts,system_message_alerts
		FROM notification_preferences WHERE owner_address=? AND chain_id=? FOR UPDATE`,
		s.Address, s.ChainID).Scan(&revision, &p.TransactionAlerts, &p.SystemMessageAlerts)
	p.Revision = strconv.FormatUint(revision, 10)
	return p, err
}

// Sources are locked before preferences and projection rows. No caller payload,
// legacy notification JSON, registry observation or administrative draft is used
// as transaction authority or as a source of private notification content.
func (service *notificationService) sources(ctx context.Context, tx *sql.Tx, s *userAuthSession) ([]inboxNotification, error) {
	result := []inboxNotification{}
	if s.ChainID == hoodiChainID {
		predicate, args := portfolioWalletPredicate("", s.Address)
		rows, err := tx.QueryContext(ctx, `SELECT LOWER(transaction_hash),log_index,
			LOWER(contract_address),event_name,CAST(block_number AS CHAR),
			removed,confirmed,notification_revision FROM chain_events
			WHERE chain_id=? AND (`+predicate+`)
			ORDER BY block_number DESC,log_index DESC,transaction_hash DESC LIMIT 99 FOR SHARE`,
			append([]any{s.ChainID}, args...)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			e := new(notificationEvent)
			var removed, confirmed bool
			var revision uint64
			if err := rows.Scan(&e.TransactionHash, &e.LogIndex, &e.ContractAddress, &e.EventName, &e.BlockNumber, &removed, &confirmed, &revision); err != nil {
				rows.Close()
				return nil, err
			}
			if !txHashPattern.MatchString(e.TransactionHash) || !addressPattern.MatchString(e.ContractAddress) ||
				!notificationEventNamePattern.MatchString(e.EventName) || revision == 0 {
				rows.Close()
				return nil, errors.New("invalid canonical notification event")
			}
			state := "pending"
			if removed {
				state = "removed"
			} else if confirmed {
				state = "confirmed"
			}
			result = append(result, inboxNotification{SourceKind: "chain_event",
				SourceKey:      portfolioEventID(s.ChainID, e.TransactionHash, e.LogIndex),
				SourceRevision: strconv.FormatUint(revision, 10), State: state, MessageCode: "event_" + state, Event: e})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	var enabled bool
	var text string
	var revision uint64
	err := tx.QueryRowContext(ctx, `SELECT revision,notice_enabled,notice_text
		FROM platform_configuration WHERE configuration_id=1 FOR SHARE`).Scan(&revision, &enabled, &text)
	if err != nil || revision == 0 {
		if err == nil {
			err = errors.New("invalid published notice revision")
		}
		return nil, err
	}
	notice := inboxNotification{SourceKind: "system_notice", SourceKey: "platform:service_notice",
		SourceRevision: strconv.FormatUint(revision, 10), State: "withdrawn", MessageCode: "service_notice"}
	if enabled {
		if !adminText(text, 1, 500) {
			return nil, errors.New("invalid public service notice")
		}
		notice.State, notice.Text = "published", &text
	}
	return append(result, notice), nil
}

func (service *notificationService) materialize(ctx context.Context, tx *sql.Tx, s *userAuthSession, item inboxNotification) (*inboxNotification, error) {
	var id string
	var oldRevision uint64
	var readRevision sql.NullString
	var readAt sql.NullTime
	err := tx.QueryRowContext(ctx, `SELECT notification_id,source_revision,
		CAST(read_revision AS CHAR),read_at FROM notifications
		WHERE owner_address=? AND chain_id=? AND source_kind=? AND source_key=? FOR UPDATE`,
		s.Address, s.ChainID, item.SourceKind, item.SourceKey).Scan(&id, &oldRevision, &readRevision, &readAt)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return nil, err
	}
	if missing && item.State == "withdrawn" {
		return nil, nil
	}
	current, _ := notificationRevision(item.SourceRevision, false)
	if !missing && current < oldRevision {
		return nil, errors.New("canonical notification revision moved backwards")
	}
	payload, err := json.Marshal(map[string]any{"state": item.State, "messageCode": item.MessageCode, "event": item.Event, "text": item.Text})
	if err != nil {
		return nil, err
	}
	now := service.auth.now().UTC().Truncate(time.Microsecond)
	if missing {
		id, err = userRandomToken(16)
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO notifications
			(notification_id,owner_address,notification_type,payload,chain_id,source_kind,
			source_key,source_revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			id, s.Address, item.SourceKind, payload, s.ChainID, item.SourceKind, item.SourceKey, current, now)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE notifications SET payload=?,
			read_revision=IF(source_revision<>? OR ?='withdrawn',NULL,read_revision),
			read_at=IF(source_revision<>? OR ?='withdrawn',NULL,read_at),
			source_revision=?,updated_at=? WHERE notification_id=? AND owner_address=? AND chain_id=?`,
			payload, current, item.State, current, item.State, current, now, id, s.Address, s.ChainID)
	}
	if err != nil {
		return nil, err
	}
	item.ID = id
	if !adminIDPattern.MatchString(id) {
		return nil, errors.New("invalid notification storage identity")
	}
	if !missing && current == oldRevision && item.State != "withdrawn" && readRevision.Valid &&
		readRevision.String == item.SourceRevision && readAt.Valid {
		value := readAt.Time.UTC().Format(time.RFC3339Nano)
		item.Read, item.ReadAt = true, &value
	}
	return &item, nil
}

func (service *notificationService) page(ctx context.Context, tx *sql.Tx, s *userAuthSession) (notificationPage, error) {
	out := notificationPage{Address: s.Address, ChainID: s.ChainID, Notifications: []inboxNotification{},
		ChainEventsAvailable: s.ChainID == hoodiChainID}
	if err := service.lockSession(ctx, tx, s); err != nil {
		return out, err
	}
	sources, err := service.sources(ctx, tx, s)
	if err != nil {
		return out, err
	}
	out.Preferences, err = service.preferences(ctx, tx, s)
	if err != nil {
		return out, err
	}
	for _, source := range sources {
		item, err := service.materialize(ctx, tx, s, source)
		if err != nil {
			return out, err
		}
		if item != nil {
			out.allNotifications = append(out.allNotifications, *item)
		}
		if item != nil && ((item.SourceKind == "chain_event" && out.Preferences.TransactionAlerts) ||
			(item.SourceKind == "system_notice" && out.Preferences.SystemMessageAlerts)) {
			out.Notifications = append(out.Notifications, *item)
		}
	}
	return out, nil
}

func (service *notificationService) readPage(w http.ResponseWriter, r *http.Request, s *userAuthSession, preferencesOnly bool) {
	tx, err := service.auth.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer tx.Rollback()
	page, err := service.page(r.Context(), tx, s)
	if err == nil {
		err = service.lockSession(r.Context(), tx, s)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		service.fail(w, r, err)
		return
	}
	if preferencesOnly {
		writeJSON(w, 200, page.Preferences)
	} else {
		writeJSON(w, 200, page)
	}
}

func (service *notificationService) list(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	service.readPage(w, r, s, false)
}

func (service *notificationService) getPreferences(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	service.readPage(w, r, s, true)
}

type notificationChange func(*sql.Tx, *notificationPage, bool) error

// Reuse administration_requests and its existing actor/key/exact-payload SHA256
// scheme. This is an application idempotency record, never a grant/receipt digest.
// Replays revalidate current sources and state instead of serving a cached page.
func (service *notificationService) mutate(w http.ResponseWriter, r *http.Request, s *userAuthSession, input any, change notificationChange) {
	key := r.Header.Get("Idempotency-Key")
	if !adminKeyPattern.MatchString(key) {
		service.fail(w, r, adminError(400, "A 16-128 character Idempotency-Key is required."))
		return
	}
	payload, err := json.Marshal(struct {
		ChainID int `json:"chainId"`
		Input   any `json:"input"`
	}{s.ChainID, input})
	if err != nil {
		service.fail(w, r, err)
		return
	}
	hash := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), payload...))
	actorHash, keyHash := sha256.Sum256([]byte(s.Address)), sha256.Sum256([]byte(key))
	tx, err := service.auth.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		service.fail(w, r, err)
		return
	}
	defer tx.Rollback()
	page, err := service.page(r.Context(), tx, s)
	if err != nil {
		service.fail(w, r, err)
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO administration_requests
		(actor_hash,key_hash,payload_hash,created_at) VALUES (?,?,?,?)
		ON DUPLICATE KEY UPDATE key_hash=key_hash`, actorHash[:], keyHash[:], hash[:], service.auth.now().UTC().Truncate(time.Microsecond))
	if err != nil {
		service.fail(w, r, err)
		return
	}
	var stored []byte
	var code sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT payload_hash,response_status FROM administration_requests
		WHERE actor_hash=? AND key_hash=? FOR UPDATE`, actorHash[:], keyHash[:]).Scan(&stored, &code)
	if err == nil && !bytes.Equal(stored, hash[:]) {
		err = adminError(409, "This idempotency key belongs to a different exact request.")
	}
	if err == nil && code.Valid && code.Int64 != 200 {
		err = errors.New("invalid notification mutation record")
	}
	if err == nil {
		err = change(tx, &page, code.Valid)
	}
	if err == nil && !code.Valid {
		_, err = tx.ExecContext(r.Context(), `UPDATE administration_requests SET response=?,response_status=200
			WHERE actor_hash=? AND key_hash=?`, []byte(`{"committed":true}`), actorHash[:], keyHash[:])
	}
	if err == nil {
		err = service.lockSession(r.Context(), tx, s)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		service.fail(w, r, err)
		return
	}
	writeJSON(w, 200, page)
}

func (service *notificationService) markRead(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input notificationReadInput
	if err := notificationReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	revision, valid := notificationRevision(input.ExpectedSourceRevision, false)
	if !adminIDPattern.MatchString(input.ID) {
		service.fail(w, r, adminError(404, "The notification was not found."))
		return
	}
	if !valid {
		service.fail(w, r, adminError(422, "A canonical current source revision is required."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx, page *notificationPage, replay bool) error {
		for i := range page.Notifications {
			item := &page.Notifications[i]
			if item.ID != input.ID {
				continue
			}
			if item.SourceRevision != input.ExpectedSourceRevision || item.State == "withdrawn" {
				return adminError(409, "This notification source has changed. Refresh before acting.")
			}
			if replay && !item.Read {
				return adminError(409, "The prior acknowledgement no longer matches current state.")
			}
			if !item.Read {
				now := service.auth.now().UTC().Truncate(time.Microsecond)
				result, err := tx.ExecContext(r.Context(), `UPDATE notifications SET read_revision=?,read_at=?
					WHERE notification_id=? AND owner_address=? AND chain_id=? AND source_revision=?`,
					revision, now, input.ID, s.Address, s.ChainID, revision)
				if err != nil {
					return err
				}
				affected, err := result.RowsAffected()
				if err != nil {
					return err
				}
				if affected != 1 {
					return adminError(409, "The notification changed before acknowledgement.")
				}
				value := now.Format(time.RFC3339Nano)
				item.Read, item.ReadAt = true, &value
			}
			return nil
		}
		return adminError(404, "The notification was not found.")
	})
}

func (service *notificationService) savePreferences(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
	var input notificationPreferenceInput
	if err := notificationReadJSON(r, &input); err != nil {
		service.fail(w, r, err)
		return
	}
	expected, valid := notificationRevision(input.Revision, true)
	if !valid || input.TransactionAlerts == nil || input.SystemMessageAlerts == nil || expected == math.MaxUint64 {
		service.fail(w, r, adminError(422, "Current revision and both explicit alert preferences are required."))
		return
	}
	service.mutate(w, r, s, input, func(tx *sql.Tx, page *notificationPage, replay bool) error {
		current, valid := notificationRevision(page.Preferences.Revision, true)
		if !valid {
			return errors.New("invalid stored preference revision")
		}
		if replay {
			if current != expected+1 || page.Preferences.TransactionAlerts != *input.TransactionAlerts ||
				page.Preferences.SystemMessageAlerts != *input.SystemMessageAlerts {
				return adminError(409, "The preference receipt is no longer current. Refresh before acting.")
			}
			return nil
		}
		if current != expected {
			return adminError(409, "The preferences have changed. Refresh before saving.")
		}
		result, err := tx.ExecContext(r.Context(), `UPDATE notification_preferences SET
			transaction_alerts=?,system_message_alerts=?,revision=revision+1,updated_at=?
			WHERE owner_address=? AND chain_id=? AND revision=?`,
			*input.TransactionAlerts, *input.SystemMessageAlerts, service.auth.now().UTC().Truncate(time.Microsecond), s.Address, s.ChainID, expected)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return adminError(409, "The preferences have changed. Refresh before saving.")
		}
		page.Preferences = notificationPreferences{Revision: strconv.FormatUint(expected+1, 10),
			TransactionAlerts: *input.TransactionAlerts, SystemMessageAlerts: *input.SystemMessageAlerts}
		filtered := []inboxNotification{}
		for _, item := range page.allNotifications {
			if (item.SourceKind == "chain_event" && *input.TransactionAlerts) ||
				(item.SourceKind == "system_notice" && *input.SystemMessageAlerts) {
				filtered = append(filtered, item)
			}
		}
		page.Notifications = filtered
		return nil
	})
}
