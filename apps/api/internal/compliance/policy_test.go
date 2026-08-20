package compliance

import (
	"strings"
	"testing"
	"time"
)

func TestEvaluateFailsClosedAcrossComplianceGates(t *testing.T) {
	now := time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC)
	policy := Policy{
		Version: "test-policy-v1", AllowedJurisdictions: map[string]struct{}{"SG": {}},
		MaximumAssertionAge: 24 * time.Hour, RequireEligibility: true,
	}
	valid := SubjectAssertion{
		SubjectHash: strings.Repeat("a", 64), Verification: StatusApproved,
		SanctionsCleared: true, Jurisdiction: "SG", InvestorEligible: true,
		IssuedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
	}
	decision, err := Evaluate(policy, valid, now)
	if err != nil || !decision.Allowed {
		t.Fatalf("valid assertion rejected: decision=%+v error=%v", decision, err)
	}

	tests := []struct {
		name   string
		mutate func(*SubjectAssertion)
	}{
		{"pending identity", func(value *SubjectAssertion) { value.Verification = StatusPending }},
		{"sanctions match", func(value *SubjectAssertion) { value.SanctionsCleared = false }},
		{"stale", func(value *SubjectAssertion) { value.IssuedAt = now.Add(-25 * time.Hour) }},
		{"expired", func(value *SubjectAssertion) { value.ExpiresAt = now }},
		{"jurisdiction", func(value *SubjectAssertion) { value.Jurisdiction = "ZZ" }},
		{"eligibility", func(value *SubjectAssertion) { value.InvestorEligible = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			decision, err := Evaluate(policy, candidate, now)
			if err != nil || decision.Allowed || decision.Reason == "" {
				t.Fatalf("gate did not fail closed: decision=%+v error=%v", decision, err)
			}
		})
	}
}
