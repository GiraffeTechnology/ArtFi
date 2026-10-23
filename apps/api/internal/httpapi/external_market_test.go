package httpapi

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestMarketActivityCursorRoundTripAndTamperRejection(t *testing.T) {
	eventTimestamp := "2026-09-13T01:02:03.123456Z"
	receivedAt := "2026-09-13T01:02:04.654321Z"
	eventID := strings.Repeat("a", 64)
	filterHash := marketActivityFilterHash("opensea", "ethereum", "0x1111111111111111111111111111111111111111", "42", "sale", "fulfilled")
	cursor := encodeMarketActivityCursor(eventTimestamp, receivedAt, eventID, filterHash)
	decodedEvent, decodedReceived, decodedID, err := decodeMarketActivityCursor(cursor, filterHash)
	if err != nil {
		t.Fatal(err)
	}
	if decodedEvent.Format("2006-01-02T15:04:05.999999999Z07:00") != eventTimestamp ||
		decodedReceived.Format("2006-01-02T15:04:05.999999999Z07:00") != receivedAt || decodedID != eventID {
		t.Fatalf("cursor identity drifted: %s %s %s", decodedEvent, decodedReceived, decodedID)
	}
	for _, invalid := range []string{
		"not-base64!",
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":2,"t":"2026-09-13T01:02:03Z","r":"2026-09-13T01:02:04Z","i":"` + eventID + `","f":"` + filterHash + `"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"t":"2026-09-13T01:02:03Z","r":"2026-09-13T01:02:04Z","i":"` + eventID + `","f":"` + filterHash + `","extra":true}`)),
	} {
		if _, _, _, err := decodeMarketActivityCursor(invalid, filterHash); err == nil {
			t.Fatalf("invalid cursor was accepted: %s", invalid)
		}
	}
	if _, _, _, err := decodeMarketActivityCursor(cursor, marketActivityFilterHash("opensea", "ethereum", "0x1111111111111111111111111111111111111111", "43", "sale", "fulfilled")); err == nil {
		t.Fatal("cursor was accepted for a different filter set")
	}
}

func TestMarketActivityStatusIsReadOnlyAndDeterministic(t *testing.T) {
	cases := []struct {
		family, eventType, expected string
	}{
		{"order", "item_listed", "active"},
		{"order", "item_cancelled", "cancelled"},
		{"order", "order_invalidate", "invalidated"},
		{"sale", "item_sold", "fulfilled"},
		{"transfer", "item_transferred", "observed"},
	}
	for _, test := range cases {
		actual := marketActivityStatus(test.family, test.eventType)
		expected := test.expected
		if actual != expected {
			t.Fatalf("status mismatch for %s/%s: got %s want %s", test.family, test.eventType, actual, expected)
		}
	}
}

func TestMarketUint256RejectsValuesOutsideTheEVMIdentityDomain(t *testing.T) {
	maximum := "115792089237316195423570985008687907853269984665640564039457584007913129639935"
	tooLarge := "115792089237316195423570985008687907853269984665640564039457584007913129639936"
	for _, accepted := range []string{"0", "42", maximum} {
		if !validMarketUint256(accepted) {
			t.Fatalf("valid uint256 rejected: %s", accepted)
		}
	}
	for _, rejected := range []string{"-1", "+1", "01", tooLarge, "999999999999999999999999999999999999999999999999999999999999999999999999999999"} {
		if validMarketUint256(rejected) {
			t.Fatalf("out-of-domain uint256 accepted: %s", rejected)
		}
	}
}
