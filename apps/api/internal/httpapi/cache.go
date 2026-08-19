package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	cacheKeyPrefix = "artfi:v1"
	cacheTTL       = 30 * time.Second
)

var errCacheMiss = errors.New("cache miss")

type cacheStore interface {
	Get(context.Context, string) (string, error)
	Set(context.Context, string, string, time.Duration) error
	Increment(context.Context, string) error
}

type redisCacheStore struct {
	client *redis.Client
}

type cacheToken struct {
	identity  string
	namespace string
	version   string
}

func (store *redisCacheStore) Get(ctx context.Context, key string) (string, error) {
	value, err := store.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", errCacheMiss
	}
	return value, err
}

func (store *redisCacheStore) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return store.client.Set(ctx, key, value, ttl).Err()
}

func (store *redisCacheStore) Increment(ctx context.Context, key string) error {
	pipe := store.client.TxPipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, 2*cacheTTL)
	_, err := pipe.Exec(ctx)
	return err
}

func (service *rwaService) attachCache(redisURL string) {
	if redisURL == "" {
		return
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		slog.Error("parse Redis cache URL", "error", err)
		return
	}
	client := redis.NewClient(options)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		slog.Error("ping Redis cache", "error", err)
		return
	}
	service.cache = &redisCacheStore{client: client}
}

func (service *rwaService) loadCachedJSON(ctx context.Context, namespace, identity string, target any) (cacheToken, bool) {
	if service.cache == nil {
		return cacheToken{}, false
	}
	version := "0"
	storedVersion, err := service.cache.Get(ctx, cacheVersionKey(namespace))
	if err == nil {
		version = storedVersion
	} else if !errors.Is(err, errCacheMiss) {
		slog.Warn("cache version read failed", "namespace", namespace, "error", err)
		return cacheToken{}, false
	}
	token := cacheToken{identity: identity, namespace: namespace, version: version}
	payload, err := service.cache.Get(ctx, cacheResponseKey(token))
	if errors.Is(err, errCacheMiss) {
		return token, false
	}
	if err != nil {
		slog.Warn("cache response read failed", "namespace", namespace, "error", err)
		return cacheToken{}, false
	}
	if err := json.Unmarshal([]byte(payload), target); err != nil {
		slog.Warn("cache response decode failed", "namespace", namespace, "error", err)
		return token, false
	}
	return token, true
}

func (service *rwaService) storeCachedJSON(ctx context.Context, token cacheToken, value any) {
	if service.cache == nil || token.namespace == "" {
		return
	}
	payload, err := json.Marshal(value)
	if err != nil {
		slog.Warn("cache response encode failed", "namespace", token.namespace, "error", err)
		return
	}
	if err := service.cache.Set(ctx, cacheResponseKey(token), string(payload), cacheTTL); err != nil {
		slog.Warn("cache response write failed", "namespace", token.namespace, "error", err)
	}
}

func (service *rwaService) bumpCacheNamespace(ctx context.Context, namespace string) {
	if service.cache == nil {
		return
	}
	if err := service.cache.Increment(ctx, cacheVersionKey(namespace)); err != nil {
		slog.Warn("cache invalidation failed", "namespace", namespace, "error", err)
	}
}

func (service *rwaService) invalidatePortfolioCache(ctx context.Context, input chainEventRequest) {
	if input.EventName != "Transfer" {
		return
	}
	for _, field := range []string{"from", "to"} {
		address, ok := input.Payload[field].(string)
		if !ok || !addressPattern.MatchString(address) {
			continue
		}
		address = strings.ToLower(address)
		if address != "0x0000000000000000000000000000000000000000" {
			service.bumpCacheNamespace(ctx, "portfolio:"+address)
		}
	}
}

func cacheVersionKey(namespace string) string {
	return cacheKeyPrefix + ":version:" + namespace
}

func cacheResponseKey(token cacheToken) string {
	digest := sha256.Sum256([]byte(token.identity))
	return cacheKeyPrefix + ":response:" + token.namespace + ":" + token.version + ":" + hex.EncodeToString(digest[:])
}
