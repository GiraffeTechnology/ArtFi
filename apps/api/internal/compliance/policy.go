package compliance

import (
	"errors"
	"strings"
	"time"
)

type VerificationStatus string

const (
	StatusApproved VerificationStatus = "approved"
	StatusPending  VerificationStatus = "pending"
	StatusRejected VerificationStatus = "rejected"
)

type SubjectAssertion struct {
	SubjectHash      string
	Verification     VerificationStatus
	SanctionsCleared bool
	Jurisdiction     string
	InvestorEligible bool
	IssuedAt         time.Time
	ExpiresAt        time.Time
}

type Policy struct {
	Version              string
	AllowedJurisdictions map[string]struct{}
	MaximumAssertionAge  time.Duration
	RequireEligibility   bool
}

type Decision struct {
	Allowed       bool
	PolicyVersion string
	Reason        string
	ValidUntil    time.Time
}

func Evaluate(policy Policy, assertion SubjectAssertion, now time.Time) (Decision, error) {
	if strings.TrimSpace(policy.Version) == "" || policy.MaximumAssertionAge <= 0 {
		return Decision{}, errors.New("invalid compliance policy")
	}
	decision := Decision{PolicyVersion: policy.Version, ValidUntil: assertion.ExpiresAt}
	switch {
	case len(assertion.SubjectHash) != 64:
		decision.Reason = "invalid pseudonymous subject"
	case assertion.Verification != StatusApproved:
		decision.Reason = "identity verification is not approved"
	case !assertion.SanctionsCleared:
		decision.Reason = "sanctions screening is not cleared"
	case assertion.IssuedAt.After(now) || now.Sub(assertion.IssuedAt) > policy.MaximumAssertionAge:
		decision.Reason = "compliance assertion is stale"
	case !assertion.ExpiresAt.After(now):
		decision.Reason = "compliance assertion is expired"
	case !jurisdictionAllowed(policy.AllowedJurisdictions, assertion.Jurisdiction):
		decision.Reason = "jurisdiction is not approved"
	case policy.RequireEligibility && !assertion.InvestorEligible:
		decision.Reason = "investor eligibility is not satisfied"
	default:
		decision.Allowed = true
		decision.Reason = "approved"
	}
	return decision, nil
}

func jurisdictionAllowed(allowed map[string]struct{}, jurisdiction string) bool {
	_, ok := allowed[strings.ToUpper(strings.TrimSpace(jurisdiction))]
	return ok
}
