package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func decodeJSON(request *http.Request, value any) error {
	// Read one extra byte before decoding. A LimitReader at the exact limit can
	// otherwise hide a second value or excess whitespace behind an apparent EOF.
	raw, err := io.ReadAll(io.LimitReader(request.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return errors.New("request body must not exceed 64 KiB and must be readable")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("request body must be a valid JSON object with known fields")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request body must contain exactly one JSON object")
	}
	return nil
}
