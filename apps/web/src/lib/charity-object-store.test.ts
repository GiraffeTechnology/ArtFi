import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CharityHolderAsset } from "./charity-assets";
import {
  fetchHolderObject,
  holderObjectConfigFromEnv,
  maxHolderObjectBytes,
  signedGetRequest,
  verifyHolderBytes,
  type HolderObjectConfig,
} from "./charity-object-store";

const watermarked = Buffer.from("watermarked-holder-copy");
const master = Buffer.from("unwatermarked-master");

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const asset: CharityHolderAsset = {
  class: "watermarked-holder",
  tokenId: "7",
  sha256: digest(watermarked),
  masterSha256: digest(master),
  contentType: "image/jpeg",
  byteLength: watermarked.byteLength,
  objectKey: "charity/7/watermarked.jpg",
};

const config: HolderObjectConfig = {
  endpoint: new URL("https://store.example.com"),
  region: "auto",
  bucket: "charity-holder",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example-key",
};

function respondWith(body: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? new Uint8Array(body) : null, {
      status,
    })) as unknown as typeof fetch;
}

describe("holderObjectConfigFromEnv", () => {
  const complete = {
    ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT: "https://store.example.com",
    ARTFI_CHARITY_HOLDER_OBJECT_BUCKET: "charity-holder",
    ARTFI_CHARITY_HOLDER_OBJECT_ACCESS_KEY_ID: "AKIAEXAMPLE",
    ARTFI_CHARITY_HOLDER_OBJECT_SECRET_ACCESS_KEY: "secret-example-key",
  } as Record<string, string | undefined>;

  it("reads a complete configuration and defaults the region", () => {
    const resolved = holderObjectConfigFromEnv(complete);
    expect(resolved?.bucket).toBe("charity-holder");
    expect(resolved?.region).toBe("auto");
  });

  it("treats a partial configuration as no configuration", () => {
    for (const key of Object.keys(complete)) {
      const partial = { ...complete };
      delete partial[key];
      expect(holderObjectConfigFromEnv(partial)).toBeUndefined();
    }
  });

  it("refuses a plaintext endpoint that is not loopback", () => {
    expect(
      holderObjectConfigFromEnv({
        ...complete,
        ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT: "http://store.example.com",
      }),
    ).toBeUndefined();
    expect(
      holderObjectConfigFromEnv({
        ...complete,
        ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT: "http://127.0.0.1:9000",
      }),
    ).toBeDefined();
  });

  it("refuses an unparseable endpoint", () => {
    expect(
      holderObjectConfigFromEnv({
        ...complete,
        ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT: "not a url",
      }),
    ).toBeUndefined();
  });
});

describe("signedGetRequest", () => {
  const now = new Date("2026-09-19T08:30:00.000Z");

  it("signs a path-style GET without exposing the secret", () => {
    const signed = signedGetRequest(config, asset.objectKey, now);
    expect(signed.url).toBe(
      "https://store.example.com/charity-holder/charity/7/watermarked.jpg",
    );
    expect(signed.headers["x-amz-date"]).toBe("20260919T083000Z");
    expect(signed.headers.authorization).toContain(
      "Credential=AKIAEXAMPLE/20260919/auto/s3/aws4_request",
    );
    expect(signed.headers.authorization).not.toContain(config.secretAccessKey);
  });

  it("produces a different signature for a different key", () => {
    const a = signedGetRequest(config, "charity/7/a.jpg", now);
    const b = signedGetRequest(config, "charity/7/b.jpg", now);
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it("produces a different signature at a different time", () => {
    const later = new Date("2026-09-20T08:30:00.000Z");
    expect(
      signedGetRequest(config, asset.objectKey, now).headers.authorization,
    ).not.toBe(
      signedGetRequest(config, asset.objectKey, later).headers.authorization,
    );
  });
});

describe("verifyHolderBytes", () => {
  it("accepts the object the descriptor describes", () => {
    const decision = verifyHolderBytes(asset, new Uint8Array(watermarked));
    expect(decision.ok).toBe(true);
  });

  it("refuses the master even when it arrives under a holder descriptor", () => {
    const swapped = { ...asset, byteLength: master.byteLength };
    const decision = verifyHolderBytes(swapped, new Uint8Array(master));
    expect(decision).toEqual({ ok: false, refusal: "master-digest-collision" });
  });

  it("refuses any other object", () => {
    const other = Buffer.from("some other file entirely");
    const decision = verifyHolderBytes(
      { ...asset, byteLength: other.byteLength },
      new Uint8Array(other),
    );
    expect(decision).toEqual({ ok: false, refusal: "digest-mismatch" });
  });

  it("refuses a size the descriptor did not declare", () => {
    const decision = verifyHolderBytes(
      { ...asset, byteLength: watermarked.byteLength + 1 },
      new Uint8Array(watermarked),
    );
    expect(decision).toEqual({ ok: false, refusal: "size-mismatch" });
  });
});

describe("fetchHolderObject", () => {
  it("delivers bytes that match the descriptor", async () => {
    const delivery = await fetchHolderObject(
      asset,
      config,
      respondWith(watermarked),
    );
    expect(delivery.ok).toBe(true);
    if (delivery.ok) {
      expect(Buffer.from(delivery.bytes).toString()).toBe(
        watermarked.toString(),
      );
    }
  });

  it("refuses when no store is configured", async () => {
    const delivery = await fetchHolderObject(
      asset,
      undefined,
      respondWith(watermarked),
    );
    expect(delivery).toEqual({ ok: false, refusal: "not-configured" });
  });

  it("refuses a descriptor larger than the hard ceiling before any request", async () => {
    let called = false;
    const delivery = await fetchHolderObject(
      { ...asset, byteLength: maxHolderObjectBytes + 1 },
      config,
      (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    );
    expect(delivery).toEqual({ ok: false, refusal: "too-large" });
    expect(called).toBe(false);
  });

  it("reports an unreachable store rather than serving nothing quietly", async () => {
    const delivery = await fetchHolderObject(
      asset,
      config,
      respondWith(watermarked, 403),
    );
    expect(delivery).toEqual({ ok: false, refusal: "unreachable" });
  });

  it("reports a transport failure as unreachable", async () => {
    const delivery = await fetchHolderObject(asset, config, (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch);
    expect(delivery).toEqual({ ok: false, refusal: "unreachable" });
  });

  it("refuses a swapped object even though the store answered 200", async () => {
    const delivery = await fetchHolderObject(
      { ...asset, byteLength: master.byteLength },
      config,
      respondWith(master),
    );
    expect(delivery).toEqual({ ok: false, refusal: "master-digest-collision" });
  });
});
