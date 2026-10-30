package httpapi

import "testing"

// Reconciliation decisions for XM.6. `planIntentTransitions` is pure precisely so these cases can
// be proven without a database: the rules that matter here are about attribution, and getting one
// of them wrong tells a user something false about their own money.

const (
	ourTx   = "0x1111111111111111111111111111111111111111111111111111111111111111"
	otherTx = "0x2222222222222222222222222222222222222222222222222222222222222222"
)

func saleEvent(transactionHash string) marketEventRequest {
	return marketEventRequest{
		Source: "opensea", Chain: "ethereum", EventFamily: "sale",
		EventType: "item_sold", TransactionHash: transactionHash,
	}
}

func transferEvent(transactionHash string) marketEventRequest {
	return marketEventRequest{
		Source: "opensea", Chain: "ethereum", EventFamily: "transfer",
		EventType: "item_transferred", TransactionHash: transactionHash,
	}
}

func findTransition(transitions []intentTransition, match submittedMatch) (intentTransition, bool) {
	for _, transition := range transitions {
		if transition.Match == match {
			return transition, true
		}
	}
	return intentTransition{}, false
}

func TestSaleConfirmsOnlyTheIntentThatSentTheTransaction(t *testing.T) {
	transitions := planIntentTransitions(saleEvent(ourTx))
	if len(transitions) != 2 {
		t.Fatalf("expected a confirm and a fail branch, got %d", len(transitions))
	}

	confirm, ok := findTransition(transitions, matchOurTransaction)
	if !ok || confirm.Status != "confirmed" {
		t.Fatalf("our own transaction must confirm, got %+v", confirm)
	}
	if confirm.FailureCode != "" {
		t.Errorf("a confirmed fill carries no failure code, got %q", confirm.FailureCode)
	}

	// The case this test exists for: before the split, every intent on the order was confirmed,
	// so a user whose transaction lost the race was told their purchase succeeded.
	failed, ok := findTransition(transitions, matchOtherTransaction)
	if !ok || failed.Status != "failed" {
		t.Fatalf("another party's fill must not confirm this intent, got %+v", failed)
	}
	if failed.FailureCode != "external-order-filled-by-another-transaction" {
		t.Errorf("the reason must say whose fill it was, got %q", failed.FailureCode)
	}
}

func TestSaleWithoutATransactionHashConfirmsNobody(t *testing.T) {
	transitions := planIntentTransitions(saleEvent(""))
	if len(transitions) != 1 {
		t.Fatalf("an unattributable sale has one outcome, got %d", len(transitions))
	}
	if transitions[0].Status != "failed" {
		t.Errorf("an unattributable sale must not confirm an intent, got %q", transitions[0].Status)
	}
	if transitions[0].FailureCode != "external-sale-unattributed" {
		t.Errorf("the reason must say the sale could not be attributed, got %q", transitions[0].FailureCode)
	}
	for _, transition := range transitions {
		if transition.Status == "confirmed" {
			t.Fatal("no branch may confirm without a transaction to attribute")
		}
	}
}

func TestTransferOfOurTransactionReachesAccepted(t *testing.T) {
	transitions := planIntentTransitions(transferEvent(ourTx))
	if len(transitions) != 1 || transitions[0].Status != "accepted" {
		t.Fatalf("a transfer carrying our transaction is `accepted`, got %+v", transitions)
	}
	if transitions[0].Match != matchOurTransaction {
		t.Error("only the intent whose transaction moved the item may be accepted")
	}
	// An intent that already settled is not pulled back by a transfer arriving out of order.
	for _, state := range transitions[0].AllowedPrior {
		if state == "confirmed" || state == "failed" || state == "cancelled" || state == "rejected" {
			t.Errorf("a settled intent must not be reopened, prior state %q allowed", state)
		}
	}
}

func TestTransferWithoutATransactionHashChangesNothing(t *testing.T) {
	if transitions := planIntentTransitions(transferEvent("")); transitions != nil {
		t.Errorf("a transfer we cannot attribute moves no intent, got %+v", transitions)
	}
}

func TestOrderEventsApplyToEveryIntentOnTheOrder(t *testing.T) {
	cases := map[string]struct {
		eventType   string
		status      string
		failureCode string
	}{
		"cancellation": {"item_cancelled", "cancelled", ""},
		"invalidation": {"order_invalidate", "failed", "external-order-invalidated"},
		"revalidation": {"order_revalidate", "pending", ""},
	}
	for name, expected := range cases {
		t.Run(name, func(t *testing.T) {
			transitions := planIntentTransitions(marketEventRequest{
				Source: "opensea", Chain: "ethereum", EventFamily: "order",
				EventType: expected.eventType,
			})
			if len(transitions) != 1 {
				t.Fatalf("expected one outcome, got %d", len(transitions))
			}
			transition := transitions[0]
			if transition.Status != expected.status {
				t.Errorf("status = %q, want %q", transition.Status, expected.status)
			}
			if transition.FailureCode != expected.failureCode {
				t.Errorf("failure code = %q, want %q", transition.FailureCode, expected.failureCode)
			}
			// These describe the order, not one fill, so they apply to every open intent on it.
			if transition.Match != matchAnyIntent {
				t.Error("an order-level event applies to every open intent on the order")
			}
		})
	}
}

func TestUnrelatedEventsMoveNoIntent(t *testing.T) {
	for _, eventType := range []string{
		"item_listed", "item_metadata_updated", "item_received_offer",
		"item_received_bid", "collection_offer", "trait_offer", "mint",
	} {
		event := marketEventRequest{
			Source: "opensea", Chain: "ethereum", EventFamily: "order",
			EventType: eventType, TransactionHash: ourTx,
		}
		if transitions := planIntentTransitions(event); transitions != nil {
			t.Errorf("%s must move no intent, got %+v", eventType, transitions)
		}
	}
}

func TestNoTransitionEverEntersAnIntentFromATerminalState(t *testing.T) {
	events := []marketEventRequest{
		saleEvent(ourTx), saleEvent(""), transferEvent(ourTx),
		{Source: "opensea", EventFamily: "order", EventType: "item_cancelled"},
		{Source: "opensea", EventFamily: "order", EventType: "order_invalidate"},
		{Source: "opensea", EventFamily: "order", EventType: "order_revalidate"},
	}
	terminal := map[string]bool{
		"confirmed": true, "failed": true, "cancelled": true, "rejected": true,
	}
	for _, event := range events {
		for _, transition := range planIntentTransitions(event) {
			if len(transition.AllowedPrior) == 0 {
				t.Fatalf("%s: a transition with no prior states would match every row", event.EventType)
			}
			for _, state := range transition.AllowedPrior {
				if terminal[state] {
					t.Errorf("%s: terminal state %q must not be a valid prior", event.EventType, state)
				}
			}
		}
	}
}

func TestPlaceholdersNeverProducesAnEmptyInList(t *testing.T) {
	// An empty IN list is a SQL syntax error; `NULL` matches nothing, which is the safe reading.
	if got := placeholders(0); got != "NULL" {
		t.Errorf("placeholders(0) = %q, want NULL", got)
	}
	if got := placeholders(1); got != "?" {
		t.Errorf("placeholders(1) = %q, want ?", got)
	}
	if got := placeholders(3); got != "?,?,?" {
		t.Errorf("placeholders(3) = %q, want ?,?,?", got)
	}
}
