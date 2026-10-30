package httpapi

import (
	"context"
	"net/http"
	"time"
)

// Liveness describes the process. Readiness additionally requires the mandatory primary
// database. Optional venue, storage and chain features keep their own unavailable states.
func (service *rwaService) readiness(writer http.ResponseWriter, request *http.Request) {
	if service.requireDB {
		if service.db == nil {
			writeJSON(writer, http.StatusServiceUnavailable, statusResponse{Service: "artfi-api", Status: "not_ready", Version: "0.1.0"})
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		rows, err := service.db.QueryContext(ctx, "SELECT 1")
		if err != nil {
			writeJSON(writer, http.StatusServiceUnavailable, statusResponse{Service: "artfi-api", Status: "not_ready", Version: "0.1.0"})
			return
		}
		defer rows.Close()
		var reachable int
		if !rows.Next() || rows.Scan(&reachable) != nil || reachable != 1 {
			writeJSON(writer, http.StatusServiceUnavailable, statusResponse{Service: "artfi-api", Status: "not_ready", Version: "0.1.0"})
			return
		}
	}
	writeJSON(writer, http.StatusOK, statusResponse{Service: "artfi-api", Status: "ready", Version: "0.1.0"})
}
