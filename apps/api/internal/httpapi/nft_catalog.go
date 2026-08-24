package httpapi

import (
	"net/http"
	"strings"
)

type mintedNFT struct {
	Standard        string `json:"standard"`
	Collection      string `json:"collectionAddress"`
	TokenID         string `json:"tokenId"`
	Holder          string `json:"holderAddress,omitempty"`
	MetadataURI     string `json:"metadataUri,omitempty"`
	TransactionHash string `json:"transactionHash"`
	BlockNumber     uint64 `json:"blockNumber"`
	ObservedAt      string `json:"observedAt"`
}

func (service *rwaService) getMintedNFTs(writer http.ResponseWriter, request *http.Request) {
	page, pageSize := pagination(request)
	if service.db == nil {
		writeJSON(writer, http.StatusOK, map[string]any{
			"data": []mintedNFT{}, "total": 0, "page": page, "pageSize": pageSize,
			"chainId": baseSepoliaChainID, "runtime": true,
		})
		return
	}

	const eventFilter = "chain_id = ? AND removed = FALSE AND event_name IN ('AssetCreated', 'SeriesCreated')"
	var total int
	countRows, err := service.db.QueryContext(
		request.Context(),
		"SELECT COUNT(*) FROM chain_events WHERE "+eventFilter,
		baseSepoliaChainID,
	)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog could not be counted.")
		return
	}
	if countRows.Next() {
		err = countRows.Scan(&total)
	}
	countRows.Close()
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog count could not be decoded.")
		return
	}

	rows, err := service.db.QueryContext(request.Context(), `
		SELECT event_name, LOWER(contract_address),
		       LOWER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.collectionAddress')), ''), '')),
		       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenId')),
		       LOWER(COALESCE(
		         NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.recipient')), ''),
		         NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.distributionWallet')), ''),
		         '')),
		       COALESCE(
		         NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metadataURI')), ''),
		         NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metadataUri')), ''),
		         ''),
		       LOWER(transaction_hash), block_number,
		       DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM chain_events
		WHERE `+eventFilter+`
		ORDER BY block_number DESC, log_index DESC
		LIMIT ? OFFSET ?`, baseSepoliaChainID, pageSize, (page-1)*pageSize)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog could not be queried.")
		return
	}
	defer rows.Close()

	items := make([]mintedNFT, 0, pageSize)
	for rows.Next() {
		var eventName string
		var eventContract string
		var indexedCollection string
		var item mintedNFT
		if err := rows.Scan(
			&eventName,
			&eventContract,
			&indexedCollection,
			&item.TokenID,
			&item.Holder,
			&item.MetadataURI,
			&item.TransactionHash,
			&item.BlockNumber,
			&item.ObservedAt,
		); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog could not be decoded.")
			return
		}
		if eventName == "AssetCreated" {
			item.Standard = "ERC-721"
			item.Collection = indexedCollection
		} else {
			item.Standard = "ERC-1155"
			item.Collection = eventContract
		}
		if !addressPattern.MatchString(item.Collection) || !uint256Pattern.MatchString(item.TokenID) ||
			!txHashPattern.MatchString(item.TransactionHash) ||
			(item.Holder != "" && !addressPattern.MatchString(item.Holder)) ||
			(item.MetadataURI != "" && !strings.HasPrefix(item.MetadataURI, "https://")) {
			writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog contains an invalid canonical record.")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "NFT catalog unavailable", "The indexed NFT catalog query was interrupted.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"data": items, "total": total, "page": page, "pageSize": pageSize,
		"chainId": baseSepoliaChainID, "runtime": true,
	})
}
