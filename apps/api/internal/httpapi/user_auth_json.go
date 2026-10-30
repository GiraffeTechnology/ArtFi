package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

const userAuthJSONLimit = 8192

// Authentication messages admit one bounded UTF-8 object with exact field names.
// encoding/json alone accepts repeated names, case aliases and invalid UTF-8.
func decodeUserAuthObject(raw []byte, target any) error {
	invalid := func() error { return errors.New("invalid authentication JSON object") }
	if len(raw) > userAuthJSONLimit || !utf8.Valid(raw) {
		return invalid()
	}
	value := reflect.ValueOf(target)
	if !value.IsValid() || value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Kind() != reflect.Struct {
		return invalid()
	}
	typ := value.Elem().Type()
	fields := make(map[string]bool, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !field.IsExported() {
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return invalid()
	}
	seen := make(map[string]bool, len(fields))
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || !fields[name] || seen[name] {
			return invalid()
		}
		seen[name] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return invalid()
		}
	}
	if last, err := decoder.Token(); err != nil || last != json.Delim('}') {
		return invalid()
	}
	if decoder.Decode(new(any)) != io.EOF {
		return invalid()
	}
	typed := json.NewDecoder(bytes.NewReader(raw))
	typed.DisallowUnknownFields()
	if typed.Decode(target) != nil {
		return invalid()
	}
	return nil
}
