import { assertSafeOrigin } from "./phishing.js";

export type WalletMethod =
  | "eth_accounts"
  | "eth_chainId"
  | "eth_sendTransaction"
  | "personal_sign"
  | "eth_signTypedData_v4";

const allowedMethods = new Set<WalletMethod>([
  "eth_accounts",
  "eth_chainId",
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
]);

export interface OriginPermission {
  origin: string;
  methods: WalletMethod[];
  approvedAt: number;
  expiresAt: number;
}

export class PermissionController {
  readonly #records = new Map<string, OriginPermission>();

  grant(
    originValue: string,
    methods: WalletMethod[],
    now = Date.now(),
    ttlMs = 24 * 60 * 60 * 1000,
  ): OriginPermission {
    const origin = assertSafeOrigin(originValue);
    if (
      ttlMs < 60_000 ||
      ttlMs > 30 * 24 * 60 * 60 * 1000 ||
      methods.length === 0
    ) {
      throw new Error("invalid permission lifetime or method set");
    }
    const unique = [...new Set(methods)];
    if (unique.some((method) => !allowedMethods.has(method)))
      throw new Error("unsupported wallet method");
    const record = {
      origin,
      methods: unique,
      approvedAt: now,
      expiresAt: now + ttlMs,
    };
    this.#records.set(origin, record);
    return record;
  }

  assert(
    originValue: string,
    method: WalletMethod,
    now = Date.now(),
  ): OriginPermission {
    const origin = assertSafeOrigin(originValue);
    const record = this.#records.get(origin);
    if (
      !record ||
      record.expiresAt <= now ||
      !record.methods.includes(method)
    ) {
      throw new Error("origin is not authorized for this wallet method");
    }
    return record;
  }

  revoke(originValue: string): void {
    this.#records.delete(assertSafeOrigin(originValue));
  }

  list(now = Date.now()): OriginPermission[] {
    for (const [origin, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(origin);
    }
    return [...this.#records.values()].sort((left, right) =>
      left.origin.localeCompare(right.origin),
    );
  }
}
