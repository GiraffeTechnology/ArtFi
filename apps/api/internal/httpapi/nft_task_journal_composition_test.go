package httpapi

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Ephemeral in-memory TEST_ONLY certificates. No installation credentials are
// generated, persisted, configured, or sent outside this local test listener.
func nftSyntheticTLS(t *testing.T) (tls.Certificate, tls.Certificate, *x509.CertPool) {
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
	return issue(2, "spiffe://test-only/wallet-authority", true), issue(3, "spiffe://test-only/go-journal", false), roots
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
