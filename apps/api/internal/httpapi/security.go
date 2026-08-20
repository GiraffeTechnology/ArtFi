package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

func (service *rwaService) operatorProtected(request *http.Request) bool {
	if !service.requireOperator || request.Method == http.MethodGet || request.Method == http.MethodOptions {
		return false
	}
	for _, prefix := range []string{"/v1/uploads/", "/v1/rwa/", "/v1/vault/"} {
		if strings.HasPrefix(request.URL.Path, prefix) {
			return true
		}
	}
	return false
}

func (service *rwaService) authorizeOperator(request *http.Request) bool {
	if !service.operatorEnabled {
		return false
	}
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	if !strings.HasPrefix(authorization, "Bearer ") {
		return false
	}
	provided := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
	if len(provided) < 24 || len(provided) > 512 {
		return false
	}
	digest := sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(digest[:], service.operatorKeyHash[:]) == 1
}
