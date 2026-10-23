import process from "node:process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";

// Operations entry point, never imported by the browser. Reuses the web
// package's declared viem dependency; no signer or wallet client is created.
const CHAIN_ID = 560048;
const MAX_EVENTS = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const CREATED = parseAbiItem(
  "event VaultCreated(bytes32 indexed requestId, address indexed vault, address indexed collection, uint256 tokenId, string vaultName)",
);
const ISSUED = parseAbiItem(
  "event Fractionalized(address indexed token, address indexed recipient, uint256 supply)",
);
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_getTransactionReceipt",
]);

class IndexFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireValue(condition, code) {
  if (!condition) throw new IndexFailure(code);
}

function address(value) {
  requireValue(typeof value === "string", "FRACTIONAL_ADDRESS_INVALID");
  const normalized = value.toLowerCase();
  requireValue(
    ADDRESS.test(normalized) && normalized !== ZERO_ADDRESS,
    "FRACTIONAL_ADDRESS_INVALID",
  );
  return normalized;
}

function hash(value) {
  requireValue(typeof value === "string", "FRACTIONAL_HASH_INVALID");
  const normalized = value.toLowerCase();
  requireValue(HASH.test(normalized), "FRACTIONAL_HASH_INVALID");
  return normalized;
}

function quantity(value, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(
    typeof value === "string" && QUANTITY.test(value),
    "FRACTIONAL_RPC_QUANTITY_INVALID",
  );
  const parsed = BigInt(value);
  requireValue(parsed <= BigInt(maximum), "FRACTIONAL_RPC_QUANTITY_RANGE");
  return Number(parsed);
}

function decimal(value, minimum, maximum) {
  requireValue(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    "FRACTIONAL_CONFIG_INTEGER_INVALID",
  );
  const parsed = Number(value);
  requireValue(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    "FRACTIONAL_CONFIG_INTEGER_RANGE",
  );
  return parsed;
}

function endpoint(value, api = false) {
  const url = new URL(value);
  requireValue(
    !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
    "FRACTIONAL_ENDPOINT_REFUSED",
  );
  if (api) {
    requireValue(
      !url.search && url.pathname === "/",
      "FRACTIONAL_API_ORIGIN_REQUIRED",
    );
  }
  return url;
}

export function fractionalIndexerConfig(env = process.env) {
  requireValue(
    env.ARTFI_FRACTIONAL_INDEXER_ENABLED === "true" &&
      env.ARTFI_FRACTIONAL_INDEXER_MODE === "TEST_ONLY_NO_REAL_VALUE" &&
      env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE === "sin",
    "FRACTIONAL_INDEXER_DISABLED_OR_WRONG_ZONE",
  );
  const stateDirectory = env.ARTFI_FRACTIONAL_INDEXER_STATE_DIRECTORY;
  const key = env.ARTFI_INDEXER_SHARED_KEY;
  requireValue(
    typeof stateDirectory === "string" &&
      isAbsolute(stateDirectory) &&
      typeof key === "string" &&
      key.length >= 16 &&
      !/[\r\n]/.test(key),
    "FRACTIONAL_INDEXER_PROTECTED_CONFIG_REQUIRED",
  );
  return {
    rpc: endpoint(env.ARTFI_RPC_URL),
    api: endpoint(env.ARTFI_FRACTIONAL_INDEXER_API_ORIGIN, true),
    factory: address(env.ARTFI_VAULT_FACTORY_ADDRESS),
    startBlock: decimal(
      env.ARTFI_FRACTIONAL_INDEXER_START_BLOCK,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    maxBlocks: decimal(
      env.ARTFI_FRACTIONAL_INDEXER_MAX_BLOCKS ?? "200000",
      1,
      1000000,
    ),
    stateDirectory,
    key,
  };
}

async function jsonResponse(url, options, deadline) {
  requireValue(Date.now() < deadline, "FRACTIONAL_RUN_BUDGET_EXHAUSTED");
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(15000, deadline - Date.now())),
    ),
  });
  const reader = response.body?.getReader();
  requireValue(reader, "FRACTIONAL_RESPONSE_EMPTY");
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      requireValue(bytes <= MAX_BYTES, "FRACTIONAL_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  // Never expose raw RPC/API response bodies, URLs or headers in diagnostics.
  return {
    status: response.status,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
}

function rpcReader(config, deadline) {
  let sequence = 0;
  return async (method, params) => {
    requireValue(READ_METHODS.has(method), "FRACTIONAL_RPC_METHOD_REFUSED");
    const id = ++sequence;
    const response = await jsonResponse(
      config.rpc,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      deadline,
    );
    requireValue(
      response.status === 200 &&
        response.body?.jsonrpc === "2.0" &&
        response.body.id === id &&
        !response.body.error &&
        Object.hasOwn(response.body, "result"),
      "FRACTIONAL_RPC_RESPONSE_REFUSED",
    );
    return response.body.result;
  };
}

function identity(event) {
  return `${event.transactionHash}:${event.logIndex}`;
}

function incarnation(event) {
  return `${identity(event)}:${event.blockHash}`;
}

function ordered(events) {
  return events.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
}

function normalizeLog(log, event, from, to) {
  requireValue(
    log && log.removed === false,
    "FRACTIONAL_LOG_REMOVED_OR_INVALID",
  );
  const blockNumber = quantity(log.blockNumber);
  requireValue(
    blockNumber >= from && blockNumber <= to,
    "FRACTIONAL_LOG_OUTSIDE_RANGE",
  );
  const decoded = decodeEventLog({
    abi: [event],
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const args = decoded.args;
  let payload;
  if (event.name === "VaultCreated") {
    requireValue(
      typeof args.vaultName === "string" &&
        Buffer.byteLength(args.vaultName, "utf8") >= 2 &&
        Buffer.byteLength(args.vaultName, "utf8") <= 80,
      "FRACTIONAL_VAULT_NAME_INVALID",
    );
    payload = {
      requestId: hash(args.requestId),
      vault: address(args.vault),
      collection: address(args.collection),
      tokenId: args.tokenId.toString(),
      vaultName: args.vaultName,
    };
  } else {
    requireValue(args.supply > 0n, "FRACTIONAL_SUPPLY_INVALID");
    payload = {
      token: address(args.token),
      recipient: address(args.recipient),
      supply: args.supply.toString(),
    };
  }
  return {
    chainId: CHAIN_ID,
    transactionHash: hash(log.transactionHash),
    logIndex: quantity(log.logIndex, 0xffffffff),
    blockNumber,
    blockHash: hash(log.blockHash),
    contractAddress: address(log.address),
    eventName: event.name,
    payload,
    removed: false,
    confirmations: 1,
  };
}

export async function collectFractionalSnapshot(config, rpc) {
  requireValue(
    quantity(await rpc("eth_chainId", [])) === CHAIN_ID,
    "FRACTIONAL_CHAIN_REFUSED",
  );
  const anchor = await rpc("eth_getBlockByNumber", ["finalized", false]);
  const end = quantity(anchor?.number);
  const anchorHash = hash(anchor?.hash);
  requireValue(
    end >= config.startBlock && end - config.startBlock + 1 <= config.maxBlocks,
    "FRACTIONAL_SCAN_RANGE_EXCEEDED",
  );
  const headers = new Map();
  const receipts = new Map();
  const events = new Map();
  async function scan(contract, event, start) {
    const result = [];
    for (let from = start; from <= end; from += 500) {
      const to = Math.min(from + 499, end);
      const logs = await rpc("eth_getLogs", [
        {
          address: contract,
          topics: [toEventSelector(event)],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        },
      ]);
      requireValue(
        Array.isArray(logs) && logs.length <= MAX_EVENTS,
        "FRACTIONAL_LOG_LIMIT_REFUSED",
      );
      for (const log of logs) {
        const record = normalizeLog(log, event, from, to);
        requireValue(
          record.contractAddress === contract,
          "FRACTIONAL_LOG_CONTRACT_MISMATCH",
        );
        if (!headers.has(record.blockNumber)) {
          const header = await rpc("eth_getBlockByNumber", [
            log.blockNumber,
            false,
          ]);
          requireValue(
            quantity(header?.number) === record.blockNumber,
            "FRACTIONAL_HEADER_NUMBER_MISMATCH",
          );
          headers.set(record.blockNumber, hash(header.hash));
        }
        requireValue(
          headers.get(record.blockNumber) === record.blockHash,
          "FRACTIONAL_CANONICAL_BLOCK_MISMATCH",
        );
        if (!receipts.has(record.transactionHash)) {
          receipts.set(
            record.transactionHash,
            await rpc("eth_getTransactionReceipt", [record.transactionHash]),
          );
        }
        const receipt = receipts.get(record.transactionHash);
        requireValue(
          receipt &&
            receipt.status === "0x1" &&
            hash(receipt.transactionHash) === record.transactionHash &&
            hash(receipt.blockHash) === record.blockHash &&
            quantity(receipt.blockNumber) === record.blockNumber &&
            Array.isArray(receipt.logs),
          "FRACTIONAL_RECEIPT_MISMATCH",
        );
        const matches = receipt.logs.filter(
          (entry) => entry.logIndex === log.logIndex,
        );
        requireValue(
          matches.length === 1,
          "FRACTIONAL_RECEIPT_LOG_MISSING_OR_DUPLICATE",
        );
        const match = matches[0];
        requireValue(
          match.removed === false &&
            address(match.address) === contract &&
            hash(match.transactionHash) === record.transactionHash &&
            hash(match.blockHash) === record.blockHash &&
            quantity(match.blockNumber) === record.blockNumber &&
            match.data.toLowerCase() === log.data.toLowerCase() &&
            JSON.stringify(match.topics.map((topic) => hash(topic))) ===
              JSON.stringify(log.topics.map((topic) => hash(topic))),
          "FRACTIONAL_RECEIPT_LOG_MISMATCH",
        );
        record.confirmations = Math.min(
          0xffffffff,
          end - record.blockNumber + 1,
        );
        const previous = events.get(identity(record));
        requireValue(
          !previous || JSON.stringify(previous) === JSON.stringify(record),
          "FRACTIONAL_LOG_IDENTITY_CONFLICT",
        );
        if (!previous) {
          events.set(identity(record), record);
          result.push(record);
        }
        requireValue(
          events.size <= MAX_EVENTS,
          "FRACTIONAL_EVENT_LIMIT_EXCEEDED",
        );
      }
    }
    return ordered(result);
  }
  const origins = await scan(config.factory, CREATED, config.startBlock);
  const vaults = new Set();
  for (const origin of origins) {
    const vault = origin.payload.vault;
    requireValue(!vaults.has(vault), "FRACTIONAL_FACTORY_VAULT_AMBIGUOUS");
    vaults.add(vault);
    const issued = await scan(vault, ISSUED, origin.blockNumber);
    requireValue(issued.length <= 1, "FRACTIONAL_ISSUANCE_AMBIGUOUS");
    for (const issuance of issued) {
      requireValue(
        issuance.blockNumber > origin.blockNumber ||
          issuance.logIndex > origin.logIndex,
        "FRACTIONAL_ISSUANCE_PRECEDES_ORIGIN",
      );
    }
  }
  const finalAnchor = await rpc("eth_getBlockByNumber", [
    `0x${end.toString(16)}`,
    false,
  ]);
  requireValue(
    hash(finalAnchor?.hash) === anchorHash,
    "FRACTIONAL_SCAN_REORG_DETECTED",
  );
  return { end, anchorHash, events: ordered([...events.values()]) };
}

function validateJournal(journal, config) {
  requireValue(
    journal?.version === 1 &&
      journal.chainId === CHAIN_ID &&
      journal.factory === config.factory &&
      journal.startBlock === config.startBlock &&
      Array.isArray(journal.events) &&
      journal.events.length <= MAX_EVENTS * 2,
    "FRACTIONAL_JOURNAL_SCOPE_REFUSED",
  );
  const known = new Set();
  for (const event of journal.events) {
    requireValue(
      event?.chainId === CHAIN_ID &&
        HASH.test(event.transactionHash) &&
        HASH.test(event.blockHash) &&
        ADDRESS.test(event.contractAddress) &&
        Number.isSafeInteger(event.logIndex) &&
        event.logIndex >= 0 &&
        event.logIndex <= 0xffffffff &&
        Number.isSafeInteger(event.blockNumber) &&
        event.blockNumber >= config.startBlock &&
        Number.isInteger(event.confirmations) &&
        event.confirmations > 0 &&
        event.confirmations <= 0xffffffff &&
        event.removed === false &&
        ["VaultCreated", "Fractionalized"].includes(event.eventName) &&
        event.payload &&
        (event.eventName !== "VaultCreated" ||
          event.contractAddress === config.factory),
      "FRACTIONAL_JOURNAL_EVENT_REFUSED",
    );
    requireValue(
      !known.has(incarnation(event)),
      "FRACTIONAL_JOURNAL_DUPLICATE",
    );
    known.add(incarnation(event));
  }
}

async function regularFile(path) {
  const stat = await lstat(path);
  requireValue(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= MAX_BYTES &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid(),
    "FRACTIONAL_STATE_FILE_REFUSED",
  );
  return stat;
}

async function writeJournal(path, journal) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(journal)}\n`;
  requireValue(
    Buffer.byteLength(body) <= MAX_BYTES,
    "FRACTIONAL_JOURNAL_SIZE_EXCEEDED",
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(body, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function runFractionalIndexer(config) {
  // Linux operations runtime: one private state directory / one scheduled job.
  // A pre-existing lock is never force-cleared by this program.
  requireValue(
    process.platform === "linux",
    "FRACTIONAL_LINUX_RUNTIME_REQUIRED",
  );
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.stateDirectory);
  requireValue(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      (directory.mode & 0o077) === 0 &&
      directory.uid === process.getuid(),
    "FRACTIONAL_PRIVATE_STATE_DIRECTORY_REQUIRED",
  );
  const lockPath = join(config.stateDirectory, "collector.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const deadline = Date.now() + 15 * 60 * 1000;
    const rpc = rpcReader(config, deadline);
    const apiConfig = await jsonResponse(
      new URL("/v1/config", config.api),
      { method: "GET" },
      deadline,
    );
    requireValue(
      apiConfig.status === 200 &&
        apiConfig.body?.chainId === CHAIN_ID &&
        address(apiConfig.body.vaultFactoryAddress) === config.factory,
      "FRACTIONAL_API_SCOPE_MISMATCH",
    );
    const journalPath = join(config.stateDirectory, "events.json");
    let previous = {
      version: 1,
      chainId: CHAIN_ID,
      factory: config.factory,
      startBlock: config.startBlock,
      events: [],
    };
    try {
      await regularFile(journalPath);
      previous = JSON.parse(await readFile(journalPath, "utf8"));
      validateJournal(previous, config);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const snapshot = await collectFractionalSnapshot(config, rpc);
    // Do not delete a prior observation merely because a provider's finalized
    // head has temporarily regressed below it.
    requireValue(
      previous.events.every((event) => event.blockNumber <= snapshot.end),
      "FRACTIONAL_FINALIZED_HEAD_REGRESSED",
    );
    const current = new Map(
      snapshot.events.map((event) => [incarnation(event), event]),
    );
    const currentIdentities = new Set(snapshot.events.map(identity));
    const pending = new Map(
      previous.events.map((event) => [incarnation(event), event]),
    );
    for (const event of snapshot.events) pending.set(incarnation(event), event);
    requireValue(
      pending.size <= MAX_EVENTS * 2,
      "FRACTIONAL_JOURNAL_EVENT_LIMIT_EXCEEDED",
    );
    // An empty or truncated successful getLogs response is not removal proof.
    // A previously attested log cannot disappear while its block stays canonical.
    // Verify every missing incarnation before any API mutation in this batch.
    for (const event of previous.events) {
      if (current.has(incarnation(event))) continue;
      const header = await rpc("eth_getBlockByNumber", [
        `0x${event.blockNumber.toString(16)}`,
        false,
      ]);
      requireValue(
        quantity(header?.number) === event.blockNumber,
        "FRACTIONAL_RECONCILIATION_HEADER_MISSING",
      );
      requireValue(
        hash(header.hash) !== event.blockHash,
        "FRACTIONAL_SCAN_GAP_NOT_REMOVAL",
      );
    }
    // Write-ahead union retains every possibly accepted API write across an
    // interrupted batch. No endpoint, key or credential is put in this journal.
    await writeJournal(journalPath, {
      ...previous,
      events: [...pending.values()],
    });
    async function publish(event, removed) {
      const response = await jsonResponse(
        new URL("/v1/indexer/events", config.api),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Indexer-Key": config.key,
          },
          body: JSON.stringify({
            ...event,
            removed,
            confirmations: removed ? 0 : event.confirmations,
          }),
        },
        deadline,
      );
      // A resumed batch may already have replaced this old incarnation. Only
      // tolerate its removal conflict when the verified replacement is about
      // to be replayed successfully; its later conflict still fails the run.
      if (
        removed &&
        response.status === 409 &&
        currentIdentities.has(identity(event))
      )
        return;
      requireValue(
        [200, 201].includes(response.status) &&
          response.body?.status === "recorded" &&
          response.body.removed === removed,
        "FRACTIONAL_INDEX_WRITE_REFUSED",
      );
    }
    for (const event of previous.events) {
      if (!current.has(incarnation(event))) await publish(event, true);
    }
    for (const event of snapshot.events) await publish(event, false);
    const anchor = await rpc("eth_getBlockByNumber", [
      `0x${snapshot.end.toString(16)}`,
      false,
    ]);
    requireValue(
      hash(anchor?.hash) === snapshot.anchorHash,
      "FRACTIONAL_PUBLISH_REORG_DETECTED",
    );
    await writeJournal(journalPath, { ...previous, events: snapshot.events });
    return {
      chainId: CHAIN_ID,
      mode: "TEST_ONLY_NO_REAL_VALUE",
      factory: config.factory,
      fromBlock: config.startBlock,
      toBlock: snapshot.end,
      blockHash: snapshot.anchorHash,
      eventCount: snapshot.events.length,
      observedAt: new Date().toISOString(),
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runFractionalIndexer(fractionalIndexerConfig());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof IndexFailure
        ? error.code
        : "FRACTIONAL_INDEX_RUN_REFUSED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
