package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUserAuthExactJSONObjectAdmission(t *testing.T) {
	valid := `{"address":"` + userAuthTestAddress + `","chainId":560048,"origin":"https://artfi.test"}`
	cases := []struct {
		name, body string
		valid      bool
	}{
		{"canonical", valid, true},
		{"whitespace", " \n" + valid + "\t ", true},
		{"escaped canonical key", strings.Replace(valid, `"address"`, `"\u0061ddress"`, 1), true},
		{"duplicate address", strings.Replace(valid, `"address":`, `"address":"other","address":`, 1), false},
		{"escaped duplicate", strings.Replace(valid, `"address":`, `"\u0061ddress":"other","address":`, 1), false},
		{"case alias", strings.Replace(valid, `"address"`, `"Address"`, 1), false},
		{"case alias pair", strings.Replace(valid, `"address":`, `"Address":"other","address":`, 1), false},
		{"null field", strings.Replace(valid, `"origin":"https://artfi.test"`, `"origin":null`, 1), false},
		{"null object", `null`, false},
		{"array", `[]`, false},
		{"second object", valid + `{}`, false},
		{"trailing primitive", valid + `true`, false},
		{"unknown field", strings.TrimSuffix(valid, "}") + `,"extra":1}`, false},
		{"invalid UTF8", strings.Replace(valid, "artfi.test", "artfi."+string([]byte{0xff}), 1), false},
		{"oversize", strings.Repeat(" ", userAuthJSONLimit) + valid, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var input userChallengeInput
			err := readUserAuthJSON(httptest.NewRequest("POST", "/", strings.NewReader(c.body)), &input)
			if (err == nil) != c.valid {
				t.Fatalf("valid=%v error=%v", c.valid, err)
			}
			if err == nil && (input.Address != userAuthTestAddress || input.ChainID != hoodiChainID || input.Origin != "https://artfi.test") {
				t.Fatal("canonical input changed")
			}
		})
	}
}

func TestUserAccessJWTExactClaimObjectAdmission(t *testing.T) {
	now := time.Date(2026, 10, 20, 1, 0, 0, 0, time.UTC)
	service := userAuthTestService(unavailableUserAuthDB{}, func() time.Time { return now })
	session := userAuthSession{ID: strings.Repeat("a", 32), Address: userAuthTestAddress, ChainID: hoodiChainID, origin: service.origin, ExpiresAt: now.Add(userSessionLifetime).UnixMilli()}
	issued, _, err := service.issueAccess(session)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(issued, ".")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	payload := string(raw)
	cases := []struct {
		name, body string
		valid      bool
	}{
		{"issued canonical", payload, true},
		{"trailing whitespace", payload + " \n", true},
		{"second object", payload + `{}`, false},
		{"second null", payload + `null`, false},
		{"duplicate expiry", strings.TrimSuffix(payload, "}") + `,"exp":` + jsonNumber(t, raw, "exp") + `}`, false},
		{"escaped duplicate subject", strings.TrimSuffix(payload, "}") + `,"\u0073ub":"` + userAuthTestAddress + `"}`, false},
		{"noncanonical subject", strings.Replace(payload, `"sub"`, `"Sub"`, 1), false},
		{"duplicate session", strings.TrimSuffix(payload, "}") + `,"sid":"` + session.ID + `"}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			unsigned := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(c.body))
			mac := hmac.New(sha256.New, service.jwtSecret)
			_, _ = mac.Write([]byte(unsigned))
			token := unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
			claims, err := service.parseAccess(token, false)
			if (err == nil) != c.valid {
				t.Fatalf("valid=%v error=%v", c.valid, err)
			}
			if err != nil && !errors.Is(err, errUserUnauthorized) {
				t.Fatal("unexpected error category")
			}
			if err == nil && (claims.SessionID != session.ID || claims.Subject != session.Address) {
				t.Fatal("claim scope changed")
			}
		})
	}
}

func jsonNumber(t *testing.T, raw []byte, name string) string {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	return string(fields[name])
}

func TestUserAuthJSONObjectExactBoundsAndTargets(t *testing.T) {
	var target struct {
		Value string `json:"value"`
	}
	prefix := `{"value":"`
	suffix := `"}`
	body := prefix + strings.Repeat("a", userAuthJSONLimit-len(prefix)-len(suffix)) + suffix
	if decodeUserAuthObject([]byte(body), &target) != nil {
		t.Fatal("exact8192-byte object rejected")
	}
	if decodeUserAuthObject([]byte(body+" "), &target) == nil {
		t.Fatal("8193-byte object accepted")
	}
	for _, dst := range []any{nil, (*userChallengeInput)(nil), new(string), userChallengeInput{}} {
		if decodeUserAuthObject([]byte(`{}`), dst) == nil {
			t.Fatal("invalid decoder target accepted")
		}
	}
}
