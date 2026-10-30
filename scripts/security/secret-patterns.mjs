// Repository leak detection only: no signature recovery, signing, RPC or execution.
// Envelope layouts: EIP-2718/155/2930/1559/4844/7594/7702 at eips.ethereum.org.
// Canonical RLP rules: ethereum.org/developers/docs/data-structures-and-encoding/rlp/.
const rules = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[ps]_[A-Za-z0-9]{30,}\b/],
  [
    "raw EVM private key assignment",
    /(?:PRIVATE_KEY|SECRET_KEY)\s*=\s*0x[0-9a-fA-F]{64}\b/,
  ],
  [
    "mnemonic assignment",
    /(?:MNEMONIC|SEED_PHRASE)\s*=\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/i,
  ],
];
function refused() {
  throw new Error("RLP_SHAPE_REFUSED");
}
// Read one bounded slice. Nested lists are inspected only at known envelope positions.
function item(bytes, offset, limit) {
  if (offset >= limit) refused();
  const prefix = bytes[offset];
  if (prefix <= 0x7f) return { list: false, start: offset, end: offset + 1 };
  const list = prefix >= 0xc0;
  const base = list ? 0xc0 : 0x80;
  const short = prefix - base;
  let start = offset + 1;
  let length;
  if (short <= 55) length = short;
  else {
    const size = short - 55;
    if (start + size > limit || bytes[start] === 0) refused();
    length = 0;
    for (let i = 0; i < size; i++) {
      length = length * 256 + bytes[start + i];
      if (!Number.isSafeInteger(length) || length > limit) refused();
    }
    start += size;
    if (length < 56) refused();
  }
  const end = start + length;
  if (end > limit || (!list && length === 1 && bytes[start] < 0x80)) refused();
  return { list, start, end };
}
function children(bytes, node, maximum = Infinity) {
  if (!node?.list) refused();
  const result = [];
  let position = node.start;
  while (position < node.end) {
    if (result.length >= maximum) refused();
    const child = item(bytes, position, node.end);
    result.push(child);
    position = child.end;
  }
  return result;
}
function scalar(node, length) {
  return (
    !!node &&
    !node.list &&
    (length === undefined || node.end - node.start === length)
  );
}
function uint(bytes, node, maximum = 32) {
  return (
    scalar(node) &&
    node.end - node.start <= maximum &&
    (node.start === node.end || bytes[node.start] !== 0)
  );
}
function signature(bytes, fields, index, legacy) {
  const [v, r, s] = fields.slice(index);
  if (
    !uint(bytes, v) ||
    !uint(bytes, r) ||
    !uint(bytes, s) ||
    r.start === r.end ||
    s.start === s.end
  )
    return false;
  if (legacy) {
    // Multi-byte v values are >= 256; single-byte v must be 27/28 or EIP-155 >=35.
    return (
      v.end - v.start > 1 ||
      (v.end - v.start === 1 &&
        (bytes[v.start] === 27 ||
          bytes[v.start] === 28 ||
          bytes[v.start] >= 35))
    );
  }
  return v.start === v.end || (v.end - v.start === 1 && bytes[v.start] === 1);
}
function accessList(bytes, node) {
  for (const entry of children(bytes, node)) {
    const pair = children(bytes, entry, 2);
    if (pair.length !== 2 || !scalar(pair[0], 20)) return false;
    if (!children(bytes, pair[1]).every((key) => scalar(key, 32))) return false;
  }
  return true;
}
function authorizations(bytes, node) {
  const entries = children(bytes, node);
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const f = children(bytes, entry, 6);
    // Invalid individual authorizations may be ignored by the EVM. They do not
    // make the outer signed serialization safe to commit.
    return (
      f.length === 6 &&
      uint(bytes, f[0]) &&
      scalar(f[1], 20) &&
      uint(bytes, f[2], 8) &&
      uint(bytes, f[3], 1) &&
      uint(bytes, f[4]) &&
      uint(bytes, f[5])
    );
  });
}
function transaction(bytes, node, type) {
  const count = [9, 11, 12, 14, 13][type];
  const f = children(bytes, node, count);
  if (f.length !== count) return false;
  if (type === 0) {
    return (
      [0, 1, 2, 4].every((i) => uint(bytes, f[i])) &&
      (scalar(f[3], 0) || scalar(f[3], 20)) &&
      scalar(f[5]) &&
      signature(bytes, f, 6, true)
    );
  }
  const destination = type === 1 ? 4 : 5;
  const value = destination + 1,
    data = destination + 2,
    access = destination + 3;
  if (
    !Array.from({ length: destination }, (_, i) => i).every((i) =>
      uint(bytes, f[i]),
    ) ||
    !uint(bytes, f[value]) ||
    !scalar(f[data]) ||
    !(scalar(f[destination], 20) || (type <= 2 && scalar(f[destination], 0))) ||
    !accessList(bytes, f[access])
  )
    return false;
  if (type === 3) {
    const hashes = children(bytes, f[10]);
    if (
      !uint(bytes, f[9]) ||
      hashes.length === 0 ||
      !hashes.every((hash) => scalar(hash, 32))
    )
      return false;
  }
  if (type === 4 && !authorizations(bytes, f[9])) return false;
  return signature(bytes, f, count - 3, false);
}
function signedEnvelope(bytes) {
  if (bytes.length === 0) return false;
  const type = bytes[0] >= 0xc0 ? 0 : bytes[0];
  if (type < 0 || type > 4 || (type === 0 && bytes[0] < 0xc0)) return false;
  try {
    const root = item(bytes, type === 0 ? 0 : 1, bytes.length);
    if (!root.list || root.end !== bytes.length) return false;
    if (type === 3) {
      const f = children(bytes, root, 14);
      // Detect the signed inner transaction in both pool wrapper versions.
      // Blob/proof validity is deliberately not a condition for leak detection.
      if ((f.length === 4 || f.length === 5) && f[0].list) {
        const sidecars = f.length === 5 ? f.slice(2) : f.slice(1);
        return (
          (f.length !== 5 || uint(bytes, f[1], 1)) &&
          sidecars.every((node) => node.list) &&
          transaction(bytes, f[0], 3)
        );
      }
    }
    return transaction(bytes, root, type);
  } catch {
    return false;
  }
}
export function isSignedEvmTransactionHex(hex) {
  if (typeof hex !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(hex))
    return false;
  return signedEnvelope(Buffer.from(hex.slice(2), "hex"));
}
export function findSecretPatterns(input) {
  const bytes = Buffer.isBuffer(input) ? input : null;
  const contents = bytes ? bytes.toString("utf8") : input;
  const findings = new Set();
  if (bytes && signedEnvelope(bytes))
    findings.add("raw signed EVM transaction envelope");
  for (const [name, pattern] of rules) {
    if (pattern.test(contents)) findings.add(name);
  }
  for (const candidate of contents.matchAll(
    /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  )) {
    const octets = candidate[0].split(".").map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    if (octets[0] !== 127 && !octets.every((octet) => octet === 0)) {
      findings.add("plaintext server IPv4 address");
    }
  }
  for (const candidate of contents.matchAll(
    /(?<![A-Za-z0-9_])(?:0x)?[0-9a-f]{20,}(?![A-Za-z0-9_])/gi,
  )) {
    const hex = /^0x/i.test(candidate[0]) ? candidate[0] : "0x" + candidate[0];
    if (isSignedEvmTransactionHex(hex)) {
      findings.add("raw signed EVM transaction envelope");
      break;
    }
  }
  // Fixed rule names only. Never return transaction bytes, keys, offsets or excerpts.
  return [...findings];
}
