import { isAddress, parseAbiItem, type Address, type PublicClient } from "viem";
import { daoGovernorAbi } from "./dao-contracts";
export const proposalClassifiedEvent = parseAbiItem(
  "event ProposalClassified(uint256 indexed proposalId, uint8 indexed kind, uint256 approvalNumerator)",
);
export const publicProposalStates = [
  "Pending",
  "Active",
  "Cancelled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;
export const publicProposalKinds = [
  "Unclassified",
  "Market migration",
  "Physical action",
  "Forced buyout",
] as const;
export type ProposalRange = { fromBlock: bigint; toBlock: bigint };
export type PublicProposal = {
  proposalId: string;
  kind: number;
  state: number;
  approvalNumerator: string;
  againstVotes: string;
  forVotes: string;
  abstainVotes: string;
  classifiedBlock: string;
  classifiedBlockHash: string;
  transactionHash: string;
  logIndex: number;
};
export type PublicProposalPage = {
  governor: Address;
  chainId: 560048;
  fromBlock: string;
  toBlock: string;
  observedBlock: string;
  observedBlockHash: string;
  observedAt: number;
  proposals: PublicProposal[];
};
type Reader = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "getLogs" | "readContract"
>;
function refuse(): never {
  throw new Error(
    "The public proposal range could not be verified. Retry a smaller block range.",
  );
}
function uint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n) refuse();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) refuse();
  return value.toLowerCase();
}
export function proposalBlockInput(raw: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(raw.trim())) refuse();
  return uint(BigInt(raw.trim()));
}
export function proposalRange(
  latest: bigint,
  requested?: ProposalRange,
): ProposalRange {
  uint(latest);
  const range = requested ?? {
    fromBlock: latest > 9999n ? latest - 9999n : 0n,
    toBlock: latest,
  };
  uint(range.fromBlock);
  uint(range.toBlock);
  if (
    range.fromBlock > range.toBlock ||
    range.toBlock > latest ||
    range.toBlock - range.fromBlock >= 10000n
  )
    refuse();
  return { ...range };
}
export function earlierProposalRange(
  fromBlock: bigint,
): ProposalRange | undefined {
  uint(fromBlock);
  if (fromBlock === 0n) return undefined;
  return {
    fromBlock: fromBlock > 10000n ? fromBlock - 10000n : 0n,
    toBlock: fromBlock - 1n,
  };
}
async function mapped<T, R>(
  values: readonly T[],
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        result[index] = await work(values[index]!);
      }
    }),
  );
  return result;
}
/** Bounded public discovery only; returned IDs and votes confer no wallet or execution authority. */
export async function readPublicProposalPage(
  client: Reader,
  governorAddress: string,
  requested?: ProposalRange,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<PublicProposalPage> {
  if (!isAddress(governorAddress) || /^0x0{40}$/i.test(governorAddress))
    refuse();
  const governor = governorAddress.toLowerCase() as Address;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    lifetime.signal,
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(15000),
  ]);
  const check = () => {
    if (signal.aborted)
      throw new Error("The proposal read was cancelled or timed out.");
  };
  const step = <T,>(action: () => Promise<T>): Promise<T> => {
    check();
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        reject(new Error("The proposal read was cancelled or timed out."));
      };
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          check();
          return action();
        })
        .then(
          (value) => {
            cleanup();
            try {
              check();
              resolve(value);
            } catch (error) {
              reject(error);
            }
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  };
  try {
    if ((await step(() => client.getChainId())) !== 560048) refuse();
    const block = await step(() => client.getBlock({ blockTag: "latest" }));
    const observedBlock = uint(block.number),
      observedBlockHash = hash(block.hash);
    const range = proposalRange(observedBlock, requested);
    const logs = await step(() =>
      client.getLogs({
        address: governor,
        event: proposalClassifiedEvent,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        strict: true,
      }),
    );
    if (!Array.isArray(logs) || logs.length > 100) refuse();
    const ids = new Set<string>(),
      identities = new Set<string>();
    const events = logs.map((log) => {
      const proposalId = uint(log.args.proposalId).toString(),
        kind = log.args.kind;
      const approval = uint(log.args.approvalNumerator);
      const classifiedBlock = uint(log.blockNumber),
        classifiedBlockHash = hash(log.blockHash),
        transactionHash = hash(log.transactionHash);
      if (
        log.address.toLowerCase() !== governor ||
        log.removed !== false ||
        classifiedBlock < range.fromBlock ||
        classifiedBlock > range.toBlock ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex! < 0 ||
        ![1, 2, 3].includes(kind as number) ||
        approval !== [0n, 500000n, 666667n, 800000n][kind as number] ||
        ids.has(proposalId)
      )
        refuse();
      const identity = transactionHash + ":" + log.logIndex;
      if (identities.has(identity)) refuse();
      ids.add(proposalId);
      identities.add(identity);
      return {
        proposalId,
        kind: kind as number,
        approvalNumerator: approval.toString(),
        classifiedBlock: classifiedBlock.toString(),
        classifiedBlockHash,
        transactionHash,
        logIndex: log.logIndex!,
      };
    });
    const canonical = new Map<string, string>();
    for (const event of events) {
      const previous = canonical.get(event.classifiedBlock);
      if (previous && previous !== event.classifiedBlockHash) refuse();
      canonical.set(event.classifiedBlock, event.classifiedBlockHash);
    }
    await mapped([...canonical], async ([number, expected]) => {
      const value = await step(() =>
        client.getBlock({ blockNumber: BigInt(number) }),
      );
      if (value.number !== BigInt(number) || hash(value.hash) !== expected)
        refuse();
    });
    const proposals = await mapped(events, async (event) => {
      const args = {
        address: governor,
        abi: daoGovernorAbi,
        args: [BigInt(event.proposalId)] as const,
        blockNumber: observedBlock,
      };
      const [state, kind, votes] = await Promise.all([
        step(() => client.readContract({ ...args, functionName: "state" })),
        step(() =>
          client.readContract({ ...args, functionName: "proposalKind" }),
        ),
        step(() =>
          client.readContract({ ...args, functionName: "proposalVotes" }),
        ),
      ]);
      if (
        !Number.isInteger(state) ||
        state < 0 ||
        state > 7 ||
        kind !== event.kind ||
        !Array.isArray(votes) ||
        votes.length !== 3
      )
        refuse();
      return {
        ...event,
        state,
        againstVotes: uint(votes[0]).toString(),
        forVotes: uint(votes[1]).toString(),
        abstainVotes: uint(votes[2]).toString(),
      };
    });
    const ending = await step(() =>
      client.getBlock({ blockNumber: observedBlock }),
    );
    if (
      ending.number !== observedBlock ||
      hash(ending.hash) !== observedBlockHash ||
      (await step(() => client.getChainId())) !== 560048
    )
      refuse();
    const observedAt = (options.now ?? Date.now)();
    if (
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0 ||
      observedAt > 8640000000000000
    )
      refuse();
    proposals.sort((a, b) =>
      BigInt(a.classifiedBlock) === BigInt(b.classifiedBlock)
        ? b.logIndex - a.logIndex
        : BigInt(a.classifiedBlock) > BigInt(b.classifiedBlock)
          ? -1
          : 1,
    );
    return {
      governor,
      chainId: 560048,
      fromBlock: range.fromBlock.toString(),
      toBlock: range.toBlock.toString(),
      observedBlock: observedBlock.toString(),
      observedBlockHash,
      observedAt,
      proposals,
    };
  } finally {
    lifetime.abort();
  }
}
