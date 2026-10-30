// The internal journal is a separate opt-in mTLS service. The public API binary
// never registers its route and does not inherit these transport credentials.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/GiraffeTechnology/ArtFi/apps/api/internal/httpapi"
)

func main() {
	server, db, err := httpapi.NewNFTTaskJournalServerFromEnvironment(os.Getenv)
	if err != nil {
		slog.Error("NFT task journal not started", "code", "TASK_JOURNAL_CONFIGURATION_REQUIRED")
		os.Exit(1)
	}
	defer db.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServeTLS("", "") }()
	select {
	case err := <-stopped:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("NFT task journal stopped", "code", "TASK_JOURNAL_SERVER_FAILED")
			os.Exit(1)
		}
	case <-ctx.Done():
		deadline, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if server.Shutdown(deadline) != nil {
			_ = server.Close()
		}
		<-stopped
	}
}
