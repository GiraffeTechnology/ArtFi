import { assertSafeOrigin } from "./phishing.js";
import { PermissionController } from "./permissions.js";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hexPattern = /^0x[0-9a-fA-F]*$/;
export const SEPOLIA_CHAIN_ID = 11_155_111;

export interface TransactionRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  value: `0x${string}`;
  data: `0x${string}`;
  chainId: number;
}

export interface SimulationAttestation {
  chainId: number;
  status: "success" | "revert";
  requestHash: `0x${string}`;
  expiresAt: number;
}

export interface PendingConfirmation {
  id: string;
  origin: string;
  transaction: TransactionRequest;
  simulation: SimulationAttestation;
  createdAt: number;
  expiresAt: number;
}

export class ConfirmationController {
  readonly #pending = new Map<string, PendingConfirmation>();

  constructor(private readonly permissions: PermissionController) {}

  prepare(
    originValue: string,
    transaction: TransactionRequest,
    simulation: SimulationAttestation,
    now = Date.now(),
  ): PendingConfirmation {
    const origin = assertSafeOrigin(originValue);
    this.permissions.assert(origin, "eth_sendTransaction", now);
    if (
      transaction.chainId !== SEPOLIA_CHAIN_ID ||
      simulation.chainId !== SEPOLIA_CHAIN_ID
    ) {
      throw new Error("ArtFi Wallet Alpha is Sepolia-only");
    }
    if (
      !addressPattern.test(transaction.from) ||
      !addressPattern.test(transaction.to) ||
      !hexPattern.test(transaction.value) ||
      !hexPattern.test(transaction.data)
    ) {
      throw new Error("invalid transaction fields");
    }
    if (
      simulation.status !== "success" ||
      simulation.expiresAt <= now ||
      simulation.expiresAt > now + 5 * 60_000
    ) {
      throw new Error("a fresh successful simulation is required");
    }
    const id = crypto.randomUUID();
    const pending = {
      id,
      origin,
      transaction,
      simulation,
      createdAt: now,
      expiresAt: Math.min(simulation.expiresAt, now + 5 * 60_000),
    };
    this.#pending.set(id, pending);
    return pending;
  }

  approve(
    id: string,
    originValue: string,
    now = Date.now(),
  ): PendingConfirmation {
    const pending = this.#pending.get(id);
    const origin = assertSafeOrigin(originValue);
    if (!pending || pending.origin !== origin || pending.expiresAt <= now) {
      this.#pending.delete(id);
      throw new Error(
        "confirmation is missing, expired, or belongs to another origin",
      );
    }
    this.#pending.delete(id);
    return pending;
  }

  reject(id: string): void {
    this.#pending.delete(id);
  }
}

export interface ExternalSigner {
  readonly kind: "hardware" | "walletconnect";
  signApprovedTransaction(
    confirmation: PendingConfirmation,
  ): Promise<`0x${string}`>;
}
