package httpapi

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type persistenceDB interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (service *rwaService) attachPersistence(dsn string) {
	if dsn == "" {
		return
	}
	options, err := persistencePoolOptionsFromEnv(os.Getenv)
	if err != nil {
		slog.Error("persistence unavailable", "stage", "configuration", "code", "DB_POOL_CONFIGURATION_REFUSED")
		return
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		slog.Error("persistence unavailable", "stage", "open", "code", "DB_OPEN_FAILED")
		return
	}
	options.apply(db)
	ctx, cancel := context.WithTimeout(context.Background(), options.connectTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		slog.Error("persistence unavailable", "stage", "ping", "code", "DB_PING_FAILED")
		return
	}
	service.db = db
	if err := service.hydratePersistence(ctx); err != nil {
		service.db = nil
		_ = db.Close()
		slog.Error("persistence unavailable", "stage", "hydrate", "code", "DB_HYDRATE_FAILED")
	}
}

func (service *rwaService) hydratePersistence(ctx context.Context) error {
	uploadRows, err := service.db.QueryContext(ctx, `
		SELECT upload_id, object_key, file_name, content_type, LOWER(HEX(sha256)), size_bytes,
		       status = 'uploaded', created_at
		FROM rwa_uploads
		WHERE status IN ('pending', 'uploaded')`)
	if err != nil {
		return err
	}
	defer uploadRows.Close()
	for uploadRows.Next() {
		session := &uploadSession{}
		if err := uploadRows.Scan(
			&session.ID,
			&session.ObjectKey,
			&session.FileName,
			&session.ContentType,
			&session.SHA256,
			&session.Size,
			&session.Completed,
			&session.CreatedAt,
		); err != nil {
			return err
		}
		service.uploads[session.ID] = session
	}
	if err := uploadRows.Err(); err != nil {
		return err
	}

	intentRows, err := service.db.QueryContext(ctx, `
		SELECT intent_id, LOWER(HEX(idempotency_key_hash)), COALESCE(LOWER(HEX(payload_hash)), ''),
		       CONCAT('0x', LOWER(HEX(request_id))), upload_id, recipient, registry_address, chain_id,
		       metadata_uri, CONCAT('0x', LOWER(HEX(metadata_sha256))), status,
		       COALESCE(transaction_hash, ''), created_at
		FROM rwa_mint_intents`)
	if err != nil {
		return err
	}
	defer intentRows.Close()
	for intentRows.Next() {
		intent := &mintIntent{ContractFunction: "createAsset(bytes32,address,string,bytes32)"}
		var createdAt time.Time
		if err := intentRows.Scan(
			&intent.IntentID,
			&intent.idempotencyKeyHash,
			&intent.payloadHash,
			&intent.RequestID,
			&intent.uploadID,
			&intent.Recipient,
			&intent.RegistryAddress,
			&intent.ChainID,
			&intent.MetadataURI,
			&intent.MetadataSHA256,
			&intent.Status,
			&intent.TransactionHash,
			&createdAt,
		); err != nil {
			return err
		}
		intent.ContractArguments = []string{
			intent.RequestID, intent.Recipient, intent.MetadataURI, intent.MetadataSHA256,
		}
		intent.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		service.intents[intent.IntentID] = intent
		service.intentByKey[intent.idempotencyKeyHash] = intent.IntentID
	}
	if err := intentRows.Err(); err != nil {
		return err
	}

	vaultRows, err := service.db.QueryContext(ctx, `
		SELECT vault_id, CONCAT('0x', LOWER(HEX(request_id))), LOWER(HEX(idempotency_key_hash)),
		       LOWER(HEX(payload_hash)), factory_address, collection_address, token_id, vault_name,
		       admin_address, pauser_address, fractionalizer_address, status,
		       COALESCE(transaction_hash, ''), created_at
		FROM vaults`)
	if err != nil {
		return err
	}
	defer vaultRows.Close()
	for vaultRows.Next() {
		intent := &vaultIntent{
			ChainID:          hoodiChainID,
			ContractFunction: "createVault(bytes32,string,address,uint256,address,address,address)",
		}
		var createdAt time.Time
		if err := vaultRows.Scan(
			&intent.IntentID,
			&intent.RequestID,
			&intent.idempotencyKeyHash,
			&intent.payloadHash,
			&intent.FactoryAddress,
			&intent.CollectionAddress,
			&intent.TokenID,
			&intent.VaultName,
			&intent.AdminAddress,
			&intent.PauserAddress,
			&intent.FractionalizerAddress,
			&intent.Status,
			&intent.TransactionHash,
			&createdAt,
		); err != nil {
			return err
		}
		intent.ContractArguments = []string{
			intent.RequestID, intent.VaultName, intent.CollectionAddress, intent.TokenID,
			intent.AdminAddress, intent.PauserAddress, intent.FractionalizerAddress,
		}
		intent.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		service.vaultIntents[intent.IntentID] = intent
		service.vaultIntentByKey[intent.idempotencyKeyHash] = intent.IntentID
	}
	if err := vaultRows.Err(); err != nil {
		return err
	}
	vaultRows.Close()
	return service.hydrateMintEvidence(ctx)
}

func (service *rwaService) persistUpload(ctx context.Context, upload *uploadSession) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	_, err := service.db.ExecContext(ctx, `
		INSERT INTO rwa_uploads
		    (upload_id, object_key, file_name, content_type, size_bytes, sha256, status, created_at)
		VALUES (?, ?, ?, ?, ?, UNHEX(?), 'pending', ?)`,
		upload.ID,
		upload.ObjectKey,
		upload.FileName,
		upload.ContentType,
		upload.Size,
		upload.SHA256,
		upload.CreatedAt,
	)
	return err
}

func (service *rwaService) persistUploadCompletion(ctx context.Context, uploadID string) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	_, err := service.db.ExecContext(ctx, `
		UPDATE rwa_uploads SET status = 'uploaded', completed_at = CURRENT_TIMESTAMP(6)
		WHERE upload_id = ? AND status IN ('pending', 'uploaded')`, uploadID)
	return err
}

func (service *rwaService) persistMintIntent(ctx context.Context, intent *mintIntent) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	metadataHash := strings.TrimPrefix(intent.MetadataSHA256, "0x")
	requestID := strings.TrimPrefix(intent.RequestID, "0x")
	if _, err := hex.DecodeString(metadataHash); err != nil {
		return err
	}
	createdAt, err := time.Parse(time.RFC3339, intent.CreatedAt)
	if err != nil {
		return err
	}
	_, err = service.db.ExecContext(ctx, `
		INSERT INTO rwa_mint_intents
		    (intent_id, idempotency_key_hash, payload_hash, request_id, upload_id, recipient,
		     registry_address, chain_id, metadata_uri, metadata_sha256, status, created_at)
		VALUES (?, UNHEX(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, UNHEX(?), 'prepared', ?)`,
		intent.IntentID,
		intent.idempotencyKeyHash,
		intent.payloadHash,
		requestID,
		intent.uploadID,
		intent.Recipient,
		intent.RegistryAddress,
		intent.ChainID,
		intent.MetadataURI,
		metadataHash,
		createdAt,
	)
	return err
}

func (service *rwaService) persistSubmission(ctx context.Context, intentID, transactionHash string) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	result, err := service.db.ExecContext(ctx, `
		UPDATE rwa_mint_intents
		SET status = 'submitted', transaction_hash = ?
		WHERE intent_id = ? AND (transaction_hash IS NULL OR LOWER(transaction_hash) = LOWER(?))`,
		transactionHash,
		intentID,
		transactionHash,
	)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		current, err := service.db.QueryContext(ctx, "SELECT transaction_hash FROM rwa_mint_intents WHERE intent_id=?", intentID)
		if err != nil {
			return err
		}
		defer current.Close()
		var stored string
		if current.Next() {
			if err = current.Scan(&stored); err != nil {
				return err
			}
			if strings.EqualFold(stored, transactionHash) {
				return nil
			}
		}
		if err = current.Err(); err != nil {
			return err
		}
		return adminError(409, "A different submission is already bound to this mint intent.")
	}
	return nil
}

func (service *rwaService) persistVaultIntent(ctx context.Context, intent *vaultIntent) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	createdAt, err := time.Parse(time.RFC3339, intent.CreatedAt)
	if err != nil {
		return err
	}
	_, err = service.db.ExecContext(ctx, `
		INSERT INTO vaults
		    (vault_id, request_id, idempotency_key_hash, payload_hash, factory_address,
		     collection_address, token_id, vault_name, admin_address, pauser_address,
		     fractionalizer_address, status, created_at)
		VALUES (?, UNHEX(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
		intent.IntentID,
		strings.TrimPrefix(intent.RequestID, "0x"),
		intent.idempotencyKeyHash,
		intent.payloadHash,
		intent.FactoryAddress,
		intent.CollectionAddress,
		intent.TokenID,
		intent.VaultName,
		intent.AdminAddress,
		intent.PauserAddress,
		intent.FractionalizerAddress,
		createdAt,
	)
	return err
}

func (service *rwaService) persistVaultSubmission(ctx context.Context, intentID, transactionHash string) error {
	if service.db == nil {
		return service.persistenceRequirement()
	}
	result, err := service.db.ExecContext(ctx, `
		UPDATE vaults SET status = 'submitted', transaction_hash = ?
		WHERE vault_id = ? AND (transaction_hash IS NULL OR LOWER(transaction_hash) = LOWER(?))`,
		transactionHash, intentID, transactionHash)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		current, err := service.readVaultIntent(ctx, intentID)
		if err != nil {
			return err
		}
		if !strings.EqualFold(current.TransactionHash, transactionHash) {
			return errVaultSubmissionConflict
		}
	}
	return nil
}

func (service *rwaService) persistenceRequirement() error {
	if service.requireDB {
		return errors.New("durable persistence is required")
	}
	return nil
}
