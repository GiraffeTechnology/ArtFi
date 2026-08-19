package httpapi

import (
	"context"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"
)

type memoryCache struct {
	values       map[string]string
	getErr       error
	setErr       error
	incrementErr error
}

func (cache *memoryCache) Get(_ context.Context, key string) (string, error) {
	if cache.getErr != nil {
		return "", cache.getErr
	}
	value, ok := cache.values[key]
	if !ok {
		return "", errCacheMiss
	}
	return value, nil
}

func (cache *memoryCache) Set(_ context.Context, key, value string, _ time.Duration) error {
	if cache.setErr != nil {
		return cache.setErr
	}
	cache.values[key] = value
	return nil
}

func (cache *memoryCache) Increment(_ context.Context, key string) error {
	if cache.incrementErr != nil {
		return cache.incrementErr
	}
	current := cache.values[key]
	if current == "" {
		cache.values[key] = "1"
	} else {
		cache.values[key] = "2"
	}
	return nil
}

func TestVersionedCacheInvalidationCannotReuseStaleResponse(t *testing.T) {
	cache := &memoryCache{values: map[string]string{}}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.cache = cache
	ctx := context.Background()

	var first map[string]string
	token, hit := service.loadCachedJSON(ctx, "market", "source=opensea", &first)
	if hit {
		t.Fatal("empty cache unexpectedly hit")
	}
	service.storeCachedJSON(ctx, token, map[string]string{"event": "old"})
	if _, hit := service.loadCachedJSON(ctx, "market", "source=opensea", &first); !hit || first["event"] != "old" {
		t.Fatal("stored response was not returned")
	}

	service.bumpCacheNamespace(ctx, "market")
	var afterInvalidation map[string]string
	newToken, hit := service.loadCachedJSON(ctx, "market", "source=opensea", &afterInvalidation)
	if hit {
		t.Fatal("response from the previous namespace version remained visible")
	}
	if newToken.version == token.version {
		t.Fatal("invalidation did not advance the namespace version")
	}

	service.storeCachedJSON(ctx, token, map[string]string{"event": "late-stale-write"})
	if _, hit := service.loadCachedJSON(ctx, "market", "source=opensea", &afterInvalidation); hit {
		t.Fatal("a late database response repopulated the new cache generation")
	}
}

func TestCacheFailuresBypassWithoutBreakingReadModel(t *testing.T) {
	cache := &memoryCache{values: map[string]string{}, getErr: errors.New("Redis unavailable")}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.cache = cache

	var response map[string]string
	token, hit := service.loadCachedJSON(context.Background(), "portfolio:0x1", "", &response)
	if hit || token.namespace != "" {
		t.Fatal("cache errors must produce a clean database bypass")
	}

	cache.getErr = nil
	cache.setErr = errors.New("Redis write unavailable")
	token, _ = service.loadCachedJSON(context.Background(), "portfolio:0x1", "", &response)
	service.storeCachedJSON(context.Background(), token, map[string]string{"balance": "1"})
	if len(cache.values) != 0 {
		t.Fatal("failed cache writes must not create a partial value")
	}

	cache.incrementErr = errors.New("Redis invalidation unavailable")
	service.bumpCacheNamespace(context.Background(), "portfolio:0x1")
}

func TestTransferInvalidatesOnlyNonZeroParticipants(t *testing.T) {
	cache := &memoryCache{values: map[string]string{}}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.cache = cache
	to := "0x2222222222222222222222222222222222222222"
	service.invalidatePortfolioCache(context.Background(), chainEventRequest{
		EventName: "Transfer",
		Payload: map[string]any{
			"from": "0x0000000000000000000000000000000000000000",
			"to":   to,
		},
	})
	if cache.values[cacheVersionKey("portfolio:"+to)] != "1" {
		t.Fatal("recipient portfolio cache was not invalidated")
	}
	if _, ok := cache.values[cacheVersionKey("portfolio:0x0000000000000000000000000000000000000000")]; ok {
		t.Fatal("zero address must not receive a cache namespace")
	}
}

func TestRedisCacheStoreIntegration(t *testing.T) {
	redisURL := os.Getenv("ARTFI_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("ARTFI_TEST_REDIS_URL is not set")
	}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.attachCache(redisURL)
	if service.cache == nil {
		t.Fatal("test Redis cache did not connect")
	}
	namespace := "integration:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	ctx := context.Background()
	var response map[string]string
	token, hit := service.loadCachedJSON(ctx, namespace, "query", &response)
	if hit {
		t.Fatal("unique integration namespace unexpectedly hit")
	}
	service.storeCachedJSON(ctx, token, map[string]string{"status": "cached"})
	if _, hit := service.loadCachedJSON(ctx, namespace, "query", &response); !hit || response["status"] != "cached" {
		t.Fatal("Redis cache did not return the stored response")
	}
	service.bumpCacheNamespace(ctx, namespace)
	if _, hit := service.loadCachedJSON(ctx, namespace, "query", &response); hit {
		t.Fatal("Redis namespace bump did not invalidate the response")
	}
}
