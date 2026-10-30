package httpapi

import (
	"net/http"
	"strings"
)

// Protect the Go surface itself, including deployments with a directly reachable API.
func protectedPortfolio(service *rwaService, auth *userAuthService) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		address := strings.ToLower(request.PathValue("address"))
		if !addressPattern.MatchString(address) {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid address", "A valid wallet address is required.")
			return
		}
		if err := auth.requireSeller(request, address, hoodiChainID); err != nil {
			auth.writeError(writer, request, err)
			return
		}
		service.getPortfolio(writer, request)
	}
}
