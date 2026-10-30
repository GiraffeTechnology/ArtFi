// artfi-migrate applies forward MySQL migrations without relying on onsite source builds.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type migration struct {
	Name     string `json:"name"`
	Checksum string `json:"checksum"`
	Applied  bool   `json:"applied"`
	Dirty    bool   `json:"dirty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Migration error:", err)
		os.Exit(1)
	}
}
func run() error {
	directory := flag.String("directory", "migrations", "directory containing ordered .up.sql files")
	action := flag.String("action", "status", "status or up; application rollback never drops schema")
	flag.Parse()
	if *action != "up" && *action != "status" {
		return errors.New("action must be up or status")
	}
	cfg, err := mysql.ParseDSN(os.Getenv("MYSQL_DSN"))
	if err != nil || cfg.DBName == "" {
		return errors.New("MYSQL_DSN must select an existing database")
	}
	cfg.MultiStatements = true
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return errors.New("database configuration is invalid")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return errors.New("cannot connect to database; check the protected DSN and database availability")
	}
	defer conn.Close()
	var lock int
	// A connection-scoped advisory lock prevents two installers from advancing the same schema.
	if err = conn.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('artfi-schema:', DATABASE()), 30)").Scan(&lock); err != nil || lock != 1 {
		return errors.New("cannot acquire the schema migration lock")
	}
	defer conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK(CONCAT('artfi-schema:', DATABASE()))")
	var count int
	if err = conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='artfi_schema_migrations'").Scan(&count); err != nil {
		return errors.New("cannot inspect migration ledger")
	}
	if count == 0 && *action == "up" {
		// Never guess the version of a database created outside this installer.
		var existing int
		if err = conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()").Scan(&existing); err != nil {
			return errors.New("cannot inspect existing schema")
		}
		if existing > 0 {
			return errors.New("existing schema has no migration ledger; use a reviewed baseline/restore procedure rather than replaying migrations")
		}
		_, err = conn.ExecContext(ctx, "CREATE TABLE artfi_schema_migrations (name VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, checksum CHAR(64) NOT NULL, dirty BOOLEAN NOT NULL, applied_at TIMESTAMP(6) NULL)")
		if err != nil {
			return errors.New("cannot create migration ledger; check schema privileges")
		}
		count = 1
	}
	stored := map[string]migration{}
	if count > 0 {
		rows, err := conn.QueryContext(ctx, "SELECT name, checksum, dirty FROM artfi_schema_migrations")
		if err != nil {
			return errors.New("cannot read migration ledger")
		}
		for rows.Next() {
			var m migration
			if err = rows.Scan(&m.Name, &m.Checksum, &m.Dirty); err != nil {
				rows.Close()
				return errors.New("invalid migration ledger")
			}
			m.Applied = !m.Dirty
			stored[m.Name] = m
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return errors.New("cannot finish reading migration ledger")
		}
	}
	files, err := filepath.Glob(filepath.Join(*directory, "*.up.sql"))
	if err != nil || len(files) == 0 {
		return errors.New("no forward migrations found")
	}
	sort.Strings(files)
	all := []migration{}
	pending := 0
	for _, file := range files {
		name := filepath.Base(file)
		body, err := os.ReadFile(file)
		if err != nil {
			return fmt.Errorf("cannot read migration %s", name)
		}
		sum := sha256.Sum256(body)
		m := migration{Name: name, Checksum: hex.EncodeToString(sum[:])}
		if old, ok := stored[name]; ok {
			if old.Checksum != m.Checksum {
				return fmt.Errorf("migration checksum changed: %s", name)
			}
			if old.Dirty {
				return fmt.Errorf("incomplete migration %s requires operator recovery; MySQL DDL is not transactionally reversible", name)
			}
			m.Applied = true
			delete(stored, name)
		} else {
			pending++
			if *action == "up" {
				if _, err = conn.ExecContext(ctx, "INSERT INTO artfi_schema_migrations (name, checksum, dirty) VALUES (?, ?, TRUE)", name, m.Checksum); err != nil {
					return fmt.Errorf("cannot record migration %s", name)
				}
				if _, err = conn.ExecContext(ctx, string(body)); err != nil {
					return fmt.Errorf("migration %s failed; ledger remains dirty; inspect server error securely and restore/repair before retry", name)
				}
				if _, err = conn.ExecContext(ctx, "UPDATE artfi_schema_migrations SET dirty=FALSE, applied_at=CURRENT_TIMESTAMP(6) WHERE name=?", name); err != nil {
					return fmt.Errorf("cannot finish migration ledger for %s", name)
				}
				m.Applied = true
				pending--
			}
		}
		all = append(all, m)
	}
	newer := []string{}
	for name, m := range stored {
		if m.Dirty {
			return fmt.Errorf("incomplete migration %s requires recovery", name)
		}
		newer = append(newer, name)
	}
	sort.Strings(newer)
	// Older application releases can inspect a forward-compatible schema during rollback.
	output := map[string]any{"action": *action, "migrations": all, "pending": pending, "newerMigrations": newer, "databaseConnected": true}
	if strings.TrimSpace(cfg.DBName) == "" {
		return errors.New("database not selected")
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}
