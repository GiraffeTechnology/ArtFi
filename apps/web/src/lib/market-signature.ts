import {
  encodeFunctionData,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const halfOrder =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const signatureABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;

/** Match the market's strict ECDSA branch, without normalizing v, s or compact signatures. */
export async function verifyCanonicalEOASignature(
  seller: Address,
  digest: Hex,
  signature: Hex,
) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const v = Number.parseInt(signature.slice(130), 16);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if ((v !== 27 && v !== 28) || s === 0n || s > halfOrder) return false;
  try {
    return (
      (await recoverAddress({ hash: digest, signature })).toLowerCase() ===
      seller.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Read the seller's code at the observed block; contract wallets receive the original bytes. */
export async function verifyMarketSignature(
  client: Pick<PublicClient, "getCode" | "call">,
  seller: Address,
  market: Address,
  digest: Hex,
  signature: Hex,
  blockNumber: bigint,
) {
  const code = await client.getCode({ address: seller, blockNumber });
  if (!code || code === "0x")
    return verifyCanonicalEOASignature(seller, digest, signature);
  const { data } = await client.call({
    to: seller,
    account: market,
    blockNumber,
    data: encodeFunctionData({
      abi: signatureABI,
      functionName: "isValidSignature",
      args: [digest, signature],
    }),
  });
  // Solidity's bytes4 ABI return occupies a full word. Short return data is not valid.
  return Boolean(data && /^0x1626ba7e0{56}(?:[0-9a-fA-F]{2})*$/i.test(data));
}
