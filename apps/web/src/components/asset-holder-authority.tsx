"use client";

import { useQuery } from "@tanstack/react-query";

import {
  oracleReadMessages,
  oracleReadResponseSchema,
  type OracleProjection,
  type OracleReadResponse,
} from "@/lib/oracle-read-model";

import { oracleReadView } from "@/lib/oracle-read-state";

import styles from "./asset-holder-authority.module.css";

type Certificate = OracleProjection["asset"]["currentCertificate"];

function CertificateFacts({ certificate }: { certificate: Certificate }) {
  if (!certificate)
    return <p>No current certificate is returned by this read.</p>;
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Certificate version</dt>
        <dd>{certificate.certificateVersion}</dd>
      </div>
      <div>
        <dt>Certificate hash</dt>
        <dd>{certificate.certificateHash}</dd>
      </div>
      <div>
        <dt>Certificate status</dt>
        <dd>{certificate.status}</dd>
      </div>
      <div>
        <dt>Effective at</dt>
        <dd>{certificate.effectiveAt}</dd>
      </div>
      {certificate.supersededAt && (
        <div>
          <dt>Superseded at</dt>
          <dd>{certificate.supersededAt}</dd>
        </div>
      )}
      <div>
        <dt>Registry change reference</dt>
        <dd>{certificate.wenbaoChangeRef}</dd>
      </div>
    </dl>
  );
}

function OracleFacts({ projection }: { projection: OracleProjection }) {
  const { token, asset, readAt } = projection;
  const certificateDiffers =
    token.currentCertificate?.certificateHash !==
      asset.currentCertificate?.certificateHash ||
    token.currentCertificate?.certificateVersion !==
      asset.currentCertificate?.certificateVersion ||
    token.currentCertificate?.status !== asset.currentCertificate?.status;
  const viewsDiffer =
    token.status !== asset.status ||
    asset.status !== asset.asset.oracleStatus ||
    certificateDiffers ||
    (asset.currentCertificate !== null &&
      (asset.currentCertificate.certificateHash !==
        asset.asset.currentCertificateHash ||
        asset.currentCertificate.certificateVersion !==
          asset.asset.currentCertificateVersion));
  return (
    <div data-testid="oracle-facts">
      {viewsDiffer && (
        <p role="status" className={styles.warning}>
          These Oracle views differ. They are separate reads, not an atomic
          snapshot. Refresh to check again; ArtFi does not choose one as the
          authority.
        </p>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>Token binding</dt>
          <dd>
            Chain {token.binding.chainId} · {token.binding.contract} · Token{" "}
            {token.binding.tokenId}
          </dd>
        </div>
        <div>
          <dt>Oracle asset ID</dt>
          <dd>{token.binding.assetId}</dd>
        </div>
        <div>
          <dt>Token Oracle status</dt>
          <dd>{token.status}</dd>
        </div>
        <div>
          <dt>Asset Oracle status</dt>
          <dd>{asset.status}</dd>
        </div>
        <div>
          <dt>Asset record status</dt>
          <dd>{asset.asset.oracleStatus}</dd>
        </div>
        <div>
          <dt>Registry record reference</dt>
          <dd>{asset.asset.wenbaoRegistryRef}</dd>
        </div>
        <div>
          <dt>Asset record updated at</dt>
          <dd>{asset.asset.updatedAt}</dd>
        </div>
        <div>
          <dt>Oracle-reported transfer eligibility</dt>
          <dd>{asset.asset.transferEligibility}</dd>
        </div>
        <div>
          <dt>Asset encumbrance status</dt>
          <dd>{asset.asset.encumbranceStatus || "Not supplied"}</dd>
        </div>
        <div>
          <dt>Asset certificate hash / version</dt>
          <dd>
            {asset.asset.currentCertificateHash} /{" "}
            {asset.asset.currentCertificateVersion}
          </dd>
        </div>
      </dl>
      <h4>Current certificate · asset read</h4>
      <CertificateFacts certificate={asset.currentCertificate} />
      {certificateDiffers && (
        <>
          <h4>Current certificate · token read</h4>
          <CertificateFacts certificate={token.currentCertificate} />
        </>
      )}
      <h4>Warehouse read</h4>
      {asset.warehouse ? (
        <dl className={styles.facts}>
          <div>
            <dt>Warehouse status</dt>
            <dd>{asset.warehouse.warehouseStatus}</dd>
          </div>
          <div>
            <dt>Warehouse receipt hash</dt>
            <dd>{asset.warehouse.warehouseReceiptHash}</dd>
          </div>
          <div>
            <dt>Warehouse observed at</dt>
            <dd>{asset.warehouse.observedAt}</dd>
          </div>
          <div>
            <dt>Warehouse encumbrance status</dt>
            <dd>{asset.warehouse.encumbranceStatus || "Not supplied"}</dd>
          </div>
        </dl>
      ) : (
        <p>No warehouse record is returned by this read.</p>
      )}
      <p className={styles.note}>
        Read completed at {readAt}. Dates above are supplied by the Oracle.
        These APIs do not provide a freshness expiry or signed attestation
        verification.
      </p>
    </div>
  );
}

async function loadOracle(
  slug: string,
  signal: AbortSignal,
): Promise<OracleReadResponse> {
  try {
    const response = await fetch(
      `/api/assets/${encodeURIComponent(slug)}/oracle`,
      {
        cache: "no-store",
        signal,
      },
    );
    const parsed = oracleReadResponseSchema.safeParse(await response.json());
    return parsed.success && (!parsed.data.ok || response.ok)
      ? parsed.data
      : { ok: false, code: "ORACLE_INVALID_RESPONSE" };
  } catch {
    return { ok: false, code: "ORACLE_UNAVAILABLE" };
  }
}

/** Public source observations for the whole-receipt page, without inferred rights. */
export function AssetHolderAuthority({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const query = useQuery({
    queryKey: ["whole-artwork-oracle", slug],
    queryFn: ({ signal }) => loadOracle(slug, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const view = oracleReadView(query);
  const loading = view.phase === "loading";
  const result = view.result;
  return (
    <section
      aria-label="Holder authority"
      className={className ?? "holder-authority"}
      data-testid="asset-holder-authority"
    >
      <h2>Who says who holds it</h2>
      <p>
        For a registry-backed artwork the registry of record is the holder
        authority. ArtFi consumes registries and operates none of them. A
        whole-artwork token is a receipt or delivery voucher; token ownership
        alone is not unrestricted physical title.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Standing</th>
            <th scope="col">What this page can show</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Registry of record</th>
            <td>Authority for holdership within its scope</td>
            <td>
              Holder unavailable through the public Oracle read API. No holder
              is inferred from a reference, status, or certificate.
            </td>
          </tr>
          <tr>
            <th scope="row">Chain</th>
            <td>Token state and settlement record</td>
            <td>
              On-chain owner reads in the trading panel are token ownership, not
              a registry holder claim.
            </td>
          </tr>
          <tr>
            <th scope="row">ArtFi&apos;s own store</th>
            <td>Read-only projection. Authoritative for nothing.</td>
            <td>Never the source of a holder claim on this page.</td>
          </tr>
        </tbody>
      </table>
      <section
        aria-label="Oracle read-only projection"
        className={styles.panel}
      >
        <div className={styles.heading}>
          <h3>Oracle status &amp; certificate</h3>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={loading}
          >
            {loading
              ? "Reading Oracle…"
              : result?.ok
                ? "Refresh Oracle status"
                : "Retry Oracle read"}
          </button>
        </div>
        <p>
          This is the Oracle&apos;s read-only projection. VALID and other
          machine statuses do not establish physical title, authorize a
          transfer, or replace the applicable receipt terms.
        </p>
        {view.phase === "paused" ? (
          <p role="status" data-testid="oracle-offline">
            You appear to be offline. The Oracle read is paused and previous
            facts are hidden. Reconnect to resume or retry the read.
          </p>
        ) : loading ? (
          <p role="status">
            Reading the Oracle for this artwork&apos;s bound token…
          </p>
        ) : result?.ok ? (
          <OracleFacts projection={result} />
        ) : (
          <p role="status" data-testid="oracle-unavailable">
            {
              oracleReadMessages[
                result && !result.ok ? result.code : "ORACLE_UNAVAILABLE"
              ]
            }
          </p>
        )}
      </section>
      <p className="market-gate">
        Where the registry and the chain disagree, ArtFi reports the divergence.
        It never resolves one by asserting its own projection.
      </p>
    </section>
  );
}
