package httpapi

import (
 "bytes"
 "encoding/json"
 "errors"
 "io"
 "unicode"
 "unicode/utf8"
)

type daoAvatar struct {
 Text string `json:"text"`
 Palette string `json:"palette"`
}
type daoPresentation struct {
 Version int `json:"version"`
 Description string `json:"description"`
 Avatar daoAvatar `json:"avatar"`
}
func validDAOPresentation(value *daoPresentation) bool {
 if value == nil { return true }
 if value.Version != 1 || !utf8.ValidString(value.Description) || len(value.Description) > 2000 ||
    !utf8.ValidString(value.Avatar.Text) || utf8.RuneCountInString(value.Avatar.Text) < 1 || utf8.RuneCountInString(value.Avatar.Text) > 3 { return false }
 for _, r := range value.Description { if unicode.IsControl(r) && r != '\n' { return false } }
 for _, r := range value.Avatar.Text { if !unicode.IsLetter(r) && !unicode.IsNumber(r) { return false } }
 switch value.Avatar.Palette { case "teal", "violet", "gold", "rose", "slate": return true }
 return false
}
func cloneDAOPresentation(value *daoPresentation) *daoPresentation {
 if value == nil { return nil }
 copy := *value
 return &copy
}
func daoPresentationJSON(value *daoPresentation) (any, error) {
 if value == nil { return nil, nil }
 if !validDAOPresentation(value) { return nil, errors.New("invalid DAO presentation") }
 encoded, err := json.Marshal(value)
 if err != nil { return nil, err }
 return string(encoded), nil
}
func decodeDAOPresentation(raw []byte) (*daoPresentation, error) {
 if raw == nil { return nil, nil }
 if len(raw) > 16384 { return nil, errors.New("invalid DAO presentation") }
 decoder := json.NewDecoder(bytes.NewReader(raw))
 decoder.DisallowUnknownFields()
 var result daoPresentation
 if err := decoder.Decode(&result); err != nil { return nil, errors.New("invalid DAO presentation") }
 if decoder.Decode(new(any)) != io.EOF || !validDAOPresentation(&result) {
   return nil, errors.New("invalid DAO presentation")
 }
 return &result, nil
}
