package httpapi

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func mustCursorTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(cursorTimeLayout, value)
	if err != nil {
		t.Fatalf("fixture time %q does not parse: %v", value, err)
	}
	return parsed
}

const fixtureEventID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

func fixtureCursor(t *testing.T) marketActivityCursor {
	t.Helper()
	return marketActivityCursor{
		EventTimestamp: mustCursorTime(t, "2026-09-29T08:15:04.123456Z"),
		ReceivedAt:     mustCursorTime(t, "2026-09-29T08:15:05.654321Z"),
		EventID:        fixtureEventID,
	}
}

func TestMarketActivityCursorRoundTrips(t *testing.T) {
	original := fixtureCursor(t)
	decoded, err := decodeMarketActivityCursor(encodeMarketActivityCursor(original))
	if err != nil {
		t.Fatalf("round trip failed: %v", err)
	}
	if !decoded.EventTimestamp.Equal(original.EventTimestamp) {
		t.Errorf("event timestamp drifted: got %v, want %v", decoded.EventTimestamp, original.EventTimestamp)
	}
	if !decoded.ReceivedAt.Equal(original.ReceivedAt) {
		t.Errorf("received_at drifted: got %v, want %v", decoded.ReceivedAt, original.ReceivedAt)
	}
	if decoded.EventID != original.EventID {
		t.Errorf("event id drifted: got %q, want %q", decoded.EventID, original.EventID)
	}
}

// TIMESTAMP(6) is microsecond precision. A cursor rounded to the second would be ambiguous across
// every event sharing that second, and the walk would skip or repeat them.
func TestMarketActivityCursorKeepsMicroseconds(t *testing.T) {
	original := fixtureCursor(t)
	decoded, err := decodeMarketActivityCursor(encodeMarketActivityCursor(original))
	if err != nil {
		t.Fatalf("round trip failed: %v", err)
	}
	if decoded.EventTimestamp.Nanosecond() != 123456000 {
		t.Errorf("microseconds lost: got %d ns", decoded.EventTimestamp.Nanosecond())
	}
	if decoded.ReceivedAt.Nanosecond() != 654321000 {
		t.Errorf("microseconds lost on received_at: got %d ns", decoded.ReceivedAt.Nanosecond())
	}
}

// A position that cannot be read is refused, never rounded to the head. Starting over would serve
// the newest page to a reader who asked for an older one, with nothing to tell them it happened.
func TestMarketActivityCursorRefusesMalformedInput(t *testing.T) {
	valid := encodeMarketActivityCursor(fixtureCursor(t))
	cases := map[string]string{
		"empty":                 "",
		"not base64":            "!!!not-base64!!!",
		"standard base64 pad":   "YWJjZA==",
		"too few fields":        encodeRaw("1|2026-09-29T08:15:04.123456Z|" + fixtureEventID),
		"too many fields":       encodeRaw("1|a|b|c|d"),
		"unknown version":       encodeRaw("2|2026-09-29T08:15:04.123456Z|2026-09-29T08:15:05.654321Z|" + fixtureEventID),
		"bad event timestamp":   encodeRaw("1|not-a-time|2026-09-29T08:15:05.654321Z|" + fixtureEventID),
		"bad received at":       encodeRaw("1|2026-09-29T08:15:04.123456Z|not-a-time|" + fixtureEventID),
		"second precision only": encodeRaw("1|2026-09-29T08:15:04Z|2026-09-29T08:15:05Z|" + fixtureEventID),
		"short event id":        encodeRaw("1|2026-09-29T08:15:04.123456Z|2026-09-29T08:15:05.654321Z|abc"),
		"upper case event id":   encodeRaw("1|2026-09-29T08:15:04.123456Z|2026-09-29T08:15:05.654321Z|" + strings.ToUpper(fixtureEventID)),
		"sql in event id":       encodeRaw("1|2026-09-29T08:15:04.123456Z|2026-09-29T08:15:05.654321Z|' OR 1=1 --"),
	}
	for name, value := range cases {
		if _, err := decodeMarketActivityCursor(value); err == nil {
			t.Errorf("%s: expected refusal, got none", name)
		}
	}
	if _, err := decodeMarketActivityCursor(valid); err != nil {
		t.Errorf("the valid cursor beside them was refused: %v", err)
	}
}

// The predicate is what makes the next page the next page. Its argument order must match its
// placeholders, and the tuple must be compared strictly, or the walk repeats its last row forever.
func TestMarketActivityKeysetPredicateBindsEveryPlaceholder(t *testing.T) {
	cursor := fixtureCursor(t)
	clause, args := marketActivityKeysetPredicate(cursor)
	if placeholders := strings.Count(clause, "?"); placeholders != len(args) {
		t.Fatalf("clause has %d placeholders and %d arguments", placeholders, len(args))
	}
	if strings.Contains(clause, "<=") || strings.Contains(clause, ">=") {
		t.Error("the comparison must be strict, or the cursor's own row is served again")
	}
	if !strings.Contains(clause, "event_id <") {
		t.Error("the primary key must break the tie, or two events in the same microsecond are ambiguous")
	}
	wantEvent := "2026-09-29T08:15:04.123456"
	wantReceived := "2026-09-29T08:15:05.654321"
	expected := []any{
		wantEvent + "Z",
		wantEvent + "Z", wantReceived + "Z",
		wantEvent + "Z", wantReceived + "Z", fixtureEventID,
	}
	if len(args) != len(expected) {
		t.Fatalf("got %d arguments, want %d", len(args), len(expected))
	}
	for index, want := range expected {
		if args[index] != want {
			t.Errorf("argument %d: got %v, want %v", index, args[index], want)
		}
	}
}

// The cursor names a position in a public read-only feed. It must not be a place to smuggle
// anything else: every field is re-validated on the way in, so nothing reaches a query but a
// timestamp pair and a 64-character hex id.
func TestMarketActivityCursorCarriesNothingButAPosition(t *testing.T) {
	forged := encodeRaw("1|2026-09-29T08:15:04.123456Z|2026-09-29T08:15:05.654321Z|" +
		"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' UNION SELECT")
	if _, err := decodeMarketActivityCursor(forged); err == nil {
		t.Fatal("a cursor carrying SQL was accepted")
	}
}

// encodeRaw builds a cursor body without going through the encoder, so a test can pose as a client
// sending something the encoder would never produce.
func encodeRaw(raw string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// The cursor for a page's last row is built from the strings the query produced. A row whose
// position cannot be expressed is an error, not a page served with a cursor that would not come
// back to the right place.
func TestMarketActivityCursorFromRow(t *testing.T) {
	encoded, err := marketActivityCursorFromRow(
		"2026-09-29T08:15:04.123456Z", "2026-09-29T08:15:05.654321Z", fixtureEventID)
	if err != nil {
		t.Fatalf("a well-formed row was refused: %v", err)
	}
	decoded, err := decodeMarketActivityCursor(encoded)
	if err != nil {
		t.Fatalf("the cursor it produced does not decode: %v", err)
	}
	if decoded.EventID != fixtureEventID {
		t.Errorf("event id drifted: got %q", decoded.EventID)
	}
	if got := decoded.EventTimestamp.Format(cursorTimeLayout); got != "2026-09-29T08:15:04.123456Z" {
		t.Errorf("event timestamp drifted: got %s", got)
	}

	for name, row := range map[string][3]string{
		"unparsable event timestamp": {"nope", "2026-09-29T08:15:05.654321Z", fixtureEventID},
		"unparsable received at":     {"2026-09-29T08:15:04.123456Z", "nope", fixtureEventID},
		"event id is not a digest":   {"2026-09-29T08:15:04.123456Z", "2026-09-29T08:15:05.654321Z", "short"},
	} {
		if _, err := marketActivityCursorFromRow(row[0], row[1], row[2]); err == nil {
			t.Errorf("%s: expected an error, got none", name)
		}
	}
}
