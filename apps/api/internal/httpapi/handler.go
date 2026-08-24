package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type statusResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
	Version string `json:"version"`
}

type configResponse struct {
	API                 string `json:"api"`
	ChainID             int    `json:"chainId"`
	Mode                string `json:"mode"`
	Network             string `json:"network"`
	ReadOnly            bool   `json:"readOnly"`
	RegistryAddress     string `json:"registryAddress,omitempty"`
	VaultFactoryAddress string `json:"vaultFactoryAddress,omitempty"`
	WriteEnabled        bool   `json:"writeEnabled"`
}

type asset struct {
	Slug               string   `json:"slug"`
	Title              string   `json:"title"`
	Artist             string   `json:"artist"`
	Year               int      `json:"year"`
	Medium             string   `json:"medium"`
	Location           string   `json:"location"`
	ValuationUSD       int      `json:"valuationUsd"`
	FractionPriceUSD   int      `json:"fractionPriceUsd"`
	TotalFractions     int      `json:"totalFractions"`
	AvailableFractions int      `json:"availableFractions"`
	Status             string   `json:"status"`
	Provenance         []string `json:"provenance"`
}

type project struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Curator     string   `json:"curator"`
	Location    string   `json:"location"`
	AssetSlugs  []string `json:"assetSlugs"`
	Description string   `json:"description"`
}

type problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail"`
	RequestID string `json:"requestId"`
}

var addressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

var assets = []asset{
	{Slug: "blue-hour-archive", Title: "Blue Hour Archive", Artist: "Mina Okafor", Year: 2024, Medium: "Pigment, linen, mineral ground", Location: "Lagos", ValuationUSD: 184000, FractionPriceUSD: 46, TotalFractions: 4000, AvailableFractions: 1620, Status: "Fractionalized", Provenance: []string{"Artist studio record", "Independent condition report", "Curator intake review"}},
	{Slug: "soft-monument-no-3", Title: "Soft Monument No. 3", Artist: "Ana Ribeiro", Year: 2023, Medium: "Woven fiber and natural dye", Location: "Lisbon", ValuationUSD: 96000, FractionPriceUSD: 32, TotalFractions: 3000, AvailableFractions: 780, Status: "Vault ready", Provenance: []string{"Workshop certificate", "Material analysis", "Custody intake record"}},
	{Slug: "field-notes-vii", Title: "Field Notes VII", Artist: "Eli Navarro", Year: 2022, Medium: "Oil, wax, and graphite on panel", Location: "Mexico City", ValuationUSD: 128000, FractionPriceUSD: 40, TotalFractions: 3200, AvailableFractions: 1184, Status: "Verified", Provenance: []string{"Studio inventory", "Gallery exhibition record", "High-resolution condition capture"}},
}

var projects = []project{
	{Slug: "material-memory", Name: "Material Memory", Curator: "Atelier North", Location: "Lisbon · Lagos", AssetSlugs: []string{"blue-hour-archive", "soft-monument-no-3"}, Description: "Fiber, pigment, and repeated handwork as durable public records."},
	{Slug: "signals-in-earth", Name: "Signals in Earth", Curator: "Common Field Office", Location: "Accra · Mexico City", AssetSlugs: []string{"field-notes-vii"}, Description: "Weather and terrain translated into documented physical objects."},
}

func NewHandler() http.Handler {
	return newHandler(newRWAServiceFromEnv())
}

func newHandler(rwa *rwaService) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", status("ok"))
	mux.HandleFunc("GET /readyz", status("ready"))
	mux.HandleFunc("GET /v1/config", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, configResponse{
			API:                 "v1",
			ChainID:             baseSepoliaChainID,
			Mode:                "preview",
			Network:             "base-sepolia",
			ReadOnly:            !rwa.writeEnabled(),
			RegistryAddress:     rwa.config.registryAddress,
			VaultFactoryAddress: rwa.config.vaultFactoryAddress,
			WriteEnabled:        rwa.writeEnabled(),
		})
	})
	mux.HandleFunc("GET /v1/assets", getAssets)
	mux.HandleFunc("GET /v1/assets/{slug}", getAsset)
	mux.HandleFunc("GET /v1/nfts", rwa.getMintedNFTs)
	mux.HandleFunc("GET /v1/projects", getProjects)
	mux.HandleFunc("GET /v1/portfolio/{address}", rwa.getPortfolio)
	mux.HandleFunc("POST /v1/uploads/intents", rwa.createUploadIntent)
	mux.HandleFunc("PUT /v1/uploads/{uploadID}", rwa.uploadObject)
	mux.HandleFunc("POST /v1/rwa/intents", rwa.createMintIntent)
	mux.HandleFunc("GET /v1/rwa/intents/{intentID}", rwa.getMintIntent)
	mux.HandleFunc("POST /v1/rwa/intents/{intentID}/submission", rwa.recordSubmission)
	mux.HandleFunc("POST /v1/rwa/discovery-checks", rwa.checkOpenSeaDiscovery)
	mux.HandleFunc("POST /v1/vault/intents", rwa.createVaultIntent)
	mux.HandleFunc("GET /v1/vault/intents/{intentID}", rwa.getVaultIntent)
	mux.HandleFunc("POST /v1/vault/intents/{intentID}/submission", rwa.recordVaultSubmission)
	mux.HandleFunc("POST /v1/indexer/events", rwa.ingestChainEvent)
	mux.HandleFunc("POST /v1/indexer/market-events", rwa.ingestMarketEvent)
	mux.HandleFunc("GET /v1/market/activity", rwa.getMarketActivity)
	mux.HandleFunc("GET /v1/market/assets", rwa.getMarketAssets)
	mux.HandleFunc("POST /v1/market/intents", rwa.createMarketIntent)
	mux.HandleFunc("GET /v1/market/intents/{intentID}", rwa.getMarketIntent)
	mux.HandleFunc("POST /v1/market/intents/{intentID}/submission", rwa.recordMarketSubmission)
	mux.HandleFunc("GET /v1/governance/config", rwa.getGovernanceConfig)
	mux.HandleFunc("GET /v1/governance/proposals", rwa.getGovernanceProposals)
	return middleware(mux, rwa)
}

func middleware(next http.Handler, service *rwaService) http.Handler {
	allowedOrigin := os.Getenv("ARTFI_WEB_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:3000"
	}

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		requestID := request.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = newRequestID()
		}
		writer.Header().Set("X-Request-ID", requestID)
		writer.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		writer.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-SHA256, Idempotency-Key, X-Indexer-Key, X-Request-ID")
		writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		writer.Header().Set("Vary", "Origin")
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		if service.operatorProtected(request) && !service.authorizeOperator(request) {
			writeProblem(writer, request, http.StatusUnauthorized, "Operator authentication failed", "A reviewed, short-lived operator credential is required for this write path.")
			return
		}

		next.ServeHTTP(writer, request)
		slog.Info("request completed", "method", request.Method, "path", request.URL.Path, "request_id", requestID, "duration_ms", time.Since(started).Milliseconds())
	})
}

func status(state string) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, statusResponse{Service: "artfi-api", Status: state, Version: "0.1.0"})
	}
}

func getAssets(writer http.ResponseWriter, request *http.Request) {
	query := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("q")))
	status := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("status")))
	filtered := make([]asset, 0, len(assets))
	for _, candidate := range assets {
		searchable := strings.ToLower(candidate.Title + " " + candidate.Artist + " " + candidate.Medium + " " + candidate.Location)
		if query != "" && !strings.Contains(searchable, query) {
			continue
		}
		if status != "" && strings.ToLower(candidate.Status) != status {
			continue
		}
		filtered = append(filtered, candidate)
	}
	sort.Slice(filtered, func(left, right int) bool { return filtered[left].Title < filtered[right].Title })
	page, pageSize := pagination(request)
	start := min((page-1)*pageSize, len(filtered))
	end := min(start+pageSize, len(filtered))
	writeJSON(writer, http.StatusOK, map[string]interface{}{
		"data": filtered[start:end], "total": len(filtered), "page": page, "pageSize": pageSize,
	})
}

func getAsset(writer http.ResponseWriter, request *http.Request) {
	slug := request.PathValue("slug")
	for _, candidate := range assets {
		if candidate.Slug == slug {
			writeJSON(writer, http.StatusOK, candidate)
			return
		}
	}
	writeProblem(writer, request, http.StatusNotFound, "Asset not found", "No asset record matches the requested slug.")
}

func getProjects(writer http.ResponseWriter, request *http.Request) {
	query := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("q")))
	filtered := make([]project, 0, len(projects))
	for _, candidate := range projects {
		searchable := strings.ToLower(candidate.Name + " " + candidate.Curator + " " + candidate.Location + " " + candidate.Description)
		if query == "" || strings.Contains(searchable, query) {
			filtered = append(filtered, candidate)
		}
	}
	page, pageSize := pagination(request)
	start := min((page-1)*pageSize, len(filtered))
	end := min(start+pageSize, len(filtered))
	writeJSON(writer, http.StatusOK, map[string]interface{}{
		"data": filtered[start:end], "total": len(filtered), "page": page, "pageSize": pageSize,
	})
}

func pagination(request *http.Request) (int, int) {
	page, err := strconv.Atoi(request.URL.Query().Get("page"))
	if err != nil || page < 1 {
		page = 1
	}
	pageSize, err := strconv.Atoi(request.URL.Query().Get("pageSize"))
	if err != nil || pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func writeProblem(writer http.ResponseWriter, request *http.Request, statusCode int, title, detail string) {
	writer.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	writer.WriteHeader(statusCode)
	_ = json.NewEncoder(writer).Encode(problem{Type: "https://artfi.example/problems/request", Title: title, Status: statusCode, Detail: detail, RequestID: writer.Header().Get("X-Request-ID")})
}

func writeJSON(writer http.ResponseWriter, statusCode int, value interface{}) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(statusCode)
	_ = json.NewEncoder(writer).Encode(value)
}

func newRequestID() string {
	var value [8]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "request-unavailable"
	}
	return hex.EncodeToString(value[:])
}
