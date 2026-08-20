package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/GiraffeTechnology/ArtFi/apps/api/internal/httpapi"
)

func main() {
	address := os.Getenv("ARTFI_API_ADDR")
	if address == "" {
		address = ":8080"
	}

	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.NewHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	slog.Info("ArtFi API starting", "address", address)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("ArtFi API stopped", "error", err)
		os.Exit(1)
	}
}
