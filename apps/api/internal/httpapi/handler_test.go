package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type snapshotDeadlineRecorder struct {
	*httptest.ResponseRecorder
	readDeadline  time.Time
	writeDeadline time.Time
	readSet       bool
	writeSet      bool
	deadlinePairs []time.Time
	writeCalls    int
	failWriteAt   int
}

func (recorder *snapshotDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	recorder.readDeadline = deadline
	recorder.readSet = true
	return nil
}

func (recorder *snapshotDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	recorder.writeCalls++
	if recorder.writeCalls == recorder.failWriteAt {
		return errors.New("injected write-deadline failure")
	}
	recorder.writeDeadline = deadline
	recorder.writeSet = true
	recorder.deadlinePairs = append(recorder.deadlinePairs, deadline)
	return nil
}

type snapshotDeadlineDBState struct {
	execs        int
	commits      int
	rollbacks    int
	beforeCommit func()
}

type snapshotDeadlineDriver struct {
	state *snapshotDeadlineDBState
}

func (databaseDriver snapshotDeadlineDriver) Open(string) (driver.Conn, error) {
	return &snapshotDeadlineConn{state: databaseDriver.state}, nil
}

type snapshotDeadlineConn struct {
	state *snapshotDeadlineDBState
}

func (connection *snapshotDeadlineConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (connection *snapshotDeadlineConn) Close() error {
	return nil
}

func (connection *snapshotDeadlineConn) Begin() (driver.Tx, error) {
	return connection.BeginTx(context.Background(), driver.TxOptions{})
}

func (connection *snapshotDeadlineConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &snapshotDeadlineTx{state: connection.state}, nil
}

func (connection *snapshotDeadlineConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	connection.state.execs++
	return driver.RowsAffected(1), nil
}

type snapshotDeadlineTx struct {
	state *snapshotDeadlineDBState
}

func (transaction *snapshotDeadlineTx) Commit() error {
	if transaction.state.beforeCommit != nil {
		transaction.state.beforeCommit()
	}
	transaction.state.commits++
	return nil
}

func (transaction *snapshotDeadlineTx) Rollback() error {
	transaction.state.rollbacks++
	return nil
}

func openSnapshotDeadlineDB(t *testing.T, name string, state *snapshotDeadlineDBState) *sql.DB {
	t.Helper()
	sql.Register(name, snapshotDeadlineDriver{state: state})
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func TestMarketSnapshotRefreshesIdleDeadlinesWithProgress(t *testing.T) {
	recorder := &snapshotDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	now := time.Date(2026, time.September, 20, 0, 0, 0, 0, time.UTC)
	reader, err := newMarketSnapshotProgressReader(
		recorder,
		strings.NewReader("{\"schemaVersion\":1}\n"),
		func() time.Time { return now },
	)
	if err != nil {
		t.Fatal(err)
	}
	wantInitial := now.Add(marketSnapshotIdleTimeout)
	if recorder.readDeadline != wantInitial || recorder.writeDeadline != wantInitial {
		t.Fatalf("initial idle deadline: read=%s write=%s want=%s", recorder.readDeadline, recorder.writeDeadline, wantInitial)
	}
	now = now.Add(30 * time.Minute)
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatal(err)
	}
	wantProgress := now.Add(marketSnapshotIdleTimeout)
	if recorder.readDeadline != wantProgress || recorder.writeDeadline != wantProgress {
		t.Fatalf("progress idle deadline: read=%s write=%s want=%s", recorder.readDeadline, recorder.writeDeadline, wantProgress)
	}
	if recorder.readDeadline.IsZero() || recorder.writeDeadline.IsZero() {
		t.Fatal("snapshot progress disabled the idle deadline")
	}
}

func TestMarketSnapshotKeepsOrdinaryDeadlinesUntilRequestIsAuthorized(t *testing.T) {
	db, err := sql.Open("mysql", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("external-market-indexer-key"))
	for _, test := range []struct {
		name        string
		indexerKey  string
		contentType string
		wantStatus  int
	}{
		{name: "unauthorized", indexerKey: "wrong-key", contentType: "application/x-ndjson", wantStatus: http.StatusUnauthorized},
		{name: "wrong media type", indexerKey: "external-market-indexer-key", contentType: "application/json", wantStatus: http.StatusUnsupportedMediaType},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := &snapshotDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			request := httptest.NewRequest(http.MethodPost, "/v1/indexer/market-snapshots", strings.NewReader(""))
			request.Header.Set("X-Indexer-Key", test.indexerKey)
			request.Header.Set("Content-Type", test.contentType)
			newHandler(service).ServeHTTP(recorder, request)
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d, want %d", recorder.Code, test.wantStatus)
			}
			if recorder.readSet || recorder.writeSet {
				t.Fatal("unaccepted snapshot request cleared ordinary server deadlines")
			}
		})
	}
}

func TestMarketSnapshotRefreshesDeadlinesAcrossBufferedProcessingAndCommit(t *testing.T) {
	state := &snapshotDeadlineDBState{}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = openSnapshotDeadlineDB(t, "snapshot-deadline-lifecycle", state)
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("external-market-indexer-key"))
	now := time.Date(2026, time.September, 20, 0, 0, 0, 0, time.UTC)
	service.now = func() time.Time {
		current := now
		now = now.Add(time.Second)
		return current
	}
	recorder := &snapshotDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	state.beforeCommit = func() {
		if got := len(recorder.deadlinePairs); got != 6 {
			t.Fatalf("deadline refresh pairs before commit=%d, want 6", got)
		}
	}
	requestBody := strings.Join([]string{
		`{"schemaVersion":"1","source":"opensea","eventType":"item_metadata_updated","eventFamily":"metadata","entityKey":"ethereum:collection:1","version":1,"chain":"ethereum","eventTimestamp":"2026-09-20T00:00:00Z","payload":{"name":"artwork"}}`,
		" ",
		"",
	}, "\n")
	request := httptest.NewRequest(http.MethodPost, "/v1/indexer/market-snapshots", strings.NewReader(requestBody))
	request.Header.Set("X-Indexer-Key", "external-market-indexer-key")
	request.Header.Set("Content-Type", "application/x-ndjson")
	newHandler(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if state.execs != 1 || state.commits != 1 || state.rollbacks != 0 {
		t.Fatalf("transaction lifecycle: execs=%d commits=%d rollbacks=%d", state.execs, state.commits, state.rollbacks)
	}
	if got := len(recorder.deadlinePairs); got != 7 {
		t.Fatalf("deadline refresh pairs=%d, want 7", got)
	}
	for index := 1; index < len(recorder.deadlinePairs); index++ {
		if !recorder.deadlinePairs[index].After(recorder.deadlinePairs[index-1]) {
			t.Fatalf("deadline pair %d did not advance: %s <= %s", index, recorder.deadlinePairs[index], recorder.deadlinePairs[index-1])
		}
	}
	var response struct {
		Status  string `json:"status"`
		Events  int    `json:"events"`
		Created int    `json:"created"`
	}
	decode(t, recorder.ResponseRecorder, &response)
	if response.Status != "mirrored" || response.Events != 1 || response.Created != 1 {
		t.Fatalf("unexpected snapshot response: %+v", response)
	}
}

func TestMarketSnapshotDeadlineFailureRollsBackBeforeCommit(t *testing.T) {
	state := &snapshotDeadlineDBState{}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = openSnapshotDeadlineDB(t, "snapshot-deadline-rollback", state)
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("external-market-indexer-key"))
	recorder := &snapshotDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), failWriteAt: 4}
	requestBody := `{"schemaVersion":"1","source":"opensea","eventType":"item_metadata_updated","eventFamily":"metadata","entityKey":"ethereum:collection:1","version":1,"chain":"ethereum","eventTimestamp":"2026-09-20T00:00:00Z","payload":{"name":"artwork"}}` + "\n"
	request := httptest.NewRequest(http.MethodPost, "/v1/indexer/market-snapshots", strings.NewReader(requestBody))
	request.Header.Set("X-Indexer-Key", "external-market-indexer-key")
	request.Header.Set("Content-Type", "application/x-ndjson")
	newHandler(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if state.execs != 1 || state.commits != 0 || state.rollbacks != 1 {
		t.Fatalf("transaction did not fail closed: execs=%d commits=%d rollbacks=%d", state.execs, state.commits, state.rollbacks)
	}
}

func TestMarketSnapshotDeadlineFailureAfterCommitSuppressesSuccess(t *testing.T) {
	state := &snapshotDeadlineDBState{}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = openSnapshotDeadlineDB(t, "snapshot-deadline-postcommit", state)
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("external-market-indexer-key"))
	recorder := &snapshotDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), failWriteAt: 6}
	requestBody := `{"schemaVersion":"1","source":"opensea","eventType":"item_metadata_updated","eventFamily":"metadata","entityKey":"ethereum:collection:1","version":1,"chain":"ethereum","eventTimestamp":"2026-09-20T00:00:00Z","payload":{"name":"artwork"}}` + "\n"
	request := httptest.NewRequest(http.MethodPost, "/v1/indexer/market-snapshots", strings.NewReader(requestBody))
	request.Header.Set("X-Indexer-Key", "external-market-indexer-key")
	request.Header.Set("Content-Type", "application/x-ndjson")
	newHandler(service).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if state.execs != 1 || state.commits != 1 || state.rollbacks != 0 {
		t.Fatalf("post-commit failure lifecycle: execs=%d commits=%d rollbacks=%d", state.execs, state.commits, state.rollbacks)
	}
	if strings.Contains(recorder.Body.String(), `"status":"mirrored"`) {
		t.Fatalf("post-commit deadline failure exposed a success response: %s", recorder.Body.String())
	}
}

func TestHealth(t *testing.T) {
	recorder := request(t, http.MethodGet, "/healthz")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}
	var response statusResponse
	decode(t, recorder, &response)
	if response.Service != "artfi-api" || response.Status != "ok" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestConfigIsSepoliaReadOnly(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/config")
	var response configResponse
	decode(t, recorder, &response)
	if response.ChainID != 560048 || !response.ReadOnly || response.Network != "hoodi" {
		t.Fatalf("unsafe config: %+v", response)
	}
}

func TestGovernanceConfigFailsClosedWithoutAddresses(t *testing.T) {
	t.Setenv("ARTFI_DAO_ACTIONS_ADDRESS", "")
	t.Setenv("ARTFI_GOVERNOR_ADDRESS", "")
	t.Setenv("ARTFI_GOVERNANCE_TOKEN_ADDRESS", "")
	t.Setenv("ARTFI_RWA_VAULT_ADDRESS", "")
	recorder := request(t, http.MethodGet, "/v1/governance/config")
	var response governanceConfigResponse
	decode(t, recorder, &response)
	if response.Enabled || response.MembershipAuthority != "onchain-rwa-token-snapshot" || response.ProposalThresholdPPM != 100_000 {
		t.Fatalf("unsafe governance config: %+v", response)
	}
	if response.ApprovalPPM["marketMigration"] != 500_000 || response.ApprovalPPM["physicalAction"] != 666_667 || response.ApprovalPPM["forcedBuyout"] != 800_000 {
		t.Fatalf("unexpected governance thresholds: %+v", response.ApprovalPPM)
	}
}

func TestGovernanceConfigEnablesOnlyWithCompleteValidAddresses(t *testing.T) {
	t.Setenv("ARTFI_DAO_ACTIONS_ADDRESS", "0x1111111111111111111111111111111111111111")
	t.Setenv("ARTFI_GOVERNOR_ADDRESS", "0x2222222222222222222222222222222222222222")
	t.Setenv("ARTFI_GOVERNANCE_TOKEN_ADDRESS", "0x3333333333333333333333333333333333333333")
	t.Setenv("ARTFI_RWA_VAULT_ADDRESS", "0x4444444444444444444444444444444444444444")
	recorder := request(t, http.MethodGet, "/v1/governance/config")
	var response governanceConfigResponse
	decode(t, recorder, &response)
	if !response.Enabled || response.ChainID != hoodiChainID {
		t.Fatalf("complete governance config was not enabled: %+v", response)
	}
}

func TestGovernanceProposalIndexFailsClosedWithoutDatabase(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	recorder := httptest.NewRecorder()
	newHandler(service).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/governance/proposals", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected unavailable proposal index, got %d", recorder.Code)
	}
}

func TestAssetLookup(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/blue-hour-archive")
	var response asset
	decode(t, recorder, &response)
	if response.Slug != "blue-hour-archive" || response.ValuationUSD <= 0 {
		t.Fatalf("unexpected asset: %+v", response)
	}
}

func TestMissingAssetUsesProblemJSON(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/missing")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/problem+json; charset=utf-8" {
		t.Fatalf("unexpected content type: %s", got)
	}
	var response problem
	decode(t, recorder, &response)
	if response.RequestID == "" {
		t.Fatal("expected request id")
	}
}

func TestPortfolioRejectsInvalidAddress(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/portfolio/not-an-address")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recorder.Code)
	}
}

func TestAssetSearchFilterAndPagination(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets?q=mina&status=Fractionalized&page=1&pageSize=1")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var response struct {
		Data     []asset `json:"data"`
		Total    int     `json:"total"`
		Page     int     `json:"page"`
		PageSize int     `json:"pageSize"`
	}
	decode(t, recorder, &response)
	if response.Total != 1 || len(response.Data) != 1 || response.Data[0].Slug != "blue-hour-archive" || response.Page != 1 || response.PageSize != 1 {
		t.Fatalf("unexpected filtered page: %+v", response)
	}
}

func TestIndexerFailsClosedWithoutDurableConfiguration(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	recorder := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/indexer/events", map[string]any{}, map[string]string{"X-Indexer-Key": "test"})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected disabled indexer, got %d", recorder.Code)
	}
}

func TestOperatorWritesFailClosedAndUseConstantCredentialBoundary(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.requireOperator = true
	service.operatorEnabled = true
	service.operatorKeyHash = sha256.Sum256([]byte("stage6-operator-test-token"))
	handler := newHandler(service)
	unauthorized := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", map[string]any{}, nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected operator authentication failure, got %d", unauthorized.Code)
	}
	authorized := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", map[string]any{}, map[string]string{
		"Authorization": "Bearer stage6-operator-test-token",
	})
	if authorized.Code == http.StatusUnauthorized {
		t.Fatal("valid operator credential was rejected")
	}
}

func TestOpenSeaDiscoveryVerifiesSupportedChainAndExactNFT(t *testing.T) {
	contract := "0x1111111111111111111111111111111111111111"
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-API-Key") != "discovery-test-key" {
			t.Fatal("OpenSea API key was not sent server-side")
		}
		switch request.URL.Path {
		case "/api/v2/chains":
			writeJSON(writer, http.StatusOK, map[string]any{
				"chains": []map[string]string{{"chain": "hoodi"}},
			})
		case "/api/v2/chain/hoodi/contract/" + contract + "/nfts/42":
			writeJSON(writer, http.StatusOK, map[string]any{
				"nft": map[string]string{
					"identifier":     "42",
					"collection":     "artcch-test",
					"token_standard": "erc721",
				},
			})
		default:
			t.Fatalf("unexpected OpenSea discovery path: %s", request.URL.Path)
		}
	}))
	defer upstream.Close()

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.openseaAPIKey = "discovery-test-key"
	service.openseaAPIBaseURL = upstream.URL
	response := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/rwa/discovery-checks", map[string]string{
		"source": "opensea", "chain": "hoodi", "contractAddress": contract, "tokenId": "42",
	}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("discovery check: status=%d body=%s", response.Code, response.Body.String())
	}
	var result openSeaDiscoveryResponse
	decode(t, response, &result)
	if !result.Discovered || result.Result != "discovered" || result.TokenStandard != "erc721" ||
		result.EvidenceSHA256 == "" || !strings.HasPrefix(result.MarketplaceURL, "https://opensea.io/") {
		t.Fatalf("unsafe discovery result: %+v", result)
	}
}

func TestOpenSeaDiscoveryRecordsUnsupportedChainWithoutNFTClaim(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v2/chains" {
			t.Fatalf("unsupported chain must not trigger NFT lookup: %s", request.URL.Path)
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"chains": []map[string]string{{"chain": "ethereum"}},
		})
	}))
	defer upstream.Close()

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.openseaAPIKey = "discovery-test-key"
	service.openseaAPIBaseURL = upstream.URL
	response := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/rwa/discovery-checks", map[string]string{
		"source":          "opensea",
		"chain":           "hoodi",
		"contractAddress": "0x1111111111111111111111111111111111111111",
		"tokenId":         "42",
	}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("unsupported chain check: status=%d body=%s", response.Code, response.Body.String())
	}
	var result openSeaDiscoveryResponse
	decode(t, response, &result)
	if result.Discovered || result.Result != "unsupported-chain" || result.MarketplaceURL != "" {
		t.Fatalf("unsupported chain was misrepresented: %+v", result)
	}
}

func TestPreflight(t *testing.T) {
	recorder := request(t, http.MethodOptions, "/v1/assets")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", recorder.Code)
	}
	// Unconfigured means no allowed origin, not a default one. The previous default pinned an
	// origin and a port nobody deploys on, and hid a missing ARTFI_WEB_ORIGIN behind it.
	if got := recorder.Header().Values("Access-Control-Allow-Origin"); len(got) != 0 {
		t.Fatalf("an unconfigured origin must send no allow-origin header, got %v", got)
	}
}

func TestPreflightEchoesTheConfiguredOriginWithItsPort(t *testing.T) {
	// The configured origin is used exactly as configured, port included, so a deployment on any
	// port works without the service assuming one.
	t.Setenv("ARTFI_WEB_ORIGIN", "https://web.example:18080")
	recorder := request(t, http.MethodOptions, "/v1/assets")
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://web.example:18080" {
		t.Fatalf("unexpected origin: %s", got)
	}
}

func TestRWAUploadMintAndSubmissionLifecycle(t *testing.T) {
	store := newMemoryObjectStore()
	service := newRWAService(rwaConfig{
		registryAddress: "0x1111111111111111111111111111111111111111",
		publicBaseURL:   "https://assets.artfi.test",
	}, store)
	handler := newHandler(service)
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(image)
	digestHex := hex.EncodeToString(digest[:])
	uploadBody := map[string]any{"fileName": "proof.png", "contentType": "image/png", "sha256": digestHex, "size": len(image)}
	uploadRecorder := jsonRequest(t, handler, http.MethodPost, "/v1/uploads/intents", uploadBody, nil)
	if uploadRecorder.Code != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", uploadRecorder.Code, uploadRecorder.Body.String())
	}
	var upload struct {
		UploadID  string `json:"uploadId"`
		UploadURL string `json:"uploadUrl"`
	}
	decode(t, uploadRecorder, &upload)

	putRequest := httptest.NewRequest(http.MethodPut, upload.UploadURL, bytes.NewReader(image))
	putRequest.Header.Set("Content-Type", "image/png")
	putRequest.Header.Set("Content-SHA256", digestHex)
	putRecorder := httptest.NewRecorder()
	handler.ServeHTTP(putRecorder, putRequest)
	if putRecorder.Code != http.StatusNoContent {
		t.Fatalf("upload object: status=%d body=%s", putRecorder.Code, putRecorder.Body.String())
	}

	mintBody := map[string]any{
		"uploadId":    upload.UploadID,
		"recipient":   "0x2222222222222222222222222222222222222222",
		"name":        "TEST_ONLY sample artwork",
		"artist":      "Example maker",
		"year":        2024,
		"medium":      "Example test pigment",
		"location":    "Example test custody",
		"description": "TESTNET. NO REAL-WORLD VALUE. NO LEGAL EFFECT. Isolated mint-flow record.",
	}
	headers := map[string]string{"Idempotency-Key": "stage2-test-idempotency-key"}
	key, source := syntheticRWASource(t, service)
	preparation := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/metadata-preparations", mintBody, headers)
	if preparation.Code != 200 {
		t.Fatalf("metadata preparation: %d %s", preparation.Code, preparation.Body)
	}
	var draft rwaMetadataPreparation
	decode(t, preparation, &draft)
	evidence := syntheticEvidence(t, service, key, source, draft.ContextHash, "fractional")
	mintBody["evidence"] = evidence
	mintRecorder := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if mintRecorder.Code != http.StatusCreated {
		t.Fatalf("create mint: status=%d body=%s", mintRecorder.Code, mintRecorder.Body.String())
	}
	var intent mintIntent
	decode(t, mintRecorder, &intent)
	if intent.ChainID != hoodiChainID || len(intent.ContractArguments) != 4 || intent.Status != "prepared" {
		t.Fatalf("unsafe intent: %+v", intent)
	}

	replay := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("idempotent replay: status=%d body=%s", replay.Code, replay.Body.String())
	}
	var replayed mintIntent
	decode(t, replay, &replayed)
	if replayed.IntentID != intent.IntentID {
		t.Fatal("idempotent replay created a second intent")
	}

	mintBody["name"] = "Conflicting title"
	conflict := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected idempotency conflict, got %d", conflict.Code)
	}

	txHash := "0x" + strings.Repeat("a", 64)
	submission := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents/"+intent.IntentID+"/submission", map[string]string{"transactionHash": txHash}, nil)
	if submission.Code != http.StatusOK {
		t.Fatalf("record submission: status=%d body=%s", submission.Code, submission.Body.String())
	}
	var submitted mintIntent
	decode(t, submission, &submitted)
	if submitted.Status != "submitted" || submitted.TransactionHash != txHash {
		t.Fatalf("unexpected submission: %+v", submitted)
	}
}

func TestUploadRejectsDigestMismatch(t *testing.T) {
	service := newRWAService(rwaConfig{
		registryAddress: "0x1111111111111111111111111111111111111111",
		publicBaseURL:   "https://assets.artfi.test",
	}, newMemoryObjectStore())
	handler := newHandler(service)
	body := []byte("not-an-image")
	digest := sha256.Sum256(body)
	upload := jsonRequest(t, handler, http.MethodPost, "/v1/uploads/intents", map[string]any{
		"fileName": "proof.png", "contentType": "image/png", "sha256": hex.EncodeToString(digest[:]), "size": len(body),
	}, nil)
	var response struct {
		UploadURL string `json:"uploadUrl"`
	}
	decode(t, upload, &response)

	put := httptest.NewRequest(http.MethodPut, response.UploadURL, bytes.NewReader([]byte("tampered-data")))
	put.Header.Set("Content-Type", "image/png")
	put.Header.Set("Content-SHA256", hex.EncodeToString(digest[:]))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, put)
	if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected rejected upload, got %d", recorder.Code)
	}
}

func TestMySQLGroundedVaultIntentIsIdempotentAndSubmissionBound(t *testing.T) {
	f, service, input, _, _ := catalogIntegrationFixture(t)
	_ = f
	_ = input
	/* service supplied by signed catalog fixture */
	service.config.vaultFactoryAddress = "0x3333333333333333333333333333333333333333"
	handler := newHandler(service)
	body := map[string]any{
		"collectionAddress":     input.Asset.Binding.CollectionAddress,
		"tokenId":               input.Asset.Binding.TokenID,
		"vaultName":             "Material Memory Vault",
		"adminAddress":          "0x2222222222222222222222222222222222222222",
		"pauserAddress":         "0x4444444444444444444444444444444444444444",
		"fractionalizerAddress": "0x5555555555555555555555555555555555555555",
	}
	headers := map[string]string{"Idempotency-Key": "vault-" + randomID()}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if created.Code != http.StatusCreated {
		t.Fatalf("create vault intent: status=%d body=%s", created.Code, created.Body.String())
	}
	var intent vaultIntent
	decode(t, created, &intent)
	if intent.ChainID != hoodiChainID || len(intent.ContractArguments) != 7 || intent.Status != "prepared" {
		t.Fatalf("unsafe vault intent: %+v", intent)
	}

	replay := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("vault replay: status=%d body=%s", replay.Code, replay.Body.String())
	}

	body["vaultName"] = "Conflicting Vault"
	conflict := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected vault conflict, got %d", conflict.Code)
	}

	txHash := "0x" + strings.Repeat("b", 64)
	submission := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents/"+intent.IntentID+"/submission", map[string]string{"transactionHash": txHash}, nil)
	if submission.Code != http.StatusOK {
		t.Fatalf("vault submission: status=%d body=%s", submission.Code, submission.Body.String())
	}
	var submitted vaultIntent
	decode(t, submission, &submitted)
	if submitted.Status != "submitted" || submitted.TransactionHash != txHash {
		t.Fatalf("unexpected vault submission: %+v", submitted)
	}
}

func request(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, req)
	return recorder
}

func jsonRequest(t *testing.T, handler http.Handler, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder, value interface{}) {
	t.Helper()
	if err := json.NewDecoder(recorder.Body).Decode(value); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}
