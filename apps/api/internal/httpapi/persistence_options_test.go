package httpapi

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPersistencePoolDefaultsPreserveStartupBehavior(t *testing.T) {
	options, err := persistencePoolOptionsFromEnv(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if options.maxOpen != 10 || options.maxIdle != 5 || options.maxLifetime != 5*time.Minute ||
		options.maxIdleTime != 0 || options.connectTimeout != 3*time.Second {
		t.Fatal("default pool behavior changed")
	}
}

func TestPersistencePoolManagedOptions(t *testing.T) {
	values := map[string]string{
		"ARTFI_DB_POOL_MAX_OPEN": "20", "ARTFI_DB_POOL_MAX_IDLE": "4",
		"ARTFI_DB_POOL_MAX_LIFETIME": "10m", "ARTFI_DB_POOL_MAX_IDLE_TIME": "30s",
		"ARTFI_DB_CONNECT_TIMEOUT": "500ms",
	}
	options, err := persistencePoolOptionsFromEnv(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	pool := &recordingPersistencePool{}
	options.apply(pool)
	if pool.maxOpen != 20 || pool.maxIdle != 4 || pool.maxLifetime != 10*time.Minute ||
		pool.maxIdleTime != 30*time.Second || options.connectTimeout != 500*time.Millisecond {
		t.Fatal("managed pool options were not applied")
	}
}

func TestPersistencePoolRefusesInvalidAndUnboundedConfiguration(t *testing.T) {
	cases := []struct{ key, value string }{
		{"ARTFI_DB_POOL_MAX_OPEN", "0"}, {"ARTFI_DB_POOL_MAX_OPEN", "1001"},
		{"ARTFI_DB_POOL_MAX_OPEN", "-1"}, {"ARTFI_DB_POOL_MAX_OPEN", "+10"},
		{"ARTFI_DB_POOL_MAX_OPEN", "1.5"}, {"ARTFI_DB_POOL_MAX_OPEN", "9999999999999999999999"},
		{"ARTFI_DB_POOL_MAX_IDLE", "11"}, {"ARTFI_DB_POOL_MAX_IDLE", "-1"},
		{"ARTFI_DB_POOL_MAX_LIFETIME", "0"}, {"ARTFI_DB_POOL_MAX_LIFETIME", "25h"},
		{"ARTFI_DB_POOL_MAX_IDLE_TIME", "-1s"}, {"ARTFI_DB_POOL_MAX_IDLE_TIME", "6m"},
		{"ARTFI_DB_CONNECT_TIMEOUT", "0"}, {"ARTFI_DB_CONNECT_TIMEOUT", "61s"},
		{"ARTFI_DB_CONNECT_TIMEOUT", "NaN"}, {"ARTFI_DB_CONNECT_TIMEOUT", "SYNTHETIC_SECRET_MARKER"},
	}
	for _, item := range cases {
		t.Run(item.key+"/"+item.value, func(t *testing.T) {
			_, err := persistencePoolOptionsFromEnv(func(key string) string {
				if key == item.key {
					return item.value
				}
				return ""
			})
			if !errors.Is(err, errPersistencePoolConfig) || strings.Contains(err.Error(), "SYNTHETIC_SECRET_MARKER") {
				t.Fatal("invalid configuration did not produce a bounded error")
			}
		})
	}
}

type recordingPersistencePool struct {
	maxOpen     int
	maxIdle     int
	maxLifetime time.Duration
	maxIdleTime time.Duration
}

func (pool *recordingPersistencePool) SetMaxOpenConns(value int) { pool.maxOpen = value }
func (pool *recordingPersistencePool) SetMaxIdleConns(value int) { pool.maxIdle = value }
func (pool *recordingPersistencePool) SetConnMaxLifetime(value time.Duration) {
	pool.maxLifetime = value
}
func (pool *recordingPersistencePool) SetConnMaxIdleTime(value time.Duration) {
	pool.maxIdleTime = value
}
