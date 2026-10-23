package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestMarketActivityCursorRoundTrip(t *testing.T) {
	item := marketActivity{
		EventID:        strings.Repeat("a", 64),
		EventTimestamp: "2026-09-19T14:00:00.123456Z",
		ReceivedAt:     "2026-09-19T14:00:01.654321Z",
	}
	encoded := encodeMarketActivityCursor(item)
	decoded, err := decodeMarketActivityCursor(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.EventID != item.EventID ||
		decoded.EventTimestamp != item.EventTimestamp ||
		decoded.ReceivedAt != item.ReceivedAt {
		t.Fatalf("cursor round trip drifted: %#v", decoded)
	}
}

func TestMarketActivityCursorRejectsMalformedBoundaries(t *testing.T) {
	valid := marketActivityCursor{
		EventID:        strings.Repeat("b", 64),
		EventTimestamp: "2026-09-19T14:00:00Z",
		ReceivedAt:     "2026-09-19T14:00:01Z",
	}
	cases := map[string]string{
		"not-base64": "%%%",
		"bad-event-time": encodeCursorForTest(t, marketActivityCursor{
			EventID: strings.Repeat("b", 64), EventTimestamp: "yesterday", ReceivedAt: valid.ReceivedAt,
		}),
		"bad-received-time": encodeCursorForTest(t, marketActivityCursor{
			EventID: strings.Repeat("b", 64), EventTimestamp: valid.EventTimestamp, ReceivedAt: "tomorrow",
		}),
		"uppercase-event-id": encodeCursorForTest(t, marketActivityCursor{
			EventID: strings.Repeat("A", 64), EventTimestamp: valid.EventTimestamp, ReceivedAt: valid.ReceivedAt,
		}),
		"short-event-id": encodeCursorForTest(t, marketActivityCursor{
			EventID: "ab", EventTimestamp: valid.EventTimestamp, ReceivedAt: valid.ReceivedAt,
		}),
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeMarketActivityCursor(value); err == nil {
				t.Fatal("malformed cursor was accepted")
			}
		})
	}
}

func encodeCursorForTest(t *testing.T, cursor marketActivityCursor) string {
	t.Helper()
	payload, err := json.Marshal(cursor)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}
