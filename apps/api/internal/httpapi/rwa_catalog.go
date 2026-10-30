package httpapi

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	mysql "github.com/go-sql-driver/mysql"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

type rwaCatalogBinding struct {
	ChainID              int    `json:"chainId"`
	CollectionAddress    string `json:"collectionAddress"`
	TokenID              string `json:"tokenId"`
	AssetID              string `json:"assetId,omitempty"`
	UnderlyingAssetID    string `json:"underlyingAssetId"`
	FractionTokenAddress string `json:"fractionTokenAddress,omitempty"`
	VaultAddress         string `json:"vaultAddress,omitempty"`
	MarketAddress        string `json:"marketAddress,omitempty"`
}
type rwaCatalogRecord struct {
	Slug        string            `json:"slug"`
	Title       string            `json:"title"`
	Artist      string            `json:"artist"`
	Year        int               `json:"year"`
	Medium      string            `json:"medium"`
	Location    string            `json:"location"`
	Description string            `json:"description"`
	ImageURL    string            `json:"imageUrl"`
	Section     string            `json:"section"`
	Rights      string            `json:"rights"`
	Provenance  []string          `json:"provenance"`
	Binding     rwaCatalogBinding `json:"binding"`
}
type rwaCatalogAsset struct {
	rwaCatalogRecord
	Grounding rwaGrounding `json:"grounding"`
	CreatedAt string       `json:"createdAt"`
	UpdatedAt string       `json:"updatedAt"`
	Revision  uint64       `json:"revision"`
}
type rwaCatalogMutation struct {
	Revision uint64            `json:"revision"`
	Asset    rwaCatalogRecord  `json:"asset"`
	Evidence rwaSourceEvidence `json:"evidence"`
}

func catalogContextHash(record rwaCatalogRecord) string {
	return hashJSON(struct {
		Domain string           `json:"domain"`
		Asset  rwaCatalogRecord `json:"asset"`
	}{"ArtFi public RWA catalog v1", record})
}
func validateCatalogRecord(a rwaCatalogRecord) error {
	b := a.Binding
	if !rwaSlugPattern.MatchString(a.Slug) || !adminText(a.Title, 2, 120) || !adminText(a.Artist, 2, 120) || a.Year < 1000 || a.Year > time.Now().UTC().Year()+1 || !adminText(a.Medium, 2, 160) || !adminText(a.Location, 2, 160) || !adminText(a.Description, 20, 2000) || (a.ImageURL != "" && !validPublicEvidenceURL(a.ImageURL)) || !adminText(a.Rights, 20, 4000) || (a.Section != "whole" && a.Section != "fractional") || len(a.Provenance) == 0 || len(a.Provenance) > 20 {
		return adminError(422, "Complete public asset metadata, rights, provenance and section are required.")
	}
	for _, p := range a.Provenance {
		if !adminText(p, 3, 512) {
			return adminError(422, "Each provenance entry must contain 3–512 characters.")
		}
	}
	// Exact address and Oracle asset ID casing is retained in the signed record.
	if b.ChainID != hoodiChainID || !validNonzeroAddress(b.CollectionAddress) || !validUint256(b.TokenID) || !adminText(b.UnderlyingAssetID, 3, 256) || (b.AssetID != "" && !adminText(b.AssetID, 1, 256)) || (b.MarketAddress != "" && !validNonzeroAddress(b.MarketAddress)) {
		return adminError(422, "An exact supported chain, collection, token and underlying asset identity are required.")
	}
	if a.Section == "fractional" {
		if !validNonzeroAddress(b.FractionTokenAddress) || !validNonzeroAddress(b.VaultAddress) {
			return adminError(422, "Fraction activation requires source-signed fraction-token and underlying vault bindings.")
		}
	} else if b.FractionTokenAddress != "" || b.VaultAddress != "" {
		return adminError(422, "Whole-receipt activation does not accept fractional bindings.")
	}
	return nil
}
func validUint256(s string) bool {
	if !uint256Pattern.MatchString(s) {
		return false
	}
	n, ok := new(big.Int).SetString(s, 10)
	return ok && n.BitLen() <= 256
}
func registerRWACatalog(mux *http.ServeMux, rwa *rwaService, auth *userAuthService) {
	admin := &administrationService{auth: auth, admins: parseAdminWallets(os.Getenv("ARTFI_ADMIN_WALLETS"))}
	mux.HandleFunc("GET /v1/rwa/assets", rwa.getRWACatalog)
	mux.HandleFunc("GET /v1/rwa/assets/{slug}", rwa.getRWACatalogAsset)
	mux.HandleFunc("GET /v1/rwa/sources", rwa.getRWASources)
	mux.HandleFunc("GET /v1/rwa/underlying-status", rwa.getUnderlyingGrounding)
	mux.HandleFunc("POST /v1/rwa/source-revocations", rwa.revokeRWAEvidence)
	mux.HandleFunc("POST /v1/user/rwa/catalog-drafts", admin.protect(false, func(w http.ResponseWriter, r *http.Request, s *userAuthSession) { rwa.reviewCatalogDraft(w, r, admin) }))
	mux.HandleFunc("PUT /v1/user/rwa/assets/{slug}", admin.protect(false, func(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
		rwa.publishCatalogAsset(w, r, s, admin)
	}))
	mux.HandleFunc("POST /v1/admin/rwa/catalog-drafts", admin.protect(true, func(w http.ResponseWriter, r *http.Request, s *userAuthSession) { rwa.reviewCatalogDraft(w, r, admin) }))
	mux.HandleFunc("PUT /v1/admin/rwa/assets/{slug}", admin.protect(true, func(w http.ResponseWriter, r *http.Request, s *userAuthSession) {
		rwa.publishCatalogAsset(w, r, s, admin)
	}))
}
func (service *rwaService) getRWASources(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sources := make([]approvedRWASource, 0, len(service.grounding.sources))
	for _, s := range service.grounding.sources {
		sources = append(sources, s)
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].ID < sources[j].ID })
	writeJSON(w, 200, map[string]any{"data": sources, "mode": service.grounding.mode, "signatureAlgorithm": "P-256/SHA-256, low-S, fixed-width r/s", "schemaVersion": 1})
}
func (service *rwaService) reviewCatalogDraft(w http.ResponseWriter, r *http.Request, admin *administrationService) {
	var record rwaCatalogRecord
	if err := decodeJSON(r, &record); err != nil {
		admin.fail(w, r, adminError(400, err.Error()))
		return
	}
	if err := validateCatalogRecord(record); err != nil {
		admin.fail(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": record, "contextHash": catalogContextHash(record), "executable": false, "detail": "Unsigned public catalog proposal. Matching approved-source evidence is required to activate it."})
}
func (service *rwaService) publishCatalogAsset(w http.ResponseWriter, r *http.Request, s *userAuthSession, admin *administrationService) {
	var input rwaCatalogMutation
	if err := decodeJSON(r, &input); err != nil {
		admin.fail(w, r, adminError(400, err.Error()))
		return
	}
	if input.Asset.Slug != r.PathValue("slug") {
		admin.fail(w, r, adminError(422, "The route and signed asset slug must agree."))
		return
	}
	if err := validateCatalogRecord(input.Asset); err != nil {
		admin.fail(w, r, err)
		return
	}
	if input.Evidence.UnderlyingAssetID != input.Asset.Binding.UnderlyingAssetID || input.Evidence.Rights != input.Asset.Rights {
		admin.fail(w, r, adminError(422, "Evidence must assert the exact underlying asset and published rights."))
		return
	}
	contextHash := catalogContextHash(input.Asset)
	if err := service.verifyActiveEvidence(r.Context(), input.Evidence, contextHash, input.Asset.Section); err != nil {
		admin.fail(w, r, err)
		return
	}
	admin.mutate(w, r, s, input, func(tx *sql.Tx) (any, int, error) {
		if err := service.lockActiveEvidence(r.Context(), tx, input.Evidence, contextHash, input.Asset.Section); err != nil {
			return nil, 0, err
		}
		var previousRecord, previousEvidence []byte
		var revision uint64
		var createdAt time.Time
		err := tx.QueryRowContext(r.Context(), "SELECT record,evidence,revision,created_at FROM rwa_catalog_assets WHERE slug=? FOR UPDATE", input.Asset.Slug).Scan(&previousRecord, &previousEvidence, &revision, &createdAt)
		creating := errors.Is(err, sql.ErrNoRows)
		if err != nil && !creating {
			return nil, 0, err
		}
		if revision != input.Revision {
			return nil, 0, adminError(409, "The record changed. Reload its revision before editing.")
		}
		if !creating {
			var before rwaCatalogRecord
			var proof rwaSourceEvidence
			if json.Unmarshal(previousRecord, &before) != nil || json.Unmarshal(previousEvidence, &proof) != nil {
				return nil, 0, errors.New("invalid stored source record")
			}
			old, new := before.Binding, input.Asset.Binding
			old.MarketAddress = ""
			new.MarketAddress = ""
			if hashJSON(old) != hashJSON(new) || before.Section != input.Asset.Section || proof.SourceID != input.Evidence.SourceID || proof.SourceAssetID != input.Evidence.SourceAssetID {
				return nil, 0, adminError(409, "Catalog source/model/token/vault identity is immutable. A different asset requires a separate source-verified record.")
			}
		}
		record, _ := json.Marshal(input.Asset)
		evidence, _ := json.Marshal(input.Evidence)
		now := service.now()
		if creating {
			createdAt = now
			b := input.Asset.Binding
			sourceKey := hashText(input.Evidence.SourceID + "\x00" + input.Evidence.SourceAssetID + "\x00" + input.Asset.Section)
			underlyingKey := hashText(b.UnderlyingAssetID + "\x00" + input.Asset.Section)
			tokenKey := hashText(strconv.Itoa(b.ChainID) + "\x00" + strings.ToLower(b.CollectionAddress) + "\x00" + b.TokenID + "\x00" + input.Asset.Section)
			var fractionKey, fractionAddress any
			if b.FractionTokenAddress != "" {
				fractionKey = hashText(strconv.Itoa(b.ChainID) + "\x00" + strings.ToLower(b.FractionTokenAddress))[2:]
				fractionAddress = b.FractionTokenAddress
			}
			_, err = tx.ExecContext(r.Context(), `INSERT INTO rwa_catalog_assets(slug,section,source_id,source_asset_key,underlying_model_key,token_model_key,fraction_token_key,chain_id,collection_address,token_id,fraction_token_address,title,record,evidence,evidence_id,context_hash,revision,created_at,updated_at) VALUES(?,?,?,UNHEX(?),UNHEX(?),UNHEX(?),UNHEX(?),?,?,?,?,?,?,?,UNHEX(?),UNHEX(?),1,?,?)`, input.Asset.Slug, input.Asset.Section, input.Evidence.SourceID, sourceKey[2:], underlyingKey[2:], tokenKey[2:], fractionKey, b.ChainID, b.CollectionAddress, b.TokenID, fractionAddress, input.Asset.Title, record, evidence, strings.TrimPrefix(input.Evidence.EvidenceID, "0x"), contextHash[2:], now, now)
		} else {
			_, err = tx.ExecContext(r.Context(), `UPDATE rwa_catalog_assets SET title=?,record=?,evidence=?,evidence_id=UNHEX(?),context_hash=UNHEX(?),revision=revision+1,updated_at=? WHERE slug=?`, input.Asset.Title, record, evidence, strings.TrimPrefix(input.Evidence.EvidenceID, "0x"), contextHash[2:], now, input.Asset.Slug)
		}
		if err != nil {
			var me *mysql.MySQLError
			if errors.As(err, &me) && me.Number == 1062 {
				return nil, 0, adminError(409, "The source asset, underlying model or token binding belongs to another record.")
			}
			return nil, 0, err
		}
		item := rwaCatalogAsset{input.Asset, service.groundingStatus(input.Evidence, contextHash, input.Asset.Section, false, now), createdAt.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339), revision + 1}
		if err := adminAudit(r.Context(), tx, r, s, now, "rwa.catalog.activated", "rwa_catalog_asset", input.Asset.Slug, revision, item); err != nil {
			return nil, 0, err
		}
		code := 200
		if creating {
			code = 201
		}
		return item, code, nil
	})
}
func (service *rwaService) lockActiveEvidence(ctx context.Context, tx *sql.Tx, e rwaSourceEvidence, contextHash, section string) error {
	if err := service.grounding.verify(e, contextHash, section, service.now(), false); err != nil {
		return err
	}
	evidenceHash := sourceEvidenceDigest(e)
	_, err := tx.ExecContext(ctx, `INSERT IGNORE INTO rwa_evidence_locks(source_id,evidence_id,created_at) VALUES (?,UNHEX(?),?)`, e.SourceID, strings.TrimPrefix(e.EvidenceID, "0x"), service.now())
	if err != nil {
		return err
	}
	var previous []byte
	if err = tx.QueryRowContext(ctx, `SELECT evidence_hash FROM rwa_evidence_locks WHERE source_id=? AND evidence_id=UNHEX(?) FOR UPDATE`, e.SourceID, strings.TrimPrefix(e.EvidenceID, "0x")).Scan(&previous); err != nil {
		return err
	}
	if err := service.grounding.verify(e, contextHash, section, service.now(), false); err != nil {
		return err
	}
	if len(previous) > 0 && hex.EncodeToString(previous) != evidenceHash[2:] {
		return adminError(409, "This source evidence ID already binds a different claim.")
	}
	var revoked []byte
	err = tx.QueryRowContext(ctx, `SELECT evidence_id FROM rwa_source_revocations WHERE source_id=? AND evidence_id=UNHEX(?)`, e.SourceID, strings.TrimPrefix(e.EvidenceID, "0x")).Scan(&revoked)
	if err == nil {
		return adminError(409, "The source revoked this evidence.")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE rwa_evidence_locks SET evidence_hash=UNHEX(?) WHERE source_id=? AND evidence_id=UNHEX(?)`, evidenceHash[2:], e.SourceID, strings.TrimPrefix(e.EvidenceID, "0x"))
	return err
}
func (service *rwaService) getRWACatalog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if service.db == nil {
		service.catalogUnavailable(w, r)
		return
	}
	if !adminOnlyQuery(r, "section", "q", "page", "pageSize", "sort", "fractionTokenAddress", "chainId", "collectionAddress", "tokenId") {
		writeProblem(w, r, 400, "Invalid query", "Only documented single-value filters are supported.")
		return
	}
	where, args := "1=1", []any{}
	if section := r.URL.Query().Get("section"); section != "" {
		if section != "whole" && section != "fractional" {
			writeProblem(w, r, 400, "Invalid section", "Use whole or fractional.")
			return
		}
		where += " AND c.section=?"
		args = append(args, section)
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		if len(q) > 200 {
			writeProblem(w, r, 400, "Invalid search", "Search is limited to 200 characters.")
			return
		}
		where += " AND (LOCATE(LOWER(?),LOWER(c.title))>0 OR LOCATE(LOWER(?),LOWER(JSON_UNQUOTE(JSON_EXTRACT(c.record,'$.artist'))))>0)"
		args = append(args, q, q)
	}
	for _, filter := range []struct{ key, column string }{{"fractionTokenAddress", "fraction_token_address"}, {"collectionAddress", "collection_address"}} {
		if v := r.URL.Query().Get(filter.key); v != "" {
			if !validNonzeroAddress(v) {
				writeProblem(w, r, 400, "Invalid binding filter", "Use a nonzero EVM address.")
				return
			}
			where += " AND LOWER(c." + filter.column + ")=?"
			args = append(args, strings.ToLower(v))
		}
	}
	if v := r.URL.Query().Get("chainId"); v != "" {
		if v != strconv.Itoa(hoodiChainID) {
			writeProblem(w, r, 400, "Invalid chain", "The supported RWA chain is Hoodi.")
			return
		}
		where += " AND c.chain_id=?"
		args = append(args, hoodiChainID)
	}
	if v := r.URL.Query().Get("tokenId"); v != "" {
		if !validUint256(v) {
			writeProblem(w, r, 400, "Invalid token", "Use a canonical uint256 token ID.")
			return
		}
		where += " AND c.token_id=?"
		args = append(args, v)
	}
	ordering := "c.title,c.slug"
	if s := r.URL.Query().Get("sort"); s == "updated" {
		ordering = "c.updated_at DESC,c.slug"
	} else if s != "" && s != "title" {
		writeProblem(w, r, 400, "Invalid sort", "Use title or updated.")
		return
	}
	page, size := pagination(r)
	count, err := service.db.QueryContext(r.Context(), "SELECT COUNT(*) FROM rwa_catalog_assets c WHERE "+where, args...)
	if err != nil {
		service.catalogUnavailable(w, r)
		return
	}
	var total int
	if count.Next() {
		err = count.Scan(&total)
	}
	if err == nil {
		err = count.Err()
	}
	count.Close()
	if err != nil {
		service.catalogUnavailable(w, r)
		return
	}
	items, err := service.readCatalogRows(r.Context(), where+" ORDER BY "+ordering+" LIMIT ? OFFSET ?", append(args, size, (page-1)*size)...)
	if err != nil {
		service.catalogUnavailable(w, r)
		return
	}
	writeJSON(w, 200, map[string]any{"data": items, "total": total, "page": page, "pageSize": size, "hasMore": page*size < total})
}
func (service *rwaService) getRWACatalogAsset(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if service.db == nil {
		service.catalogUnavailable(w, r)
		return
	}
	if !rwaSlugPattern.MatchString(r.PathValue("slug")) || !adminOnlyQuery(r) {
		writeProblem(w, r, 404, "RWA asset not found", "No catalog asset matches this slug.")
		return
	}
	items, err := service.readCatalogRows(r.Context(), "c.slug=?", r.PathValue("slug"))
	if err != nil {
		service.catalogUnavailable(w, r)
		return
	}
	if len(items) == 0 {
		writeProblem(w, r, 404, "RWA asset not found", "No catalog asset matches this slug.")
		return
	}
	writeJSON(w, 200, items[0])
}
func (service *rwaService) catalogUnavailable(w http.ResponseWriter, r *http.Request) {
	writeProblem(w, r, 503, "RWA catalog unavailable", "The approved-source catalog could not be read. No fixture or activation claim was substituted.")
}
func (service *rwaService) readCatalogRows(ctx context.Context, where string, args ...any) ([]rwaCatalogAsset, error) {
	rows, err := service.db.QueryContext(ctx, `SELECT c.record,c.evidence,CONCAT('0x',LOWER(HEX(c.context_hash))),c.revision,c.created_at,c.updated_at,(r.evidence_id IS NOT NULL) FROM rwa_catalog_assets c LEFT JOIN rwa_source_revocations r ON r.source_id=c.source_id AND r.evidence_id=c.evidence_id WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []rwaCatalogAsset{}
	for rows.Next() {
		var record, evidence []byte
		var hash string
		var revision uint64
		var created, updated time.Time
		var revoked bool
		if err = rows.Scan(&record, &evidence, &hash, &revision, &created, &updated, &revoked); err != nil {
			return nil, err
		}
		var a rwaCatalogRecord
		var e rwaSourceEvidence
		if json.Unmarshal(record, &a) != nil || json.Unmarshal(evidence, &e) != nil || catalogContextHash(a) != hash {
			return nil, errors.New("invalid persisted source commitment")
		}
		items = append(items, rwaCatalogAsset{a, service.groundingStatus(e, hash, a.Section, revoked, updated), created.UTC().Format(time.RFC3339), updated.UTC().Format(time.RFC3339), revision})
	}
	return items, rows.Err()
}

func (service *rwaService) getUnderlyingGrounding(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	collection, token := q.Get("collectionAddress"), q.Get("tokenId")
	if !adminOnlyQuery(r, "chainId", "collectionAddress", "tokenId") || q.Get("chainId") != strconv.Itoa(hoodiChainID) || !validNonzeroAddress(collection) || !validUint256(token) {
		writeProblem(w, r, 400, "Invalid underlying identity", "Use the supported chain and exact collection/token identity.")
		return
	}
	if err := service.requireGroundedUnderlying(r.Context(), collection, token); err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"chainId": hoodiChainID, "collectionAddress": collection, "tokenId": token, "grounded": true, "checkedAt": service.now().UTC().Format(time.RFC3339)})
}
