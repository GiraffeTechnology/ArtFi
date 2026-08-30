package httpapi

import (
	"net/http"
	"os"
	"strconv"
	"strings"
)

type governanceConfigResponse struct {
	ActionRegistryAddress string         `json:"actionRegistryAddress,omitempty"`
	ApprovalPPM           map[string]int `json:"approvalPpm"`
	ChainID               int            `json:"chainId"`
	Enabled               bool           `json:"enabled"`
	GovernorAddress       string         `json:"governorAddress,omitempty"`
	MembershipAuthority   string         `json:"membershipAuthority"`
	ProposalThresholdPPM  int            `json:"proposalThresholdPpm"`
	TokenAddress          string         `json:"tokenAddress,omitempty"`
	VaultAddress          string         `json:"vaultAddress,omitempty"`
}

type governanceProposalResponse struct {
	ActionTarget        string `json:"actionTarget"`
	ApprovalNumerator   int    `json:"approvalNumerator"`
	ApprovalDenominator int    `json:"approvalDenominator"`
	EvidenceHash        string `json:"evidenceHash,omitempty"`
	EvidenceURI         string `json:"evidenceUri,omitempty"`
	GovernorAddress     string `json:"governorAddress"`
	ProposalID          string `json:"proposalId"`
	ProposalKind        string `json:"proposalKind"`
	ProposerAddress     string `json:"proposerAddress"`
	RwaVerified         bool   `json:"rwaVerified"`
	Status              string `json:"status"`
	VoteEnd             uint64 `json:"voteEnd"`
	VoteStart           uint64 `json:"voteStart"`
}

func governanceConfigFromEnv() governanceConfigResponse {
	config := governanceConfigResponse{
		ActionRegistryAddress: strings.TrimSpace(os.Getenv("ARTFI_DAO_ACTIONS_ADDRESS")),
		ApprovalPPM: map[string]int{
			"marketMigration": 500_000,
			"physicalAction":  666_667,
			"forcedBuyout":    800_000,
		},
		ChainID:              hoodiChainID,
		GovernorAddress:      strings.TrimSpace(os.Getenv("ARTFI_GOVERNOR_ADDRESS")),
		MembershipAuthority:  "onchain-rwa-token-snapshot",
		ProposalThresholdPPM: 100_000,
		TokenAddress:         strings.TrimSpace(os.Getenv("ARTFI_GOVERNANCE_TOKEN_ADDRESS")),
		VaultAddress:         strings.TrimSpace(os.Getenv("ARTFI_RWA_VAULT_ADDRESS")),
	}
	config.Enabled = addressPattern.MatchString(config.GovernorAddress) &&
		addressPattern.MatchString(config.TokenAddress) &&
		addressPattern.MatchString(config.ActionRegistryAddress) &&
		addressPattern.MatchString(config.VaultAddress)
	return config
}

func (service *rwaService) getGovernanceConfig(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, governanceConfigFromEnv())
}

func (service *rwaService) getGovernanceProposals(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Governance index unavailable", "Durable indexed proposal data is required; fixture fallback is disabled.")
		return
	}

	limit, err := strconv.Atoi(request.URL.Query().Get("limit"))
	if err != nil || limit < 1 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT proposal_id, governor_address, proposer_address, proposal_kind, status,
		       vote_start, vote_end, action_target, approval_numerator, approval_denominator,
		       COALESCE(CONCAT('0x', LOWER(HEX(evidence_hash))), ''),
		       COALESCE(evidence_uri, ''), rwa_verified
		FROM governance_proposals
		WHERE rwa_verified = TRUE
		  AND proposal_kind IS NOT NULL
		  AND action_target IS NOT NULL
		  AND approval_numerator IS NOT NULL
		  AND approval_denominator IS NOT NULL
		ORDER BY updated_at DESC
		LIMIT ?`, limit)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Governance index unavailable", "The proposal index could not be queried.")
		return
	}
	defer rows.Close()

	proposals := make([]governanceProposalResponse, 0)
	for rows.Next() {
		var proposal governanceProposalResponse
		if err := rows.Scan(
			&proposal.ProposalID,
			&proposal.GovernorAddress,
			&proposal.ProposerAddress,
			&proposal.ProposalKind,
			&proposal.Status,
			&proposal.VoteStart,
			&proposal.VoteEnd,
			&proposal.ActionTarget,
			&proposal.ApprovalNumerator,
			&proposal.ApprovalDenominator,
			&proposal.EvidenceHash,
			&proposal.EvidenceURI,
			&proposal.RwaVerified,
		); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Governance index unavailable", "An indexed proposal could not be decoded.")
			return
		}
		proposals = append(proposals, proposal)
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Governance index unavailable", "The proposal index read did not complete.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"data":                proposals,
		"membershipAuthority": "onchain-rwa-token-snapshot",
		"schemaVersion":       "1",
	})
}
