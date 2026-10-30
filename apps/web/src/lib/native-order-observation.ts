import type { PublicClient } from "viem";
import { decodeNativeOrder, type NativeOrder } from "./native-order";
import {
  readNativeOrderState,
  type NativeOrderState,
} from "./native-order-state";

export type NativeOrderObservation = {
  chainId: 560048;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  observedAt: number;
  states: Record<string, NativeOrderState>;
};
type Reader = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;
function unavailable(): never {
  throw new Error(
    "The current order observation is unavailable. Refresh before relying on chain state.",
  );
}
function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Order observation was cancelled.");
}
async function bounded<T>(
  action: (assertActive: () => void) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  checkSignal(signal);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (reason: Error) => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(reason);
      }
    };
    const abort = () => fail(new Error("Order observation was cancelled."));
    const timer = setTimeout(
      () => fail(new Error("Order observation timed out.")),
      timeoutMs,
    );
    const assertActive = () => {
      if (finished) throw new Error("Order observation retired.");
      checkSignal(signal);
    };
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        assertActive();
        return action(assertActive);
      })
      .then(
        (value) => {
          if (!finished) {
            finished = true;
            cleanup();
            resolve(value);
          }
        },
        (reason) =>
          fail(
            reason instanceof Error
              ? reason
              : new Error("Order observation failed."),
          ),
      );
  });
}
/** Public read-only snapshot. This object never authorizes publication, approval or settlement. */
export async function readNativeOrderObservation(
  client: Reader,
  input: readonly NativeOrder[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<NativeOrderObservation> {
  const timeoutMs = options.timeoutMs ?? 12000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000 ||
    input.length < 1 ||
    input.length > 20
  )
    unavailable();
  // Copy decoded terms before any await; a caller cannot swap a displayed intent during an RPC read.
  const orders = input.map((value) => decodeNativeOrder(value).order);
  if (
    new Set(orders.map((order) => order.intentHash)).size !== orders.length ||
    orders.some(
      (order) =>
        order.marketAddress !== orders[0]!.marketAddress ||
        order.kind !== orders[0]!.kind,
    )
  )
    unavailable();
  const now = options.now ?? Date.now;
  return bounded(
    async (current) => {
      current();
      if ((await client.getChainId()) !== 560048) unavailable();
      current();
      const block = await client.getBlock({ blockTag: "latest" });
      if (
        typeof block.number !== "bigint" ||
        block.number < 0n ||
        typeof block.timestamp !== "bigint" ||
        block.timestamp < 0n ||
        typeof block.hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
      )
        unavailable();
      const blockHash = block.hash.toLowerCase();
      const pinned = {
        getChainId: async () => 560048,
        getBlock: async () => block,
        readContract: async (args: Parameters<Reader["readContract"]>[0]) => {
          current();
          const value = await client.readContract(args);
          current();
          if (
            args.functionName === "intentUsed"
              ? typeof value !== "boolean"
              : !["sellerEpoch", "intentFilled"].includes(
                  String(args.functionName),
                ) ||
                typeof value !== "bigint" ||
                value < 0n ||
                value >= 1n << 256n
          )
            unavailable();
          return value;
        },
      } as Reader;
      // The existing state decoder keeps its semantics, including consumed != proven sale.
      const pairs = await Promise.all(
        orders.map(
          async (order) =>
            [
              order.intentHash,
              await readNativeOrderState(pinned, order),
            ] as const,
        ),
      );
      current();
      const canonical = await client.getBlock({ blockNumber: block.number });
      current();
      if (
        canonical.number !== block.number ||
        canonical.hash?.toLowerCase() !== blockHash ||
        canonical.timestamp !== block.timestamp ||
        (await client.getChainId()) !== 560048
      )
        unavailable();
      current();
      const observedAt = now();
      if (
        !Number.isSafeInteger(observedAt) ||
        observedAt < 0 ||
        observedAt > 8640000000000000
      )
        unavailable();
      return {
        chainId: 560048,
        blockNumber: block.number.toString(),
        blockHash,
        blockTimestamp: block.timestamp.toString(),
        observedAt,
        states: Object.fromEntries(pairs),
      };
    },
    options.signal,
    timeoutMs,
  );
}
export function nativeOrderObservationFreshness(
  observation: Pick<NativeOrderObservation, "observedAt">,
  now: number,
): "recent" | "older" | "clock-unavailable" {
  if (
    !Number.isSafeInteger(now) ||
    now < observation.observedAt ||
    !Number.isSafeInteger(observation.observedAt)
  )
    return "clock-unavailable";
  return now - observation.observedAt > 30000 ? "older" : "recent";
}
