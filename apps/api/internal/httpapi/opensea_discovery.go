package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maximumOpenSeaDiscoveryResponse = 1 << 20

var openSeaChainPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)

type openSeaDiscoveryRequest struct {
	Source          string `json:"source"`
	Chain           string `json:"chain"`
	ContractAddress string `json:"contractAddress"`
	TokenID         string `json:"tokenId"`
}

type openSeaDiscoveryResponse struct {
	CheckID         string `json:"checkId"`
	Source          string `json:"source"`
	Chain           string `json:"chain"`
	ContractAddress string `json:"contractAddress"`
	TokenID         string `json:"tokenId"`
	Result          string `json:"result"`
	Discovered      bool   `json:"discovered"`
	Collection      string `json:"collection,omitempty"`
	TokenStandard   string `json:"tokenStandard,omitempty"`
	MarketplaceURL  string `json:"marketplaceUrl,omitempty"`
	EvidenceSHA256  string `json:"evidenceSha256"`
	UpstreamStatus  int    `json:"upstreamStatus"`
	ObservedAt      string `json:"observedAt"`
}

type openSeaChainsResponse struct {
	Chains []struct {
		Chain string `json:"chain"`
	} `json:"chains"`
}

type openSeaNFTResponse struct {
	NFT *struct {
		Identifier    string `json:"identifier"`
		Collection    string `json:"collection"`
		TokenStandard string `json:"token_standard"`
	} `json:"nft"`
}

func (service *rwaService) checkOpenSeaDiscovery(writer http.ResponseWriter, request *http.Request) {
	if service.openseaAPIKey == "" || service.marketHTTPClient == nil ||
		(service.requireDB && service.db == nil) {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Discovery verification unavailable", "A reviewed OpenSea API key and durable persistence are required.")
		return
	}

	var input openSeaDiscoveryRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid discovery request", err.Error())
		return
	}
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	input.Chain = strings.ToLower(strings.TrimSpace(input.Chain))
	input.ContractAddress = strings.ToLower(strings.TrimSpace(input.ContractAddress))
	input.TokenID = strings.TrimSpace(input.TokenID)
	if input.Source != "opensea" || !openSeaChainPattern.MatchString(input.Chain) ||
		!addressPattern.MatchString(input.ContractAddress) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid discovery target", "Use OpenSea, a supported chain identifier, a contract address, and a decimal token ID.")
		return
	}
	tokenID, ok := new(big.Int).SetString(input.TokenID, 10)
	if !ok || tokenID.Sign() < 0 || len(tokenID.String()) > 78 || tokenID.String() != input.TokenID {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid discovery target", "Use OpenSea, a supported chain identifier, a contract address, and a canonical decimal token ID.")
		return
	}

	chainsStatus, chainsBody, err := service.openSeaGET(request, "/api/v2/chains")
	if err != nil || chainsStatus != http.StatusOK {
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea discovery unavailable", "OpenSea supported-chain verification did not return an accepted response.")
		return
	}
	var chains openSeaChainsResponse
	if err := json.Unmarshal(chainsBody, &chains); err != nil || len(chains.Chains) == 0 {
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea discovery unavailable", "OpenSea returned an invalid supported-chain response.")
		return
	}
	supported := false
	for _, candidate := range chains.Chains {
		if strings.EqualFold(candidate.Chain, input.Chain) {
			supported = true
			break
		}
	}
	if !supported {
		service.writeDiscoveryResult(writer, request, input, "unsupported-chain", false, chainsStatus, chainsBody, "", "")
		return
	}

	endpoint := fmt.Sprintf(
		"/api/v2/chain/%s/contract/%s/nfts/%s",
		url.PathEscape(input.Chain),
		url.PathEscape(input.ContractAddress),
		url.PathEscape(input.TokenID),
	)
	nftStatus, nftBody, err := service.openSeaGET(request, endpoint)
	if err != nil {
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea discovery unavailable", "OpenSea NFT discovery did not return an accepted response.")
		return
	}
	if nftStatus == http.StatusNotFound {
		service.writeDiscoveryResult(writer, request, input, "not-found", false, nftStatus, nftBody, "", "")
		return
	}
	if nftStatus != http.StatusOK {
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea discovery unavailable", "OpenSea NFT discovery did not return an accepted response.")
		return
	}
	var nft openSeaNFTResponse
	if err := json.Unmarshal(nftBody, &nft); err != nil || nft.NFT == nil || nft.NFT.Identifier != input.TokenID {
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea discovery unavailable", "OpenSea returned an invalid or mismatched NFT response.")
		return
	}
	service.writeDiscoveryResult(writer, request, input, "discovered", true, nftStatus, nftBody, nft.NFT.Collection, nft.NFT.TokenStandard)
}

func (service *rwaService) openSeaGET(request *http.Request, endpoint string) (int, []byte, error) {
	upstream, err := http.NewRequestWithContext(
		request.Context(),
		http.MethodGet,
		strings.TrimRight(service.openseaAPIBaseURL, "/")+endpoint,
		nil,
	)
	if err != nil {
		return 0, nil, err
	}
	upstream.Header.Set("X-API-Key", service.openseaAPIKey)
	upstream.Header.Set("Accept", "application/json")
	response, err := service.marketHTTPClient.Do(upstream)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumOpenSeaDiscoveryResponse+1))
	if err != nil {
		return 0, nil, err
	}
	if len(body) > maximumOpenSeaDiscoveryResponse {
		return 0, nil, errors.New("OpenSea discovery response is too large")
	}
	return response.StatusCode, body, nil
}

func (service *rwaService) writeDiscoveryResult(
	writer http.ResponseWriter,
	request *http.Request,
	input openSeaDiscoveryRequest,
	result string,
	discovered bool,
	upstreamStatus int,
	evidence []byte,
	collection string,
	tokenStandard string,
) {
	observedAt := service.now().UTC()
	digest := sha256.Sum256(evidence)
	checkID := randomID()
	marketplaceURL := ""
	if discovered {
		marketplaceURL = fmt.Sprintf("https://opensea.io/assets/%s/%s/%s", input.Chain, input.ContractAddress, input.TokenID)
	}
	if service.db != nil {
		_, err := service.db.ExecContext(request.Context(), `
			INSERT INTO marketplace_discovery_checks
			    (check_id, source, chain_name, contract_address, token_id, result,
			     upstream_status, evidence_sha256, marketplace_url, observed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, UNHEX(?), NULLIF(?, ''), ?)`,
			checkID,
			input.Source,
			input.Chain,
			input.ContractAddress,
			input.TokenID,
			result,
			upstreamStatus,
			hex.EncodeToString(digest[:]),
			marketplaceURL,
			observedAt,
		)
		if err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Discovery evidence unavailable", "The OpenSea discovery result could not be recorded durably.")
			return
		}
	}
	writeJSON(writer, http.StatusOK, openSeaDiscoveryResponse{
		CheckID:         checkID,
		Source:          input.Source,
		Chain:           input.Chain,
		ContractAddress: input.ContractAddress,
		TokenID:         input.TokenID,
		Result:          result,
		Discovered:      discovered,
		Collection:      collection,
		TokenStandard:   tokenStandard,
		MarketplaceURL:  marketplaceURL,
		EvidenceSHA256:  hex.EncodeToString(digest[:]),
		UpstreamStatus:  upstreamStatus,
		ObservedAt:      observedAt.Format(time.RFC3339Nano),
	})
}
