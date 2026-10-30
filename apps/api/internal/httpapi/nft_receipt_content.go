package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// NFTReceiptApprovalBinding is the existing application's six-field association
// domain. It is not a source attestation or permission to write a journal.
type NFTReceiptApprovalBinding struct {
	Tenant          string `json:"tenant"`
	Origin          string `json:"origin"`
	TaskID          string `json:"taskId"`
	Actor           string `json:"actor"`
	Escrow          string `json:"escrow"`
	RuntimeCodeHash string `json:"runtimeCodeHash"`
}

// NFTReceiptAuthority is installed by trusted server composition, never request
// JSON or environment fallback. ResolveReceipt must independently verify the
// approved business/source/asset/segment/journal mapping and current applicable
// canonical source facts before returning its installation binding. It must
// honor ctx and must not reacquire the already-held Wallet grant lock.
// Content equality, fixture claims or a caller's assertion cannot implement it.
type NFTReceiptAuthority interface {
	ResolveReceipt(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error)
}

const nftReceiptBusinessSchema = "artfi-whole-receipt-business-plan/1"
const nftReceiptAssociationSchema = "artfi-whole-receipt-journal-binding/1"

var errNFTReceiptContent = errors.New("receipt content binding refused")
var nftReceiptTenant = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
var nftReceiptNativeID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)
var nftReceiptDecimal = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
var nftReceiptAddress = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
var nftReceiptHash = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

// NFTReceiptContentComparison retains complete native bytes separately from
// normalized pregrant content. It conveys content equality only, not authority.
type NFTReceiptContentComparison struct {
	native        json.RawMessage
	business      json.RawMessage
	nativeDigest  string
	operationID   string
	chainID       uint64
	account       string
	planDigest    string
	journalDigest string
}

func (c NFTReceiptContentComparison) NativePlan() json.RawMessage {
	return append(json.RawMessage(nil), c.native...)
}
func (c NFTReceiptContentComparison) Business() json.RawMessage {
	return append(json.RawMessage(nil), c.business...)
}
func (c NFTReceiptContentComparison) NativePlanDigest() string          { return c.nativeDigest }
func (c NFTReceiptContentComparison) ReceiptPlanDigest() string         { return c.planDigest }
func (c NFTReceiptContentComparison) ReceiptJournalBindingHash() string { return c.journalDigest }

type nftReceiptDecoder struct{ err error }

func (d *nftReceiptDecoder) refuse() { d.err = errNFTReceiptContent }
func (d *nftReceiptDecoder) object(raw []byte, required, optional []string) map[string]json.RawMessage {
	if d.err != nil {
		return nil
	}
	reader := json.NewDecoder(bytes.NewReader(raw))
	token, err := reader.Token()
	if err != nil || token != json.Delim('{') {
		d.refuse()
		return nil
	}
	allowed := make(map[string]bool)
	for _, key := range append(append([]string(nil), required...), optional...) {
		allowed[key] = true
	}
	result := make(map[string]json.RawMessage)
	for reader.More() {
		token, err = reader.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] {
			d.refuse()
			return nil
		}
		if _, exists := result[key]; exists {
			d.refuse()
			return nil
		}
		var value json.RawMessage
		if reader.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			d.refuse()
			return nil
		}
		result[key] = append(json.RawMessage(nil), value...)
	}
	if token, err = reader.Token(); err != nil || token != json.Delim('}') {
		d.refuse()
		return nil
	}
	var extra any
	if reader.Decode(&extra) != io.EOF {
		d.refuse()
		return nil
	}
	for _, key := range required {
		if _, exists := result[key]; !exists {
			d.refuse()
			return nil
		}
	}
	return result
}
func (d *nftReceiptDecoder) text(raw []byte) string {
	var value string
	if d.err != nil {
		return ""
	}
	if json.Unmarshal(raw, &value) != nil || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '"' {
		d.refuse()
	}
	return value
}
func (d *nftReceiptDecoder) uintString(raw []byte, bits int, positive bool) string {
	value := d.text(raw)
	number, ok := new(big.Int).SetString(value, 10)
	if !nftReceiptDecimal.MatchString(value) || !ok || number.Sign() < 0 ||
		number.BitLen() > bits || positive && number.Sign() == 0 {
		d.refuse()
	}
	return value
}
func (d *nftReceiptDecoder) number(raw []byte, positive bool) uint64 {
	text := strings.TrimSpace(string(raw))
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || text == "" || text[0] == '"' || math.IsNaN(value) || math.IsInf(value, 0) ||
		value < 0 || math.Trunc(value) != value || value > float64((uint64(1)<<48)-1) ||
		positive && value == 0 {
		d.refuse()
		return 0
	}
	return uint64(value)
}
func (d *nftReceiptDecoder) hash(raw []byte, allowZero bool) string {
	value := d.text(raw)
	if !nftReceiptHash.MatchString(value) || !allowZero && strings.EqualFold(value, zeroHash) {
		d.refuse()
	}
	return strings.ToLower(value)
}
func (d *nftReceiptDecoder) address(raw []byte) string {
	value := d.text(raw)
	if !nftReceiptAddress.MatchString(value) || strings.EqualFold(value, zeroAddress) {
		d.refuse()
	}
	return strings.ToLower(value)
}

func canonicalNFTReceiptOrigin(value string) bool {
	if len(value) == 0 || len(value) > 2048 || !utf8.ValidString(value) {
		return false
	}
	for _, c := range value {
		if c > 127 || c <= 32 {
			return false
		}
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		u.Path != "" || u.RawPath != "" || u.Host == "" || strings.HasSuffix(u.Host, ":") || u.String() != value ||
		u.Host != strings.ToLower(u.Host) || value != u.Scheme+"://"+u.Host {
		return false
	}
	host := u.Hostname()
	if u.Scheme != "https" && !(u.Scheme == "http" &&
		(host == "localhost" || host == "127.0.0.1" || host == "::1")) {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != port ||
			u.Scheme == "https" && n == 443 || u.Scheme == "http" && n == 80 {
			return false
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String() == host
	}
	if strings.ContainsAny(host, ":[]%\\^|") {
		return false
	}
	last := strings.TrimSuffix(host, ".")
	if dot := strings.LastIndex(last, "."); dot >= 0 {
		last = last[dot+1:]
	}
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return false
	}
	if strings.HasPrefix(last, "0x") {
		if len(last) > 2 && strings.Trim(last[2:], "0123456789abcdef") == "" {
			return false
		}
	}
	return host != ""
}
func validNFTReceiptApprovalBinding(binding NFTReceiptApprovalBinding) bool {
	return nftReceiptTenant.MatchString(binding.Tenant) && canonicalNFTReceiptOrigin(binding.Origin) &&
		nftTaskIdentifier.MatchString(binding.TaskID) && nftReceiptAddress.MatchString(binding.Actor) &&
		!strings.EqualFold(binding.Actor, zeroAddress) && nftReceiptAddress.MatchString(binding.Escrow) &&
		!strings.EqualFold(binding.Escrow, zeroAddress) && nftReceiptHash.MatchString(binding.RuntimeCodeHash) &&
		!strings.EqualFold(binding.RuntimeCodeHash, zeroHash)
}
func nftReceiptContentDigest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", errNFTReceiptContent
	}
	digest, err := nftTaskWireDigest(raw)
	if err != nil {
		return "", errNFTReceiptContent
	}
	return "0x" + digest, nil
}

// CompareNFTReceiptApprovalContent consumes no capability and grants no access.
// It compares the existing PR225 content contracts after actual authentication.
// EIP-712 segment association, checksum/input semantics, installed source facts
// and source-authorized workflow checks remain the trusted authority's job.
func CompareNFTReceiptApprovalContent(raw []byte, binding NFTReceiptApprovalBinding, expected NFTTaskPrincipal, claims NFTReceiptCapabilityClaims) (NFTReceiptContentComparison, error) {
	empty := NFTReceiptContentComparison{}
	present, err := claims.receiptClaimsPresent()
	if err != nil || !present || len(raw) == 0 || len(raw) > 65536 || !utf8.Valid(raw) ||
		!validNFTReceiptApprovalBinding(binding) {
		return empty, errNFTReceiptContent
	}
	d := &nftReceiptDecoder{}
	p := d.object(raw, []string{"id", "operationId", "chainId", "taskPrincipal", "kind", "request", "wholeReceipt"}, nil)
	nativeID, operationID := d.text(p["id"]), d.text(p["operationId"])
	kind := d.text(p["kind"])
	chainID := d.number(p["chainId"], true)
	principalFields := d.object(p["taskPrincipal"], []string{"kind", "taskId", "taskDigest", "executorDigest", "grantReference", "grantPolicyVersion", "operationId"}, nil)
	var principal NFTTaskPrincipal
	if d.err != nil || decodeNFTTaskPrincipal(p["taskPrincipal"], &principal) != nil ||
		principal != expected || principal.Kind != "task" || principal.TaskID != binding.TaskID ||
		principal.TaskDigest == zeroHash || principal.ExecutorDigest == zeroHash {
		return empty, errNFTReceiptContent
	}
	d.uintString(principalFields["grantPolicyVersion"], 256, true)
	if d.err != nil {
		return empty, errNFTReceiptContent
	}
	// Principal fields are ASCII under the existing principal contract, so the
	// kernel's sorted JSON SHA256 and native canonical encoder are identical.
	delete(principalFields, "kind")
	rawPrincipal, _ := json.Marshal(principalFields)
	principalDigest, err := nftTaskWireDigest(rawPrincipal)
	if err != nil || !nftReceiptNativeID.MatchString(nativeID) || operationID != "native_"+principalDigest ||
		kind != "transaction" || chainID != 31337 && chainID != 560048 {
		return empty, errNFTReceiptContent
	}
	request := d.object(p["request"], []string{"account"}, nil)
	account := d.address(request["account"])
	r := d.object(p["wholeReceipt"], []string{"schemaVersion", "phase", "segmentId", "domain", "sale", "correspondence"}, []string{"kitRegistration"})
	schemaVersion, phase := d.number(r["schemaVersion"], true), d.text(r["phase"])
	segmentID := d.hash(r["segmentId"], false)
	domain := d.object(r["domain"], []string{"chainId", "verifyingContract"}, nil)
	domainChain := d.number(domain["chainId"], true)
	escrow := d.address(domain["verifyingContract"])
	sale := d.object(r["sale"], []string{"seller", "collection", "tokenId", "paymentToken", "price", "buyer", "salt", "startsAt", "endsAt", "epoch"}, nil)
	seller, collection, token, buyer := d.address(sale["seller"]), d.address(sale["collection"]), d.address(sale["paymentToken"]), d.address(sale["buyer"])
	start, end := d.number(sale["startsAt"], false), d.number(sale["endsAt"], true)
	canonicalSale := map[string]any{
		"seller": seller, "collection": collection, "paymentToken": token, "buyer": buyer,
		"tokenId":  d.uintString(sale["tokenId"], 256, false),
		"price":    d.uintString(sale["price"], 256, true),
		"salt":     d.uintString(sale["salt"], 256, false),
		"epoch":    d.uintString(sale["epoch"], 256, false),
		"startsAt": start, "endsAt": end,
	}
	keys := []string{"settlementId", "assetRecordHash", "oracleSourceId", "requestHash", "executionReferenceHash", "previousSegment", "oldCertificateHash", "warehouseReceiptHash"}
	correspondence := d.object(r["correspondence"], keys, nil)
	canonicalCorrespondence := make(map[string]any)
	for _, key := range keys {
		canonicalCorrespondence[key] = d.hash(correspondence[key], key == "previousSegment")
	}
	canonicalReceipt := map[string]any{
		"schemaVersion": schemaVersion, "phase": phase, "segmentId": segmentID,
		"domain": map[string]any{"chainId": domainChain, "verifyingContract": escrow},
		"sale":   canonicalSale, "correspondence": canonicalCorrespondence,
	}
	kit, hasKit := r["kitRegistration"]
	if phase == "registered" {
		if !hasKit {
			return empty, errNFTReceiptContent
		}
		k := d.object(kit, []string{"version", "proofHash"}, nil)
		version, proof := d.uintString(k["version"], 64, true), d.hash(k["proofHash"], false)
		n, ok := new(big.Int).SetString(version, 10)
		if !ok || n.Cmp(big.NewInt(2)) < 0 {
			return empty, errNFTReceiptContent
		}
		canonicalReceipt["kitRegistration"] = map[string]any{"version": version, "proofHash": proof}
	} else if hasKit {
		return empty, errNFTReceiptContent
	}
	if d.err != nil || schemaVersion != 1 || phase != claims.ReceiptPhase ||
		domainChain != chainID || start >= end || seller == buyer ||
		!strings.EqualFold(account, binding.Actor) || !strings.EqualFold(escrow, binding.Escrow) ||
		phase == "funded" && account != buyer {
		return empty, errNFTReceiptContent
	}
	business := map[string]any{
		"kind": kind, "chainId": chainID,
		"request": map[string]any{"account": account}, "wholeReceipt": canonicalReceipt,
	}
	planDigest, err := nftReceiptContentDigest(map[string]any{"schema": nftReceiptBusinessSchema, "business": business})
	if err != nil || planDigest != claims.ReceiptPlanDigest {
		return empty, errNFTReceiptContent
	}
	journalDigest, err := nftReceiptContentDigest(map[string]any{
		"schema": nftReceiptAssociationSchema,
		"tenant": binding.Tenant, "origin": binding.Origin, "taskId": binding.TaskID,
		"actor": strings.ToLower(binding.Actor), "phase": phase, "escrow": strings.ToLower(binding.Escrow),
		"runtimeCodeHash": strings.ToLower(binding.RuntimeCodeHash), "segmentId": segmentID, "businessDigest": planDigest,
	})
	if err != nil || journalDigest != claims.ReceiptJournalBindingHash {
		return empty, errNFTReceiptContent
	}
	nativeDigest, err := nftTaskWireDigest(raw)
	if err != nil {
		return empty, errNFTReceiptContent
	}
	businessRaw, _ := json.Marshal(business)
	return NFTReceiptContentComparison{
		native: append(json.RawMessage(nil), raw...), business: businessRaw,
		nativeDigest: nativeDigest, operationID: operationID, chainID: chainID, account: account,
		planDigest: planDigest, journalDigest: journalDigest,
	}, nil
}

type verifiedNFTReceiptContext struct {
	binding   NFTReceiptApprovalBinding
	principal NFTTaskPrincipal
	claims    NFTReceiptCapabilityClaims
}

func newVerifiedNFTReceiptContext(binding NFTReceiptApprovalBinding, claims NFTTaskCapability) (*verifiedNFTReceiptContext, error) {
	present, err := claims.receiptClaimsPresent()
	if err != nil || !present || !validNFTReceiptApprovalBinding(binding) ||
		binding.TaskID != claims.Principal.TaskID || !strings.EqualFold(binding.Actor, claims.Wallet) ||
		claims.ChainID != 31337 && claims.ChainID != 560048 {
		return nil, errUserAuthUnavailable
	}
	return &verifiedNFTReceiptContext{binding: binding, principal: claims.Principal, claims: claims.NFTReceiptCapabilityClaims}, nil
}
func (v *verifiedNFTReceiptContext) matches(operation nftOperation) bool {
	if v == nil || operation.OrderHash != "" {
		return false
	}
	content, err := CompareNFTReceiptApprovalContent(operation.Plan, v.binding, v.principal, v.claims)
	if err != nil {
		return false
	}
	return operation.ID == content.operationID && uint64(operation.ChainID) == content.chainID &&
		strings.EqualFold(operation.Wallet, content.account) &&
		operation.RequestHash == content.NativePlanDigest()
}

// Validate the receipt operation envelope without encoding/json's case-insensitive
// field matching or last-duplicate-wins behavior. Get remains the exact ID-only
// request used by the installed Wallet capability registry.
func validNFTReceiptJournalInput(raw []byte, action string) bool {
	if !utf8.Valid(raw) {
		return false
	}
	d := &nftReceiptDecoder{}
	body := d.object(raw, []string{"action", "operation"}, nil)
	if d.text(body["action"]) != action {
		return false
	}
	required := []string{"id"}
	var optional []string
	if action != "get" {
		required = append(required, "wallet", "chainId", "requestHash", "status", "plan")
		optional = []string{"revision", "walletStarted", "transactionHash", "orderHash", "updatedAt"}
	}
	d.object(body["operation"], required, optional)
	return d.err == nil
}
