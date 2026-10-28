import "server-only";
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import {
  observeWholeReceiptSource,
  snapshotWholeReceiptExpectation,
} from "./whole-receipt-source-observation-model";

/** The implementation-specific Oracle PR48 read ABI. No institution or Kit
 * endpoint is selected here and no admission/payment method is present. */
export const wholeReceiptProjectionReadAbi: Abi = parseAbi([
  "function registerId() view returns (bytes32)",
  "function sourceAuthority() view returns (address)",
  "function mintPolicyHash(uint256 tokenId) view returns (bytes32)",
  "function entryAt(uint256 tokenId,uint64 version) view returns ((bytes32 recordCommitment,bytes32 previousCommitment,bytes32 registryReference,address holder,uint64 version,uint64 effectiveAt,uint64 supersededAt))",
  "function receiptBinding(uint256 tokenId,uint64 version) view returns ((bytes32 schemaId,bytes32 mintPolicyHash,bytes32 segmentDigest,bytes32 requestHash,bytes32 receiptDocumentHash))",
  "function isFinalAsOf(uint256 tokenId,uint64 instant) view returns (bool)",
]);
type ReadMethod =
  "eth_chainId" | "eth_getBlockByNumber" | "eth_getCode" | "eth_call";
export type ReceiptChainReadRequest = (input: {
  method: ReadMethod;
  params: unknown[];
}) => Promise<unknown>;
export type ReceiptChainVerificationCode =
  | "RECEIPT_CHAIN_CONFIG_INVALID"
  | "RECEIPT_CHAIN_SNAPSHOT_REFUSED"
  | "RECEIPT_CHAIN_UNAVAILABLE"
  | "RECEIPT_CHAIN_CANCELLED"
  | "RECEIPT_CHAIN_TIMEOUT";
class ChainReadError extends Error {
  constructor(readonly code: ReceiptChainVerificationCode) {
    super(code);
  }
}
function fail(code: ReceiptChainVerificationCode): never {
  throw new ChainReadError(code);
}
function fields(raw: unknown, keys: readonly string[], exact = true) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    (exact && Reflect.ownKeys(descriptors).length !== keys.length) ||
    keys.some(
      (key) =>
        !Object.hasOwn(descriptors, key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function hex(raw: unknown, bytes?: number): Hex {
  if (
    typeof raw !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw) ||
    raw.length > 262146 ||
    (bytes !== undefined && raw.length !== 2 + bytes * 2)
  )
    fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return raw.toLowerCase() as Hex;
}
function nonzeroHash(raw: unknown): Hex {
  const value = hex(raw, 32);
  if (/^0x0{64}$/.test(value)) fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return value;
}
function quantity(raw: unknown): bigint {
  if (
    typeof raw !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(raw) ||
    raw.length > 66
  )
    fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return BigInt(raw);
}
function block(raw: unknown) {
  // RPC block metadata may contain other standard fields. Only own data
  // properties contribute to this result; no accessor is evaluated.
  const value = fields(raw, ["number", "hash"], false);
  return { number: quantity(value.number), hash: nonzeroHash(value.hash) };
}
function decimal(raw: unknown, bits: number) {
  if (typeof raw !== "bigint" || raw < 0n || raw >= 1n << BigInt(bits))
    fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return String(raw);
}
function word(raw: unknown) {
  if (typeof raw !== "string") fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
  return raw.toLowerCase();
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Bind only the existing approved installation provider and deployed code.
 * This does not discover a provider, accept a browser URL, deploy a contract or
 * authenticate institution documents. The caller supplies its independent
 * immutable native-plan/source expectation, never one inferred from HTTP. */
export function createWholeReceiptChainVerifier(options: {
  chainId: "31337" | "560048";
  contract: string;
  runtimeCodeHash: string;
  request: ReceiptChainReadRequest;
}) {
  let installed: Record<string, unknown>;
  try {
    installed = fields(options, [
      "chainId",
      "contract",
      "runtimeCodeHash",
      "request",
    ]);
    if (
      !["31337", "560048"].includes(installed.chainId as string) ||
      typeof installed.contract !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(installed.contract) ||
      /^0x0{40}$/i.test(installed.contract) ||
      typeof installed.request !== "function"
    )
      throw Error("invalid");
    nonzeroHash(installed.runtimeCodeHash);
  } catch {
    fail("RECEIPT_CHAIN_CONFIG_INVALID");
  }
  const chainId = installed.chainId as string,
    contract = (installed.contract as string).toLowerCase(),
    codeHash = (installed.runtimeCodeHash as string).toLowerCase(),
    request = installed.request as ReceiptChainReadRequest;
  return Object.freeze({
    async verify(
      expectedInput: unknown,
      snapshotInput: unknown,
      signal?: AbortSignal,
    ) {
      let live = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel = () => {};
      const stopped = () => {
        if (!live || signal?.aborted) fail("RECEIPT_CHAIN_CANCELLED");
      };
      try {
        const expected = snapshotWholeReceiptExpectation(expectedInput);
        const observation = observeWholeReceiptSource(expected, snapshotInput);
        const anchor = observation.snapshot.block;
        if (
          expected.source.chainId !== chainId ||
          expected.source.contract.toLowerCase() !== contract
        )
          fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
        stopped();
        const read = async (method: ReadMethod, params: unknown[]) => {
          stopped();
          const result = await request({ method, params });
          stopped();
          return result;
        };
        const operation = async () => {
          if (quantity(await read("eth_chainId", [])) !== BigInt(chainId))
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          const height = "0x" + BigInt(anchor.number).toString(16);
          const initial = block(
            await read("eth_getBlockByNumber", [height, false]),
          );
          if (
            initial.number !== BigInt(anchor.number) ||
            initial.hash !== anchor.hash.toLowerCase()
          )
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          // EIP-1898 binds every code/state read to this exact canonical block.
          // Unsupported providers fail rather than silently falling back to latest.
          const at = { blockHash: initial.hash, requireCanonical: true };
          const code = hex(await read("eth_getCode", [contract, { ...at }]));
          if (keccak256(code) !== codeHash)
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          const call = async (
            functionName: string,
            args: readonly unknown[] = [],
          ) => {
            const data = encodeFunctionData({
              abi: wholeReceiptProjectionReadAbi,
              functionName,
              args,
            });
            const raw = hex(
              await read("eth_call", [{ to: contract, data }, { ...at }]),
            );
            const result = decodeFunctionResult({
              abi: wholeReceiptProjectionReadAbi,
              functionName,
              data: raw,
            });
            // Refuse extra ABI bytes/noncanonical return encodings.
            if (
              encodeFunctionResult({
                abi: wholeReceiptProjectionReadAbi,
                functionName,
                result,
              }).toLowerCase() !== raw
            )
              fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
            return result;
          };
          const tokenId = BigInt(expected.tokenId),
            version = BigInt(expected.entry.version);
          const registerId = word(await call("registerId"));
          const sourceAuthority = word(await call("sourceAuthority"));
          const mintPolicyHash = word(await call("mintPolicyHash", [tokenId]));
          const entry = fields(await call("entryAt", [tokenId, version]), [
            "recordCommitment",
            "previousCommitment",
            "registryReference",
            "holder",
            "version",
            "effectiveAt",
            "supersededAt",
          ]);
          const binding = fields(
            await call("receiptBinding", [tokenId, version]),
            [
              "schemaId",
              "mintPolicyHash",
              "segmentDigest",
              "requestHash",
              "receiptDocumentHash",
            ],
          );
          const temporalFinal = await call("isFinalAsOf", [
            tokenId,
            BigInt(expected.entry.effectiveAt),
          ]);
          if (typeof temporalFinal !== "boolean")
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          const checked = observeWholeReceiptSource(expected, {
            tokenId: expected.tokenId,
            source: { chainId, contract, registerId, sourceAuthority },
            block: { number: String(initial.number), hash: initial.hash },
            mintPolicyHash,
            entry: {
              recordCommitment: word(entry.recordCommitment),
              previousCommitment: word(entry.previousCommitment),
              registryReference: word(entry.registryReference),
              holder: word(entry.holder),
              version: decimal(entry.version, 64),
              effectiveAt: decimal(entry.effectiveAt, 64),
              supersededAt: decimal(entry.supersededAt, 64),
            },
            receiptBinding: Object.fromEntries(
              Object.entries(binding).map(([key, value]) => [key, word(value)]),
            ),
            receiptAvailable: true,
          });
          // A source HTTP snapshot must agree with this exact on-chain interval,
          // including later closure of the requested historical entry.
          if (
            checked.snapshot.entry.supersededAt !==
            observation.snapshot.entry.supersededAt
          )
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          const finalized = block(
            await read("eth_getBlockByNumber", ["finalized", false]),
          );
          const finalAnchor = block(
            await read("eth_getBlockByNumber", [
              "0x" + finalized.number.toString(16),
              false,
            ]),
          );
          const current = block(
            await read("eth_getBlockByNumber", [height, false]),
          );
          if (
            (finalized.number === initial.number &&
              finalized.hash !== initial.hash) ||
            finalAnchor.number !== finalized.number ||
            finalAnchor.hash !== finalized.hash ||
            current.number !== initial.number ||
            current.hash !== initial.hash ||
            quantity(await read("eth_chainId", [])) !== BigInt(chainId)
          )
            fail("RECEIPT_CHAIN_SNAPSHOT_REFUSED");
          return freeze({
            kind: "canonical-oracle-receipt-source" as const,
            authorization: "NOT_ESTABLISHED" as const,
            originalDocumentVerification: "NOT_ESTABLISHED" as const,
            chainFinality:
              finalized.number >= initial.number
                ? ("FINALIZED" as const)
                : ("NOT_FINALIZED" as const),
            finalizedBlock: {
              number: String(finalized.number),
              hash: finalized.hash,
            },
            projectionFinalAsOf: temporalFinal,
            projectionInstant: expected.entry.effectiveAt,
            runtimeCodeHash: codeHash,
            snapshot: checked.snapshot,
          });
        };
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            live = false;
            reject(new ChainReadError("RECEIPT_CHAIN_TIMEOUT"));
          }, 8000);
          cancel = () => {
            live = false;
            reject(new ChainReadError("RECEIPT_CHAIN_CANCELLED"));
          };
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        });
        const verification = await Promise.race([deadline, operation()]);
        return { ok: true as const, verification };
      } catch (error) {
        return {
          ok: false as const,
          code:
            error instanceof ChainReadError
              ? error.code
              : error instanceof Error &&
                  [
                    "RECEIPT_EXPECTATION_INVALID",
                    "RECEIPT_SOURCE_MALFORMED",
                    "RECEIPT_BINDING_MISMATCH",
                    "RECEIPT_NOT_AVAILABLE",
                  ].includes(error.message)
                ? ("RECEIPT_CHAIN_SNAPSHOT_REFUSED" as const)
                : ("RECEIPT_CHAIN_UNAVAILABLE" as const),
        };
      } finally {
        live = false;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
  });
}
