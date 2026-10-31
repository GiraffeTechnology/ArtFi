package httpapi

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Ephemeral in-memory TEST_ONLY certificates. No installation credentials are
// generated, persisted, configured, or sent outside this local test listener.
func nftSyntheticTLS(t *testing.T) (tls.Certificate, tls.Certificate, *x509.CertPool) {
	server, client, roots, _ := nftSyntheticTLSMaterials(t)
	return server, client, roots
}

func nftSyntheticTLSMaterials(t *testing.T) (tls.Certificate, tls.Certificate, *x509.CertPool, []byte) {
	t.Helper()
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "TEST_ONLY journal CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	issue := func(serial int64, uri string, server bool) tls.Certificate {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		identity, _ := url.Parse(uri)
		leaf := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "TEST_ONLY workload"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, URIs: []*url.URL{identity}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
		if server {
			leaf.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
			leaf.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
		}
		cert, err := x509.CreateCertificate(rand.Reader, leaf, parsed, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		pair, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}))
		if err != nil {
			t.Fatal(err)
		}
		return pair
	}
	return issue(2, "spiffe://test-only/wallet-authority", true), issue(3, "spiffe://test-only/go-journal", false), roots, der
}
func TestNFTTaskHTTPVerifierRealSyntheticMTLSAndSingleConsumption(t *testing.T) {
	serverCert, clientCert, roots := nftSyntheticTLS(t)
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/go-journal"})
	var calls atomic.Int32
	scope := NFTTaskCapabilityScope{PeerID: "spiffe://test-only/wallet", Action: "get", NativeOperationID: "native_test_only_operation", RequestDigest: strings.Repeat("a", 64)}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := peer.AuthenticatePeer(r); err != nil {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path != NFTTaskCapabilityConsumePath || r.Method != "POST" {
			t.Error("unfixed introspection endpoint")
		}
		var input struct {
			NFTTaskCapabilityScope
			Capability string `json:"capability"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.NFTTaskCapabilityScope != scope || input.Capability != strings.Repeat("t", 40) {
			t.Error("scope or capability changed")
			w.WriteHeader(403)
			return
		}
		if calls.Add(1) > 1 {
			w.WriteHeader(409)
			return
		}
		now := time.Now()
		writeJSON(w, 200, NFTTaskCapability{NFTTaskCapabilityScope: scope, Principal: syntheticNFTTaskPrincipal(), Wallet: userAuthTestAddress, ChainID: 1, IssuedAtMs: now.UnixMilli(), ExpiresAtMs: now.Add(time.Second).UnixMilli()})
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	server.StartTLS()
	defer server.Close()
	verifier, err := NewNFTTaskHTTPVerifier(server.URL+NFTTaskCapabilityConsumePath, &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{clientCert}})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := verifier.ConsumeCapability(context.Background(), strings.Repeat("t", 40), scope)
	if err != nil || claims.PeerID != scope.PeerID {
		t.Fatalf("authenticated transport %v", err)
	}
	if _, err := verifier.ConsumeCapability(context.Background(), strings.Repeat("t", 40), scope); err != errUserForbidden {
		t.Fatalf("replay response not denied %v", err)
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected automatic transport retry")
	}
}
func TestNFTTaskHTTPVerifierRejectsUnsafeCompositionAndRedirect(t *testing.T) {
	_, client, roots := nftSyntheticTLS(t)
	for _, endpoint := range []string{"http://authority.invalid" + NFTTaskCapabilityConsumePath, "https://authority.invalid/wrong", "https://user:secret@authority.invalid" + NFTTaskCapabilityConsumePath, "https://authority.invalid" + NFTTaskCapabilityConsumePath + "?token=bad"} {
		if _, err := NewNFTTaskHTTPVerifier(endpoint, &tls.Config{Certificates: []tls.Certificate{client}, RootCAs: roots}); err == nil {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	for _, config := range []*tls.Config{nil, {}, {Certificates: []tls.Certificate{client}, InsecureSkipVerify: true}} {
		if _, err := NewNFTTaskHTTPVerifier("https://authority.invalid"+NFTTaskCapabilityConsumePath, config); err == nil {
			t.Fatal("unsafe TLS accepted")
		}
	}
	serverCert, client, roots := nftSyntheticTLS(t)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://external.invalid/", 307) }))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	server.StartTLS()
	defer server.Close()
	verifier, _ := NewNFTTaskHTTPVerifier(server.URL+NFTTaskCapabilityConsumePath, &tls.Config{Certificates: []tls.Certificate{client}, RootCAs: roots})
	if _, err := verifier.ConsumeCapability(context.Background(), strings.Repeat("t", 40), NFTTaskCapabilityScope{}); err != errUserAuthUnavailable {
		t.Fatal("redirect not rejected")
	}
}

type nilBootstrapReceiptAuthority struct{}

func (*nilBootstrapReceiptAuthority) ResolveReceipt(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
	return NFTReceiptApprovalBinding{}, errors.New("not configured")
}

func TestNFTTaskReceiptBootstrapRejectsNilBeforeConfigurationReads(t *testing.T) {
	for _, authority := range []NFTReceiptAuthority{nil, (*nilBootstrapReceiptAuthority)(nil), syntheticNFTReceiptAuthority(nil)} {
		called := false
		server, db, err := NewNFTTaskJournalServerWithReceiptAuthorityFromEnvironment(func(string) string {
			called = true
			return ""
		}, authority)
		if err == nil || server != nil || db != nil || called {
			t.Fatal("nil receipt authority reached configuration or created a server")
		}
	}
}

func TestNFTTaskReceiptBootstrapPreservesExplicitEnablement(t *testing.T) {
	var resolutions atomic.Int32
	authority := syntheticNFTReceiptAuthority(func(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
		resolutions.Add(1)
		return NFTReceiptApprovalBinding{}, errors.New("source unavailable")
	})
	for _, getenv := range []func(string) string{nil, func(string) string { return "" }} {
		server, db, err := NewNFTTaskJournalServerWithReceiptAuthorityFromEnvironment(getenv, authority)
		if err == nil || server != nil || db != nil || resolutions.Load() != 0 {
			t.Fatal("authority bypassed disabled journal or resolved before a request")
		}
	}
}

func TestMySQLNFTTaskReceiptBootstrapAuthorityAndRealMTLS(t *testing.T) {
	// Real isolated test MySQL and TLS transport, synthetic source/capability only.
	// This does not install an identity or establish live source/chain authority.
	walletAuthIntegrationFixture(t)
	for _, explicit := range []bool{false, true} {
		name := "environment-default"
		if explicit {
			name = "explicit-receipt-authority"
		}
		t.Run(name, func(t *testing.T) {
			serverCert, clientCert, roots, caDER := nftSyntheticTLSMaterials(t)
			dir := t.TempDir()
			write := func(name string, data []byte) string {
				path := filepath.Join(dir, name)
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
				return path
			}
			pair := func(name string, certificate tls.Certificate) (string, string) {
				key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
				if err != nil {
					t.Fatal(err)
				}
				return write(name+".crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]})),
					write(name+".key", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
			}
			serverFile, serverKey := pair("server", serverCert)
			clientFile, clientKey := pair("client", clientCert)
			caFile := write("ca.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
			peer, err := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/go-journal"})
			if err != nil {
				t.Fatal(err)
			}
			vector := syntheticNFTReceiptPaid(t)
			var consumes, resolutions atomic.Int32
			authorityServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := peer.AuthenticatePeer(r); err != nil {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				var input struct {
					NFTTaskCapabilityScope
					Capability string `json:"capability"`
				}
				if r.URL.Path != NFTTaskCapabilityConsumePath || r.Method != http.MethodPost ||
					json.NewDecoder(r.Body).Decode(&input) != nil || len(input.Capability) < 32 {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if consumes.Add(1) > 1 {
					w.WriteHeader(http.StatusConflict)
					return
				}
				claims := syntheticNFTReceiptClaims(vector, time.Now())
				claims.NFTTaskCapabilityScope = input.NFTTaskCapabilityScope
				writeJSON(w, http.StatusOK, claims)
			}))
			authorityServer.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert},
				ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
			authorityServer.StartTLS()
			defer authorityServer.Close()
			config := map[string]string{
				"ARTFI_TASK_JOURNAL_ENABLED":             "true",
				"ARTFI_TASK_JOURNAL_ADDR":                "127.0.0.1:0",
				"ARTFI_TASK_JOURNAL_MYSQL_DSN":           os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN"),
				"ARTFI_TASK_JOURNAL_TLS_CERT_FILE":       serverFile,
				"ARTFI_TASK_JOURNAL_TLS_KEY_FILE":        serverKey,
				"ARTFI_TASK_JOURNAL_CLIENT_CA_FILE":      caFile,
				"ARTFI_TASK_JOURNAL_PEER_URI":            "spiffe://test-only/go-journal",
				"ARTFI_TASK_JOURNAL_CAPABILITY_URL":      authorityServer.URL + NFTTaskCapabilityConsumePath,
				"ARTFI_TASK_JOURNAL_AUTHORITY_CA_FILE":   caFile,
				"ARTFI_TASK_JOURNAL_AUTHORITY_CERT_FILE": clientFile,
				"ARTFI_TASK_JOURNAL_AUTHORITY_KEY_FILE":  clientKey,
			}
			getenv := func(key string) string { return config[key] }
			authority := syntheticNFTReceiptAuthority(func(ctx context.Context, claims NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
				resolutions.Add(1)
				deadline, ok := ctx.Deadline()
				if !ok || deadline.UnixMilli() != claims.ExpiresAtMs {
					t.Error("receipt authority lost capability deadline")
				}
				return NFTReceiptApprovalBinding{}, errors.New("TEST_ONLY source unavailable")
			})
			var configured *http.Server
			var closeDB func() error
			if explicit {
				server, db, err := NewNFTTaskJournalServerWithReceiptAuthorityFromEnvironment(getenv, authority)
				if err != nil {
					t.Fatal(err)
				}
				configured, closeDB = server, db.Close
			} else {
				server, db, err := NewNFTTaskJournalServerFromEnvironment(getenv)
				if err != nil {
					t.Fatal(err)
				}
				configured, closeDB = server, db.Close
			}
			defer closeDB()
			journal := httptest.NewUnstartedServer(configured.Handler)
			journal.TLS = configured.TLSConfig
			journal.StartTLS()
			defer journal.Close()
			transport := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{
				RootCAs: roots, Certificates: []tls.Certificate{clientCert}, MinVersion: tls.VersionTLS13}}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
			request := func() *http.Response {
				original := syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, vector))
				body, err := io.ReadAll(original.Body)
				_ = original.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				r, err := http.NewRequest(http.MethodPost, journal.URL+NFTTaskJournalPath, bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				r.Header = original.Header.Clone()
				response, err := client.Do(r)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				return response
			}
			first := request()
			expected := int32(0)
			if explicit {
				expected = 1
			}
			if first.StatusCode != http.StatusServiceUnavailable || consumes.Load() != 1 || resolutions.Load() != expected ||
				first.TLS == nil || first.TLS.Version != tls.VersionTLS13 || len(first.TLS.VerifiedChains) == 0 {
				t.Fatalf("bootstrap authority/transport mismatch: status=%d consumes=%d resolutions=%d",
					first.StatusCode, consumes.Load(), resolutions.Load())
			}
			second := request()
			if second.StatusCode != http.StatusForbidden || consumes.Load() != 2 || resolutions.Load() != expected {
				t.Fatal("bootstrap repeated source resolution for a consumed capability")
			}
		})
	}
}
