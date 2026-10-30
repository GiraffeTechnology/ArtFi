package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"
)

// Requires the existing explicitly bound integration MySQL and migration 000018.
// No synthetic DB or missing-environment skip is recorded as durable acceptance.
func TestCharityHolderDurableRealMySQLAcrossInstances(t *testing.T) {
	db, service, now, address := walletAuthIntegrationFixture(t)
	if _, err := db.ExecContext(context.Background(), "SELECT challenge_hash FROM charity_holder_challenges LIMIT 0"); err != nil {
		t.Fatalf("apply charity challenge migration 000018: %v", err)
	}
	hash, err := userRandomToken(32)
	if err != nil {
		t.Fatal(err)
	}
	rawHash, _ := hex.DecodeString(hash)
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), "DELETE FROM charity_holder_challenges WHERE challenge_hash = ?", rawHash); err != nil {
			t.Error(err)
		}
	})
	input := charityHolderChallengeInput{ChallengeHash: hash, Address: address, ChainID: hoodiChainID, TokenID: "7", Origin: service.origin, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(5 * time.Minute).UnixMilli()}
	if err := service.persistHolderChallenge(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			other := userAuthTestService(db, func() time.Time { return *now })
			results <- other.consumeHolderChallengeRecord(context.Background(), input)
		}()
	}
	wg.Wait()
	close(results)
	wins, refusals := 0, 0
	for err := range results {
		if err == nil {
			wins++
		} else if errors.Is(err, errUserUnauthorized) {
			refusals++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || refusals != 15 {
		t.Fatalf("wins=%d refusals=%d", wins, refusals)
	}
	recreated := userAuthTestService(db, func() time.Time { return *now })
	if err := recreated.consumeHolderChallengeRecord(context.Background(), input); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("recreated instance replay: %v", err)
	}
	var consumed time.Time
	if err := db.QueryRow("SELECT consumed_at FROM charity_holder_challenges WHERE challenge_hash = ?", rawHash).Scan(&consumed); err != nil || !consumed.Equal(*now) {
		t.Fatalf("stored transition: %v %v", consumed, err)
	}
}
