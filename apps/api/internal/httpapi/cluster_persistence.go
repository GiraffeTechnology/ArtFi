package httpapi

import (
	"context"
	"database/sql"
	"errors"
	mysql "github.com/go-sql-driver/mysql"
	"strings"
	"time"
)

// A process-local cache is never the authority for an operation shared by API
// instances. Prepared uploads and Vault requests are read through the primary DB.
func (service *rwaService) readUpload(ctx context.Context, id string) (*uploadSession, error) {
	if service.db == nil {
		service.mu.RLock()
		defer service.mu.RUnlock()
		if value := service.uploads[id]; value != nil {
			copy := *value
			return &copy, nil
		}
		return nil, sql.ErrNoRows
	}
	rows, err := service.db.QueryContext(ctx, `SELECT upload_id,object_key,file_name,content_type,LOWER(HEX(sha256)),size_bytes,status='uploaded',created_at FROM rwa_uploads WHERE upload_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}
	value := &uploadSession{}
	if err = rows.Scan(&value.ID, &value.ObjectKey, &value.FileName, &value.ContentType, &value.SHA256, &value.Size, &value.Completed, &value.CreatedAt); err != nil {
		return nil, err
	}
	return value, nil
}

func (service *rwaService) readVaultIntent(ctx context.Context, id string) (*vaultIntent, error) {
	if service.db == nil {
		service.mu.RLock()
		defer service.mu.RUnlock()
		if value := service.vaultIntents[id]; value != nil {
			copy := *value
			return &copy, nil
		}
		return nil, sql.ErrNoRows
	}
	return service.readVaultBy(ctx, "vault_id", id)
}
func (service *rwaService) readVaultBy(ctx context.Context, column, value string) (*vaultIntent, error) {
	if column != "vault_id" && column != "idempotency_key_hash" {
		return nil, errors.New("invalid internal Vault lookup")
	}
	predicate := column + "=?"
	if column == "idempotency_key_hash" {
		predicate = column + "=UNHEX(?)"
	}
	rows, err := service.db.QueryContext(ctx, `SELECT vault_id,CONCAT('0x',LOWER(HEX(request_id))),LOWER(HEX(idempotency_key_hash)),LOWER(HEX(payload_hash)),factory_address,collection_address,token_id,vault_name,admin_address,pauser_address,fractionalizer_address,status,COALESCE(transaction_hash,''),created_at FROM vaults WHERE `+predicate, value)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}
	intent := &vaultIntent{ChainID: hoodiChainID, ContractFunction: "createVault(bytes32,string,address,uint256,address,address,address)"}
	var created time.Time
	if err = rows.Scan(&intent.IntentID, &intent.RequestID, &intent.idempotencyKeyHash, &intent.payloadHash, &intent.FactoryAddress, &intent.CollectionAddress, &intent.TokenID, &intent.VaultName, &intent.AdminAddress, &intent.PauserAddress, &intent.FractionalizerAddress, &intent.Status, &intent.TransactionHash, &created); err != nil {
		return nil, err
	}
	intent.CreatedAt = created.UTC().Format(time.RFC3339)
	intent.ContractArguments = []string{intent.RequestID, intent.VaultName, intent.CollectionAddress, intent.TokenID, intent.AdminAddress, intent.PauserAddress, intent.FractionalizerAddress}
	return intent, nil
}
func (service *rwaService) persistOrReadVault(ctx context.Context, intent *vaultIntent) (*vaultIntent, bool, error) {
	err := service.persistVaultIntent(ctx, intent)
	if err == nil {
		return intent, true, nil
	}
	var duplicate *mysql.MySQLError
	if !errors.As(err, &duplicate) || duplicate.Number != 1062 {
		return nil, false, err
	}
	current, err := service.readVaultBy(ctx, "idempotency_key_hash", intent.idempotencyKeyHash)
	if err != nil {
		return nil, false, err
	}
	if current.payloadHash != intent.payloadHash || !strings.EqualFold(current.FactoryAddress, intent.FactoryAddress) || current.RequestID != intent.RequestID {
		return nil, false, adminError(409, "This key was already used for a different Vault request or factory.")
	}
	return current, false, nil
}

var errVaultSubmissionConflict = errors.New("Vault submission conflicts with the recorded transaction")
