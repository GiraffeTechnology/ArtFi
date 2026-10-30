package httpapi

import (
	"math/big"
	"strings"
)

// ERC721 Transfer uses tokenId, whereas the existing fungible projection uses
// value and symbol. Keep the canonical NFT event, but never turn its token ID
// into a fungible portfolio balance. The authenticated indexer remains the
// source of the observed event; this check does not prove ownership or finality.
func isERC721TransferPayload(payload map[string]any) (bool, error) {
	tokenID, present := payload["tokenId"]
	if !present {
		return false, nil
	}
	// Do not silently accept ambiguous NFT/fungible shapes or discard fields.
	if len(payload) != 3 {
		return false, errEventConflict
	}
	from, fromOK := payload["from"].(string)
	to, toOK := payload["to"].(string)
	id, idOK := tokenID.(string)
	if !fromOK || !toOK || !idOK || !addressPattern.MatchString(from) ||
		!addressPattern.MatchString(to) || !uint256Pattern.MatchString(id) {
		return false, errEventConflict
	}
	value, ok := new(big.Int).SetString(id, 10)
	if !ok || value.Sign() < 0 || value.BitLen() > 256 {
		return false, errEventConflict
	}
	const zero = "0x0000000000000000000000000000000000000000"
	if strings.EqualFold(from, zero) && strings.EqualFold(to, zero) {
		return false, errEventConflict
	}
	return true, nil
}
