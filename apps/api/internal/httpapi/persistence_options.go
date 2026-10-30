package httpapi

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

var errPersistencePoolConfig = errors.New("DB_POOL_CONFIGURATION_REFUSED")

// Endpoint, credentials and driver TLS parameters remain in the managed MYSQL_DSN.
// These settings configure a new pool; they do not authorize a runtime switch.
type persistencePoolOptions struct {
	maxOpen        int
	maxIdle        int
	maxLifetime    time.Duration
	maxIdleTime    time.Duration
	connectTimeout time.Duration
}

func persistencePoolOptionsFromEnv(getenv func(string) string) (persistencePoolOptions, error) {
	options := persistencePoolOptions{
		maxOpen: 10, maxIdle: 5, maxLifetime: 5 * time.Minute,
		maxIdleTime: 0, connectTimeout: 3 * time.Second,
	}
	if getenv == nil {
		return persistencePoolOptions{}, errPersistencePoolConfig
	}
	for _, setting := range []struct {
		key    string
		target *int
	}{
		{"ARTFI_DB_POOL_MAX_OPEN", &options.maxOpen},
		{"ARTFI_DB_POOL_MAX_IDLE", &options.maxIdle},
	} {
		value := strings.TrimSpace(getenv(setting.key))
		if value == "" {
			continue
		}
		for _, digit := range value {
			if digit < '0' || digit > '9' {
				return persistencePoolOptions{}, errPersistencePoolConfig
			}
		}
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil {
			return persistencePoolOptions{}, errPersistencePoolConfig
		}
		*setting.target = int(parsed)
	}
	for _, setting := range []struct {
		key    string
		target *time.Duration
	}{
		{"ARTFI_DB_POOL_MAX_LIFETIME", &options.maxLifetime},
		{"ARTFI_DB_POOL_MAX_IDLE_TIME", &options.maxIdleTime},
		{"ARTFI_DB_CONNECT_TIMEOUT", &options.connectTimeout},
	} {
		value := strings.TrimSpace(getenv(setting.key))
		if value == "" {
			continue
		}
		parsed, err := time.ParseDuration(value)
		if err != nil {
			return persistencePoolOptions{}, errPersistencePoolConfig
		}
		*setting.target = parsed
	}
	if options.maxOpen < 1 || options.maxOpen > 1000 || options.maxIdle < 0 || options.maxIdle > options.maxOpen ||
		options.maxLifetime < time.Second || options.maxLifetime > 24*time.Hour ||
		options.maxIdleTime < 0 || options.maxIdleTime > options.maxLifetime ||
		options.connectTimeout < 10*time.Millisecond || options.connectTimeout > time.Minute {
		return persistencePoolOptions{}, errPersistencePoolConfig
	}
	return options, nil
}

type configurablePersistencePool interface {
	SetMaxOpenConns(int)
	SetMaxIdleConns(int)
	SetConnMaxLifetime(time.Duration)
	SetConnMaxIdleTime(time.Duration)
}

func (options persistencePoolOptions) apply(pool configurablePersistencePool) {
	pool.SetMaxOpenConns(options.maxOpen)
	pool.SetMaxIdleConns(options.maxIdle)
	pool.SetConnMaxLifetime(options.maxLifetime)
	pool.SetConnMaxIdleTime(options.maxIdleTime)
}
