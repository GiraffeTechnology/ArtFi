package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const NFTTaskCapabilityConsumePath = "/internal/v1/task-journal-capabilities/consume"

// The real peer identity comes from Go's verified TLS client-certificate chain.
// Forwarded headers, bearer bridge tokens, unverified PeerCertificates, and a
// caller-supplied principal never establish a peer. Pin exact URI SANs.
type NFTMTLSPeerAuthenticator struct{ allowed map[string]bool }

func NewNFTMTLSPeerAuthenticator(allowedURIs []string) (*NFTMTLSPeerAuthenticator, error) {
	allowed := make(map[string]bool, len(allowedURIs))
	for _, value := range allowedURIs {
		uri, err := url.Parse(value)
		if err != nil || uri.Scheme == "" || uri.Host == "" || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" {
			return nil, errUserAuthUnavailable
		}
		allowed[value] = true
	}
	if len(allowed) == 0 {
		return nil, errUserAuthUnavailable
	}
	return &NFTMTLSPeerAuthenticator{allowed: allowed}, nil
}
func (a *NFTMTLSPeerAuthenticator) AuthenticatePeer(request *http.Request) (string, error) {
	if a == nil || request.TLS == nil || !request.TLS.HandshakeComplete || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.VerifiedChains[0]) == 0 {
		return "", errUserUnauthorized
	}
	leaf := request.TLS.VerifiedChains[0][0]
	for _, uri := range leaf.URIs {
		if a.allowed[uri.String()] {
			return uri.String(), nil
		}
	}
	return "", errUserUnauthorized
}

type nftTaskHTTPVerifier struct {
	endpoint string
	client   *http.Client
}

// NewNFTTaskHTTPVerifier pins a fixed HTTPS destination and an already installed
// mTLS identity. It generates no certificate, credential, or access grant.
func NewNFTTaskHTTPVerifier(endpoint string, clientTLS *tls.Config) (NFTTaskCapabilityVerifier, error) {
	target, err := url.Parse(endpoint)
	if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" || target.Path != NFTTaskCapabilityConsumePath || clientTLS == nil || clientTLS.InsecureSkipVerify || (len(clientTLS.Certificates) == 0 && clientTLS.GetClientCertificate == nil) {
		return nil, errUserAuthUnavailable
	}
	pinned := clientTLS.Clone()
	pinned.MinVersion = tls.VersionTLS13
	transport := &http.Transport{TLSClientConfig: pinned, Proxy: nil, DisableCompression: true, ForceAttemptHTTP2: true, MaxIdleConnsPerHost: 4, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second}
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &nftTaskHTTPVerifier{endpoint: target.String(), client: client}, nil
}
func (v *nftTaskHTTPVerifier) ConsumeCapability(ctx context.Context, capability string, scope NFTTaskCapabilityScope) (NFTTaskCapability, error) {
	var empty NFTTaskCapability
	body, err := json.Marshal(struct {
		NFTTaskCapabilityScope
		Capability string `json:"capability"`
	}{scope, capability})
	if err != nil {
		return empty, errUserAuthUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, v.endpoint, bytes.NewReader(body))
	if err != nil {
		return empty, errUserAuthUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := v.client.Do(request)
	if err != nil {
		return empty, errUserAuthUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		if response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 409 {
			return empty, errUserForbidden
		}
		return empty, errUserAuthUnavailable
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(payload) > 16384 {
		return empty, errUserAuthUnavailable
	}
	var result NFTTaskCapability
	if strictNFTJSON(payload, &result) != nil {
		return empty, errUserAuthUnavailable
	}
	return result, nil
}

// NewNFTTaskJournalServerFromEnvironment is the concrete opt-in startup wiring
// used by cmd/task-journal. It is separate from the public API listener. All
// settings below are installation inputs; no defaults create persistent access.
func NewNFTTaskJournalServerFromEnvironment(getenv func(string) string) (*http.Server, *sql.DB, error) {
	unavailable := errors.New("internal NFT task journal is unavailable: explicit configuration is required")
	if getenv == nil || getenv("ARTFI_TASK_JOURNAL_ENABLED") != "true" {
		return nil, nil, unavailable
	}
	required := []string{"ARTFI_TASK_JOURNAL_ADDR", "ARTFI_TASK_JOURNAL_MYSQL_DSN", "ARTFI_TASK_JOURNAL_TLS_CERT_FILE", "ARTFI_TASK_JOURNAL_TLS_KEY_FILE", "ARTFI_TASK_JOURNAL_CLIENT_CA_FILE", "ARTFI_TASK_JOURNAL_PEER_URI", "ARTFI_TASK_JOURNAL_CAPABILITY_URL", "ARTFI_TASK_JOURNAL_AUTHORITY_CA_FILE", "ARTFI_TASK_JOURNAL_AUTHORITY_CERT_FILE", "ARTFI_TASK_JOURNAL_AUTHORITY_KEY_FILE"}
	values := make(map[string]string, len(required))
	for _, key := range required {
		values[key] = strings.TrimSpace(getenv(key))
		if values[key] == "" {
			return nil, nil, unavailable
		}
	}
	if _, _, err := net.SplitHostPort(values["ARTFI_TASK_JOURNAL_ADDR"]); err != nil {
		return nil, nil, unavailable
	}
	loadCA := func(path string) (*x509.CertPool, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, unavailable
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(data) {
			return nil, unavailable
		}
		return pool, nil
	}
	serverCertificate, err := tls.LoadX509KeyPair(values["ARTFI_TASK_JOURNAL_TLS_CERT_FILE"], values["ARTFI_TASK_JOURNAL_TLS_KEY_FILE"])
	if err != nil {
		return nil, nil, unavailable
	}
	clientCA, err := loadCA(values["ARTFI_TASK_JOURNAL_CLIENT_CA_FILE"])
	if err != nil {
		return nil, nil, unavailable
	}
	authorityCA, err := loadCA(values["ARTFI_TASK_JOURNAL_AUTHORITY_CA_FILE"])
	if err != nil {
		return nil, nil, unavailable
	}
	authorityCertificate, err := tls.LoadX509KeyPair(values["ARTFI_TASK_JOURNAL_AUTHORITY_CERT_FILE"], values["ARTFI_TASK_JOURNAL_AUTHORITY_KEY_FILE"])
	if err != nil {
		return nil, nil, unavailable
	}
	peer, err := NewNFTMTLSPeerAuthenticator([]string{values["ARTFI_TASK_JOURNAL_PEER_URI"]})
	if err != nil {
		return nil, nil, unavailable
	}
	verifier, err := NewNFTTaskHTTPVerifier(values["ARTFI_TASK_JOURNAL_CAPABILITY_URL"], &tls.Config{RootCAs: authorityCA, Certificates: []tls.Certificate{authorityCertificate}})
	if err != nil {
		return nil, nil, unavailable
	}
	db, err := sql.Open("mysql", values["ARTFI_TASK_JOURNAL_MYSQL_DSN"])
	if err != nil {
		return nil, nil, unavailable
	}
	options, err := persistencePoolOptionsFromEnv(getenv)
	if err != nil {
		_ = db.Close()
		return nil, nil, unavailable
	}
	options.apply(db)
	ctx, cancel := context.WithTimeout(context.Background(), options.connectTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, nil, unavailable
	}
	// The existing table is the only journal. Task identity is retained inside the
	// immutable unsigned plan; session rows need no rewrite or migration.
	if _, err := db.ExecContext(ctx, "SELECT operation_id FROM nft_operations LIMIT 0"); err != nil {
		_ = db.Close()
		return nil, nil, unavailable
	}
	handler := NewNFTTaskJournalHandler(NFTTaskJournalConfig{DB: db, PeerAuthenticator: peer, CapabilityVerifier: verifier})
	server := &http.Server{Addr: values["ARTFI_TASK_JOURNAL_ADDR"], Handler: handler, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: clientCA, Certificates: []tls.Certificate{serverCertificate}}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	return server, db, nil
}
