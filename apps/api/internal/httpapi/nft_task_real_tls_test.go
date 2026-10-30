package httpapi

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const realTLSTestPeer = "spiffe://test-only/artfi-wallet"

func realTLSRegistryState(registry *syntheticNFTCapabilityRegistry) (int, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return registry.calls, registry.used
}

// These keys and certificates are ephemeral, in-memory test data. They never
// access an installed identity, wallet key, external authority or blockchain.
type realTLSFixtureCA struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pool        *x509.CertPool
}

func newRealTLSFixtureCA(t *testing.T) realTLSFixtureCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "TEST_ONLY in-memory CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	return realTLSFixtureCA{certificate, key, pool}
}
func (ca realTLSFixtureCA) client(t *testing.T, identity string, expired, wrongUsage bool) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: realTLSTestPeer}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(30 * time.Minute), BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	if identity != "" {
		uri, err := url.Parse(identity)
		if err != nil {
			t.Fatal(err)
		}
		template.URIs = []*url.URL{uri}
	}
	if expired {
		template.NotBefore = now.Add(-30 * time.Minute)
		template.NotAfter = now.Add(-time.Minute)
	}
	if wrongUsage {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der, ca.certificate.Raw}, PrivateKey: key}
}
func realTLSJournalServer(t *testing.T, ca realTLSFixtureCA) (*httptest.Server, *syntheticNFTCapabilityRegistry) {
	t.Helper()
	now := time.Now()
	peer, err := NewNFTMTLSPeerAuthenticator([]string{realTLSTestPeer})
	if err != nil {
		t.Fatal(err)
	}
	registry := syntheticNFTRegistry(now)
	handler := newNFTTaskJournalHandler(&nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }}, peer, registry, func() time.Time { return now }, true)
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: ca.pool}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, registry
}
func realTLSJournalRequest(t *testing.T, server *httptest.Server, certificate *tls.Certificate, maximumVersion uint16) (*http.Response, error) {
	t.Helper()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.Proxy = nil
	transport.TLSClientConfig.MinVersion = tls.VersionTLS12
	transport.TLSClientConfig.MaxVersion = maximumVersion
	if certificate != nil {
		transport.TLSClientConfig.Certificates = []tls.Certificate{*certificate}
	}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	body, err := json.Marshal(nftTaskInput{Action: "get", Operation: nftOperation{ID: "native_test_only_operation"}})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+NFTTaskJournalPath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("t", 40))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Client-URI", realTLSTestPeer)
	return client.Do(request)
}
func TestNFTTaskJournalRealTLSVerifiedPeerAndOneUse(t *testing.T) {
	ca := newRealTLSFixtureCA(t)
	server, registry := realTLSJournalServer(t, ca)
	certificate := ca.client(t, realTLSTestPeer, false, false)
	response, err := realTLSJournalRequest(t, server, &certificate, tls.VersionTLS13)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.TLS == nil || !response.TLS.HandshakeComplete || response.TLS.Version != tls.VersionTLS13 || len(response.TLS.VerifiedChains) == 0 {
		t.Fatal("a verified real TLS1.3 server connection was not established")
	}
	calls, used := realTLSRegistryState(registry)
	if response.StatusCode != http.StatusServiceUnavailable || calls != 1 || !used {
		t.Fatalf("verified peer did not reach the one-use registry then unavailable SQL: status=%d registryCalls=%d", response.StatusCode, calls)
	}
	replay, err := realTLSJournalRequest(t, server, &certificate, tls.VersionTLS13)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, replay.Body)
	_ = replay.Body.Close()
	calls, _ = realTLSRegistryState(registry)
	if replay.StatusCode != http.StatusForbidden || calls != 2 {
		t.Fatal("consumed authority was accepted again over a second real TLS connection")
	}
}
func TestNFTTaskJournalRealTLSRejectsUnverifiedIdentity(t *testing.T) {
	for _, name := range []string{"missing-client-certificate", "foreign-uri-san", "missing-uri-san-common-name-is-insufficient", "expired-client-certificate", "untrusted-client-ca", "wrong-client-key-usage", "tls12"} {
		t.Run(name, func(t *testing.T) {
			ca := newRealTLSFixtureCA(t)
			server, registry := realTLSJournalServer(t, ca)
			var certificate *tls.Certificate
			maximum := uint16(tls.VersionTLS13)
			identity := realTLSTestPeer
			expired, wrongUsage := false, false
			switch name {
			case "foreign-uri-san":
				identity = "spiffe://test-only/foreign"
			case "missing-uri-san-common-name-is-insufficient":
				identity = ""
			case "expired-client-certificate":
				expired = true
			case "wrong-client-key-usage":
				wrongUsage = true
			case "tls12":
				maximum = tls.VersionTLS12
			}
			if name != "missing-client-certificate" {
				issuer := ca
				if name == "untrusted-client-ca" {
					issuer = newRealTLSFixtureCA(t)
				}
				value := issuer.client(t, identity, expired, wrongUsage)
				certificate = &value
			}
			response, err := realTLSJournalRequest(t, server, certificate, maximum)
			if name == "foreign-uri-san" || name == "missing-uri-san-common-name-is-insufficient" {
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				if response.StatusCode != http.StatusUnauthorized {
					t.Fatalf("unapproved URI SAN authenticated: %d", response.StatusCode)
				}
			} else {
				if response != nil {
					_, _ = io.Copy(io.Discard, response.Body)
					_ = response.Body.Close()
				}
				if err == nil {
					t.Fatal("TLS accepted a missing, invalid or old-protocol client identity")
				}
			}
			calls, used := realTLSRegistryState(registry)
			if calls != 0 || used {
				t.Fatal("unverified peer reached the registry despite forged identity header")
			}
		})
	}
}
