package httpapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Cursor pagination for the mirrored activity history — Issue #110's external-marketplace
// baseline, detailed by docs/PRD.md §4.8 XM.2–XM.3.
//
// The endpoint used to serve a `limit` alone, capped at 100, so the most a reader could ever see
// was the hundred most recent events: the history existed in the mirror and no client could walk
// it. A page number would not fix that here. Rows arrive continuously, and offset paging over a
// feed that grows at its head skips and repeats rows as it goes — the reader would be told a
// complete history while silently missing events.
//
// So the cursor is a keyset: the ordering tuple of the last row served. The next page asks for
// rows strictly after it in the same order, which is stable no matter how many events arrive in
// between. Rows inserted at the head after the walk began are simply not in it, which is the
// honest answer — the walk describes the history as of its first page, not a moving target.
//
// The tuple is (event_timestamp, received_at, event_id), descending. The first two are the sort
// the handler already used; neither is unique, and two events sharing both would make the order
// arbitrary and a cursor ambiguous, so the primary key breaks the tie and makes the total order
// strict.
//
// It is opaque to clients by encoding, not by secrecy: base64url of a fixed three-field text. It
// carries no authority — it is a position in a public read-only feed, so it is validated, never
// trusted, and a cursor that does not parse is refused rather than rounded to the start.

// marketActivityCursor is a position in the descending activity order.
type marketActivityCursor struct {
	EventTimestamp time.Time
	ReceivedAt     time.Time
	EventID        string
}

// cursorTimeLayout keeps microsecond precision, matching TIMESTAMP(6) in the schema. Truncating to
// seconds would make the cursor ambiguous across events that share a second.
const cursorTimeLayout = "2006-01-02T15:04:05.000000Z"

var (
	errCursorMalformed = errors.New("cursor is malformed")
	eventIDPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// encodeMarketActivityCursor renders the position of the last row on a page.
func encodeMarketActivityCursor(cursor marketActivityCursor) string {
	raw := fmt.Sprintf("1|%s|%s|%s",
		cursor.EventTimestamp.UTC().Format(cursorTimeLayout),
		cursor.ReceivedAt.UTC().Format(cursorTimeLayout),
		cursor.EventID,
	)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeMarketActivityCursor parses a cursor a client sent back.
//
// Every failure is the same refusal. A cursor is a position, and a position that cannot be read is
// not a reason to start over from the head: that would silently serve the newest page to a reader
// who asked for an older one, and they would have no way to tell.
func decodeMarketActivityCursor(value string) (marketActivityCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return marketActivityCursor{}, errCursorMalformed
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 4 || parts[0] != "1" {
		return marketActivityCursor{}, errCursorMalformed
	}
	eventTimestamp, err := time.Parse(cursorTimeLayout, parts[1])
	if err != nil {
		return marketActivityCursor{}, errCursorMalformed
	}
	receivedAt, err := time.Parse(cursorTimeLayout, parts[2])
	if err != nil {
		return marketActivityCursor{}, errCursorMalformed
	}
	if !eventIDPattern.MatchString(parts[3]) {
		return marketActivityCursor{}, errCursorMalformed
	}
	return marketActivityCursor{
		EventTimestamp: eventTimestamp,
		ReceivedAt:     receivedAt,
		EventID:        parts[3],
	}, nil
}

// marketActivityKeysetPredicate is the SQL that continues a walk, with its arguments.
//
// Written as the expanded comparison rather than MySQL's row-value form, because the row-value
// syntax does not use idx_external_market_activity and this does: the leading equality lets the
// index seek to the position instead of scanning the collection.
func marketActivityKeysetPredicate(cursor marketActivityCursor) (string, []any) {
	eventTimestamp := cursor.EventTimestamp.UTC().Format(cursorTimeLayout)
	receivedAt := cursor.ReceivedAt.UTC().Format(cursorTimeLayout)
	return " AND (event_timestamp < ?" +
			" OR (event_timestamp = ? AND received_at < ?)" +
			" OR (event_timestamp = ? AND received_at = ? AND event_id < ?))",
		[]any{
			eventTimestamp,
			eventTimestamp, receivedAt,
			eventTimestamp, receivedAt, cursor.EventID,
		}
}

// marketActivityCursorFromRow builds the cursor for the last row of a page.
//
// The timestamps arrive as the strings DATE_FORMAT produced, in the same layout the cursor uses, so
// this parses rather than trusts them: a row whose position cannot be expressed is an error worth
// surfacing, not a page served with a cursor that would not come back to the right place.
func marketActivityCursorFromRow(eventTimestamp, receivedAt, eventID string) (string, error) {
	parsedEvent, err := time.Parse(cursorTimeLayout, eventTimestamp)
	if err != nil {
		return "", errCursorMalformed
	}
	parsedReceived, err := time.Parse(cursorTimeLayout, receivedAt)
	if err != nil {
		return "", errCursorMalformed
	}
	if !eventIDPattern.MatchString(eventID) {
		return "", errCursorMalformed
	}
	return encodeMarketActivityCursor(marketActivityCursor{
		EventTimestamp: parsedEvent,
		ReceivedAt:     parsedReceived,
		EventID:        eventID,
	}), nil
}
