package httpapi

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

type jsonBodyBoundaryInput struct {
	Name string `json:"name"`
}

func jsonBodyBoundaryPrefix() string {
	value := `{"name":"original"}`
	return value + strings.Repeat(" ", (64<<10)-len(value))
}

func jsonBodyBoundaryReject(t *testing.T, body io.Reader) {
	t.Helper()
	var target jsonBodyBoundaryInput
	if err := decodeJSON(httptest.NewRequest("POST", "/", body), &target); err == nil {
		t.Fatal("request exceeding the complete body boundary was accepted")
	}
}

func TestJSONBodyOversizePadding(t *testing.T) {
	jsonBodyBoundaryReject(t, strings.NewReader(jsonBodyBoundaryPrefix()+" "))
}

func TestJSONBodySecondValueBeyondLimit(t *testing.T) {
	jsonBodyBoundaryReject(t, strings.NewReader(jsonBodyBoundaryPrefix()+`{"name":"replacement"}`))
}

func TestJSONBodyGarbageBeyondLimit(t *testing.T) {
	jsonBodyBoundaryReject(t, strings.NewReader(jsonBodyBoundaryPrefix()+"x"))
}

type jsonBodyBoundaryErrorReader struct{}

func (jsonBodyBoundaryErrorReader) Read([]byte) (int, error) {
	return 0, errors.New("test body read failure")
}

func TestJSONBodyReadFailureBeyondLimit(t *testing.T) {
	jsonBodyBoundaryReject(t, io.MultiReader(strings.NewReader(jsonBodyBoundaryPrefix()), jsonBodyBoundaryErrorReader{}))
}

func TestJSONBodyOversizeDoesNotDecode(t *testing.T) {
	target := jsonBodyBoundaryInput{Name: "untouched"}
	err := decodeJSON(httptest.NewRequest("POST", "/", strings.NewReader(jsonBodyBoundaryPrefix()+" ")), &target)
	if err == nil || target.Name != "untouched" {
		t.Fatalf("oversize request decoded into caller state: target=%+v error=%v", target, err)
	}
}

func TestJSONBodyExactLimit(t *testing.T) {
	var target jsonBodyBoundaryInput
	if err := decodeJSON(httptest.NewRequest("POST", "/", strings.NewReader(jsonBodyBoundaryPrefix())), &target); err != nil || target.Name != "original" {
		t.Fatalf("valid exact-limit request rejected: target=%+v error=%v", target, err)
	}
}

func TestJSONBodyExactLimitStringValue(t *testing.T) {
	const prefix = `{"name":"`
	const suffix = `"}`
	name := strings.Repeat("a", (64<<10)-len(prefix)-len(suffix))
	var target jsonBodyBoundaryInput
	if err := decodeJSON(httptest.NewRequest("POST", "/", strings.NewReader(prefix+name+suffix)), &target); err != nil || target.Name != name {
		t.Fatalf("valid exact-limit string rejected: error=%v", err)
	}
}

func TestJSONBodyCanonicalWhitespace(t *testing.T) {
	var target jsonBodyBoundaryInput
	err := decodeJSON(httptest.NewRequest("POST", "/", strings.NewReader(" \n"+`{"name":"original"}`+"\t\n")), &target)
	if err != nil || target.Name != "original" {
		t.Fatalf("canonical request changed: target=%+v error=%v", target, err)
	}
}

func TestJSONBodyUnknownField(t *testing.T) {
	jsonBodyBoundaryReject(t, strings.NewReader(`{"name":"original","unknown":true}`))
}

func TestJSONBodySecondValueWithinLimit(t *testing.T) {
	for _, suffix := range []string{`{}`, `null`, `true`, `[]`, `x`} {
		t.Run(suffix, func(t *testing.T) {
			jsonBodyBoundaryReject(t, strings.NewReader(`{"name":"original"}`+suffix))
		})
	}
}

func TestJSONBodyMalformed(t *testing.T) {
	for _, body := range []string{"", `{"name":`, `{"name":5}`, `{"name":"original",}`} {
		t.Run(body, func(t *testing.T) {
			jsonBodyBoundaryReject(t, strings.NewReader(body))
		})
	}
}

func TestJSONBodyReadFailureBeforeLimit(t *testing.T) {
	jsonBodyBoundaryReject(t, io.MultiReader(strings.NewReader(`{"name":"original"}`), jsonBodyBoundaryErrorReader{}))
}

type jsonBodyBoundaryCountingReader struct{ bytes int }

func (reader *jsonBodyBoundaryCountingReader) Read(buffer []byte) (int, error) {
	for i := range buffer {
		buffer[i] = ' '
	}
	reader.bytes += len(buffer)
	return len(buffer), nil
}

func TestJSONBodyBoundedReader(t *testing.T) {
	reader := &jsonBodyBoundaryCountingReader{}
	jsonBodyBoundaryReject(t, reader)
	if reader.bytes > (64<<10)+1 {
		t.Fatalf("read beyond the bounded oversize sentinel: %d bytes", reader.bytes)
	}
}
