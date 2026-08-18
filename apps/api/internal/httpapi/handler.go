package httpapi

import (
	"encoding/json"
	"net/http"
)

type statusResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
	Version string `json:"version"`
}

func NewHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", status("ok"))
	mux.HandleFunc("GET /readyz", status("ready"))
	return mux
}

func status(state string) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(writer).Encode(statusResponse{
			Service: "artfi-api",
			Status:  state,
			Version: "0.0.0",
		})
	}
}
