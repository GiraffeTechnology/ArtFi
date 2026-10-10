// TEST_ONLY public upstream responses. No live asset, credential, or transaction.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RwaAsset, RwaSection } from "../lib/rwa-catalog";

export function sourceOracleAsset(section: RwaSection = "whole"): RwaAsset {
  const tokenId = section === "whole" ? "41" : "42";
  return {
    slug: `test-source-${section}-${tokenId}`,
    title: `TEST ONLY ${section} source ${tokenId}`,
    artist: "Isolated source artist",
    year: 2026,
    medium: "Synthetic metadata",
    location: "Isolated loopback fixture",
    description:
      "Published synthetic catalog response with no real asset claim.",
    section,
    rights: "TEST ONLY receipt or participation rights. No real-world value.",
    provenance: ["Isolated approved-source response"],
    binding: {
      chainId: 560048,
      collectionAddress: `0x${"1".repeat(38)}${tokenId}`,
      tokenId,
      assetId: `TEST_ONLY_asset_${tokenId}`,
      underlyingAssetId: `TEST_ONLY_underlying_${tokenId}`,
    },
    grounding: {
      status: "verified",
      mode: "TEST_ONLY",
      sourceId: "isolated-source",
      sourceName: "Isolated Oracle source fixture",
      sourceKind: "registry",
      sourceReference: `https://evidence.invalid/TEST_ONLY/${tokenId}`,
      evidenceSha256: "1".repeat(64),
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      verifiedAt: "2026-10-05T00:00:00Z",
      registryBacked: true,
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    revision: 1,
  };
}

export function sourceOracleReads(record: RwaAsset) {
  const { assetId, tokenId, collectionAddress, chainId } = record.binding;
  const certificate = {
    assetId,
    tokenId,
    certificateVersion: 2,
    certificateHash: "a".repeat(64),
    previousCertificateHash: "b".repeat(64),
    wenbaoChangeRef: `TEST_ONLY-change-${tokenId}`,
    warehouseReceiptHash: "c".repeat(64),
    effectiveAt: "2026-10-01T10:00:00Z",
    supersededAt: null,
    status: "CURRENT",
  };
  return {
    token: {
      binding: {
        chainId: String(chainId),
        contract: collectionAddress,
        tokenId,
        assetId,
      },
      status: "VALID",
      currentCertificate: certificate,
    },
    asset: {
      asset: {
        assetId,
        assetFingerprintHash: "d".repeat(64),
        wenbaoRegistryRef: `TEST_ONLY-registry-${tokenId}`,
        transferEligibility: "VALID",
        warehouseReceiptHash: "c".repeat(64),
        currentCertificateHash: "a".repeat(64),
        currentCertificateVersion: 2,
        encumbranceStatus: "NONE",
        oracleStatus: "VALID",
        updatedAt: "2026-10-01T10:00:00Z",
      },
      status: "VALID",
      currentCertificate: certificate,
      warehouse: {
        assetId,
        warehouseReceiptHash: "c".repeat(64),
        warehouseStatus: "IN_CUSTODY",
        encumbranceStatus: "NONE",
        observedAt: "2026-10-01T09:30:00Z",
      },
    },
  };
}

export function sourceProjectionRead(record: RwaAsset, tail: string) {
  const source = {
    chainId: String(record.binding.chainId),
    contract: record.binding.collectionAddress,
    registerId: `0x${"a".repeat(62)}${record.binding.tokenId}`,
  };
  const base = { tokenId: record.binding.tokenId, source };
  if (!tail) return { ...base, registerId: source.registerId, entryCount: "2" };
  if (tail === "/position")
    return {
      ...base,
      tradeablePosition: `0x${"2".repeat(40)}`,
      positionSource: "erc-721",
    };
  const instant = tail.split("/").at(-1)!;
  const at = { ...base, instant };
  if (tail.startsWith("/entry/as-of/"))
    return {
      ...at,
      entry: {
        recordCommitment: `0x${"b".repeat(64)}`,
        previousCommitment: `0x${"0".repeat(64)}`,
        registryReference: `0x${"c".repeat(64)}`,
        holder: `0x${"1".repeat(40)}`,
        version: "2",
        effectiveAt: "0",
        supersededAt: "0",
      },
    };
  if (tail.startsWith("/holder/as-of/"))
    return { ...at, holder: `0x${"1".repeat(40)}` };
  if (tail.startsWith("/finality/as-of/")) return { ...at, final: true };
  return undefined;
}

export async function startSourceOracleFixture(port = 0) {
  const records = [sourceOracleAsset("whole"), sourceOracleAsset("fractional")];
  const reads: { method: string; path: string; hasIdentity: boolean }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const send = (body: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    if (path === "/health") return send({ ok: true, mode: "TEST_ONLY" });
    reads.push({
      method: request.method ?? "",
      path: `${path}${url.search}`,
      hasIdentity: Boolean(
        request.headers.cookie || request.headers.authorization,
      ),
    });
    if (request.method !== "GET")
      return send({ detail: "Read-only fixture" }, 405);
    if (path === "/catalog/v1/rwa/assets") {
      const section = url.searchParams.get("section");
      const data = records.filter(
        (record) => !section || record.section === section,
      );
      return send({ data, total: data.length, page: 1, pageSize: 12 });
    }
    for (const record of records) {
      const { tokenId, collectionAddress, chainId, assetId } = record.binding;
      if (path === `/catalog/v1/rwa/assets/${record.slug}`) return send(record);
      const oracle = sourceOracleReads(record);
      if (
        path ===
        `/oracle/v1/rwa/tokens/${chainId}/${collectionAddress}/${tokenId}`
      )
        return send(oracle.token);
      if (path === `/oracle/v1/rwa/assets/${assetId}`)
        return send(oracle.asset);
      const projectionPath = `/oracle/v1/oracle/projection/${tokenId}`;
      if (path === projectionPath || path.startsWith(`${projectionPath}/`)) {
        const body = sourceProjectionRead(
          record,
          path.slice(projectionPath.length),
        );
        if (body) return send(body);
      }
    }
    send({ detail: "Unknown TEST_ONLY source record" }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    reads,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
