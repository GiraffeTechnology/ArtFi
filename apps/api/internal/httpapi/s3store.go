package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type s3ObjectStore struct {
	endpoint  *url.URL
	region    string
	bucket    string
	accessKey string
	secretKey string
	client    *http.Client
	now       func() time.Time
}

func newS3ObjectStoreFromEnv() (objectStore, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("R2_ENDPOINT")), "/")
	bucket := strings.TrimSpace(os.Getenv("R2_BUCKET"))
	accessKey := strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY"))
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		return nil, errors.New("object storage configuration incomplete")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && !loopbackHost(parsed.Hostname())) {
		return nil, errors.New("object storage endpoint must use HTTPS or loopback HTTP")
	}
	region := strings.TrimSpace(os.Getenv("R2_REGION"))
	if region == "" {
		region = "auto"
	}
	return &s3ObjectStore{
		endpoint:  parsed,
		region:    region,
		bucket:    bucket,
		accessKey: accessKey,
		secretKey: secretKey,
		client:    &http.Client{Timeout: 20 * time.Second},
		now:       func() time.Time { return time.Now().UTC() },
	}, nil
}

func (store *s3ObjectStore) Put(
	ctx context.Context,
	objectKey string,
	body []byte,
	contentType string,
	declaredSHA256 string,
) error {
	digest := sha256.Sum256(body)
	payloadHash := hex.EncodeToString(digest[:])
	if payloadHash != declaredSHA256 {
		return errors.New("object payload digest mismatch")
	}

	requestURL := *store.endpoint
	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/" + store.bucket + "/" + strings.TrimLeft(objectKey, "/")
	now := store.now()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")

	canonicalHeaders := "content-type:" + strings.TrimSpace(contentType) + "\n" +
		"host:" + requestURL.Host + "\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:" + amzDate + "\n" +
		"x-amz-meta-sha256:" + declaredSHA256 + "\n"
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256"
	canonicalRequest := http.MethodPut + "\n" + requestURL.EscapedPath() + "\n\n" +
		canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash
	requestDigest := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + store.region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(requestDigest[:])
	signature := hex.EncodeToString(hmacSHA256(store.signingKey(date), []byte(stringToSign)))
	authorization := "AWS4-HMAC-SHA256 Credential=" + store.accessKey + "/" + scope +
		", SignedHeaders=" + signedHeaders + ", Signature=" + signature

	request, err := http.NewRequestWithContext(ctx, http.MethodPut, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Meta-Sha256", declaredSHA256)
	request.Header.Set("Authorization", authorization)

	response, err := store.client.Do(request)
	if err != nil {
		return fmt.Errorf("object storage put: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("object storage put returned status %d", response.StatusCode)
	}
	return nil
}

func (store *s3ObjectStore) signingKey(date string) []byte {
	dateKey := hmacSHA256([]byte("AWS4"+store.secretKey), []byte(date))
	regionKey := hmacSHA256(dateKey, []byte(store.region))
	serviceKey := hmacSHA256(regionKey, []byte("s3"))
	return hmacSHA256(serviceKey, []byte("aws4_request"))
}

func hmacSHA256(key, data []byte) []byte {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write(data)
	return hash.Sum(nil)
}

func loopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
