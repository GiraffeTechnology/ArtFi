import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
vi.mock("server-only", () => ({}));
import {
  createWholeReceiptChainReader,
  createWholeReceiptRegistrationReader,
  wholeReceiptEvents,
  type ReceiptChainLog,
  type ReceiptChainReceipt,
} from "./whole-receipt-chain";
import { receiptAuthorizationHash } from "./whole-receipt-authorization";
import {
  createReceiptLedger,
  observeFundedTrade,
  observeRegistrationRequest,
  observeRegistration,
  observeSellerPayment,
} from "./whole-receipt-ledger";

const addr = (x: string) => `0x${x.repeat(40)}` as Address;
const hash = (x: string) => `0x${x.repeat(64)}` as Hex;
const seller = addr("a"),
  buyer = addr("b"),
  collection = addr("1"),
  token = addr("2"),
  escrow = addr("3");
const transfer20 = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const transfer721 = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
const registrationAbi = parseAbi([
  "event ReceiptRegistrationConfirmed(bytes32 indexed segmentId,bytes32 indexed recordHash)",
]);
function fixture(kind: "funded" | "paid" = "funded") {
  const trade = {
    sale: {
      seller,
      buyer,
      collection,
      tokenId: 7n,
      paymentToken: token,
      price: 100n,
      salt: 1n,
      epoch: 0n,
      startsAt: 1000,
      endsAt: 2000,
    },
    domain: { chainId: 560048, verifyingContract: escrow },
    correspondence: {
      settlementId: hash("1"),
      assetRecordHash: hash("2"),
      oracleSourceId: hash("3"),
      requestHash: hash("4"),
      executionReferenceHash: hash("5"),
      previousSegment: hash("0"),
      oldCertificateHash: hash("6"),
      warehouseReceiptHash: hash("7"),
    },
  };
  const id = receiptAuthorizationHash(
    trade.sale,
    trade.domain,
    trade.correspondence,
  );
  const txHash = hash("a"),
    blockHash = hash("b"),
    code = "0x60006000" as Hex;
  const log = (
    address: Address,
    topics: readonly Hex[],
    data: Hex,
    logIndex: number,
  ): ReceiptChainLog => ({
    address,
    topics,
    data,
    logIndex,
    transactionHash: txHash,
    blockHash,
    blockNumber: 10n,
    removed: false,
  });
  const payment = log(
    token,
    encodeEventTopics({
      abi: transfer20,
      eventName: "Transfer",
      args: {
        from: kind === "funded" ? buyer : escrow,
        to: kind === "funded" ? escrow : seller,
      },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint256"), [100n]),
    0,
  );
  const nft = log(
    collection,
    encodeEventTopics({
      abi: transfer721,
      eventName: "Transfer",
      args: { from: seller, to: buyer, tokenId: 7n },
    }) as Hex[],
    "0x",
    1,
  );
  const funded = log(
    escrow,
    encodeEventTopics({
      abi: wholeReceiptEvents,
      eventName: "ReceiptFunded",
      args: { segmentId: id, seller, buyer },
    }) as Hex[],
    encodeAbiParameters(
      parseAbiParameters(
        "address,uint256,address,uint256,bytes32,bytes32,bytes32,bytes32",
      ),
      [collection, 7n, token, 100n, hash("1"), hash("4"), hash("5"), hash("0")],
    ),
    2,
  );
  const paid = log(
    escrow,
    encodeEventTopics({
      abi: wholeReceiptEvents,
      eventName: "ReceiptSellerPaid",
      args: { segmentId: id, seller },
    }) as Hex[],
    encodeAbiParameters(parseAbiParameters("address,uint256"), [token, 100n]),
    1,
  );
  const receipt: ReceiptChainReceipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: 10n,
    status: "success",
    logs: kind === "funded" ? [payment, nft, funded] : [payment, paid],
  };
  const tx = {
    hash: txHash,
    blockHash,
    blockNumber: 10n,
    from: buyer,
    to: escrow,
    value: 0n,
  };
  const client = {
    getChainId: vi.fn(async () => 560048),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => tx),
    getBlock: vi.fn(async () => ({ hash: blockHash, number: 10n })),
    getBlockNumber: vi.fn(async () => 11n),
    getCode: vi.fn(async () => code),
  };
  const config = {
    client,
    chainId: 560048,
    escrow,
    runtimeCodeHash: keccak256(code),
    confirmations: 2,
  };
  return {
    trade,
    id,
    txHash,
    blockHash,
    receipt,
    tx,
    client,
    config,
    payment,
    nft,
    funded,
    paid,
  };
}

function registrationFixture() {
  const f=fixture();
  const registration: ReceiptChainLog = {
    ...f.funded,
    topics: encodeEventTopics({abi:registrationAbi,eventName:"ReceiptRegistrationConfirmed",args:{segmentId:f.id,recordHash:hash("8")}}) as Hex[],
    data:"0x",
    logIndex:0,
  };
  f.receipt.logs=[registration];
  // Anyone may relay; historical evidence must not depend on the current holder.
  f.tx.from=addr("d");
  return {...f,registration};
}

describe("canonical registration receipt association", () => {
  it("binds the exact historical segment but does not claim Oracle authentication", async () => {
    const f=registrationFixture();
    const read=createWholeReceiptRegistrationReader(f.config);
    const result=await read(f.trade,f.txHash);
    expect(result).toEqual({kind:"registration-confirmed-onchain",segmentId:f.id,recordHash:hash("8"),reference:`560048:${f.blockHash}:${f.txHash}:0`,blockNumber:10n,blockHash:f.blockHash,transactionHash:f.txHash,oracleEvidenceAuthenticated:false});
    expect(await read(f.trade,f.txHash)).toEqual(result);
    expect(f.client.getBlock).toHaveBeenCalledTimes(4);
  });
  it.each([
    ["segment", (f: ReturnType<typeof registrationFixture>) => {f.registration.topics=[f.registration.topics[0],hash("9"),hash("8")];}],
    ["empty record", (f: ReturnType<typeof registrationFixture>) => {f.registration.topics=[f.registration.topics[0],f.id,hash("0")];}],
    ["escrow", (f: ReturnType<typeof registrationFixture>) => {f.registration.address=addr("9");}],
    ["duplicate", (f: ReturnType<typeof registrationFixture>) => {f.receipt.logs=[f.registration,{...f.registration,logIndex:1}];}],
    ["removed", (f: ReturnType<typeof registrationFixture>) => {f.registration.removed=true;}],
    ["receipt tx", (f: ReturnType<typeof registrationFixture>) => {f.receipt.transactionHash=hash("9");}],
    ["log block", (f: ReturnType<typeof registrationFixture>) => {f.registration.blockHash=hash("9");}],
    ["reverted", (f: ReturnType<typeof registrationFixture>) => {f.receipt.status="reverted";}],
    ["value", (f: ReturnType<typeof registrationFixture>) => {f.tx.value=1n;}],
    ["runtime", (f: ReturnType<typeof registrationFixture>) => {f.client.getCode.mockResolvedValue("0x6001");}],
    ["depth", (f: ReturnType<typeof registrationFixture>) => {f.client.getBlockNumber.mockResolvedValue(10n);}],
    ["chain", (f: ReturnType<typeof registrationFixture>) => {f.client.getChainId.mockResolvedValue(31337);}],
    ["reorg during read", (f: ReturnType<typeof registrationFixture>) => {f.client.getBlock.mockResolvedValueOnce({hash:f.blockHash,number:10n}).mockResolvedValue({hash:hash("9"),number:10n});}],
  ] as const)("refuses %s drift", async (_name, mutate) => {
    const f=registrationFixture();mutate(f);
    await expect(createWholeReceiptRegistrationReader(f.config)(f.trade,f.txHash)).rejects.toThrow("RECEIPT_CHAIN_EVIDENCE_INVALID");
  });
});

describe("TEST_ONLY canonical whole-receipt chain association", () => {
  it("returns funded evidence consumed by the existing ledger", async () => {
    const f = fixture();
    const event = await createWholeReceiptChainReader(f.config)(
      "funded",
      f.trade,
      f.txHash,
    );
    expect(event.kind).toBe("funded");
    if (event.kind !== "funded") throw Error("unexpected event");
    const ledger = observeFundedTrade(
      createReceiptLedger(
        {
          assetId: "asset",
          chainId: 560048,
          collection,
          tokenId: "7",
          intermediaryId: "artfi",
          registrarId: "registrar",
          oracleId: "oracle",
        },
        seller,
      ),
      event.trade,
    );
    expect(ledger.owner).toBe(buyer);
    expect(ledger.segments[0].amount).toBe(100n);
    expect(event.trade.escrowReference).not.toBe(
      event.trade.ownerTransferReference,
    );
  });
  it("allows fixed seller payment without querying current NFT holder", async () => {
    const fund = fixture();
    const funded = await createWholeReceiptChainReader(fund.config)(
      "funded",
      fund.trade,
      fund.txHash,
    );
    if (funded.kind !== "funded") throw Error("unexpected event");
    let ledger = observeFundedTrade(
      createReceiptLedger(
        {
          assetId: "asset",
          chainId: 560048,
          collection,
          tokenId: "7",
          intermediaryId: "artfi",
          registrarId: "registrar",
          oracleId: "oracle",
        },
        seller,
      ),
      funded.trade,
    );
    ledger = observeRegistrationRequest(ledger, fund.id, {
      assetId: "asset",
      sourceId: "artfi",
      reference: "request",
    });
    ledger = observeRegistration(ledger, fund.id, buyer, "request", {
      assetId: "asset",
      sourceId: "oracle",
      reference: "authenticated-fixture",
    });
    const f = fixture("paid");
    f.tx.from = addr("d");
    const event = await createWholeReceiptChainReader(f.config)(
      "paid",
      f.trade,
      f.txHash,
    );
    if (event.kind !== "paid") throw Error("unexpected event");
    expect(
      observeSellerPayment(ledger, event.segmentId, event.reference)
        .settledPrefix,
    ).toBe(1);
  });
  it.each([
    [
      "failed receipt",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.status = "reverted";
      },
    ],
    [
      "foreign transaction",
      (f: ReturnType<typeof fixture>) => {
        f.tx.to = addr("4");
      },
    ],
    [
      "wrong buyer",
      (f: ReturnType<typeof fixture>) => {
        f.tx.from = seller;
      },
    ],
    [
      "nonzero value",
      (f: ReturnType<typeof fixture>) => {
        f.tx.value = 1n;
      },
    ],
    [
      "receipt tx mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.transactionHash = hash("c");
      },
    ],
    [
      "tx block mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.tx.blockHash = hash("c");
      },
    ],
    [
      "removed log",
      (f: ReturnType<typeof fixture>) => {
        f.nft.removed = true;
      },
    ],
    [
      "log transaction mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.nft.transactionHash = hash("c");
      },
    ],
    [
      "log block mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.payment.blockHash = hash("c");
      },
    ],
    [
      "duplicate index",
      (f: ReturnType<typeof fixture>) => {
        f.nft.logIndex = 0;
      },
    ],
    [
      "missing NFT transfer",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.logs = [f.payment, f.funded];
      },
    ],
    [
      "missing escrow transfer",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.logs = [f.nft, f.funded];
      },
    ],
    [
      "missing escrow event",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.logs = [f.payment, f.nft];
      },
    ],
    [
      "spoofed emitter",
      (f: ReturnType<typeof fixture>) => {
        f.funded.address = addr("4");
      },
    ],
    [
      "wrong amount",
      (f: ReturnType<typeof fixture>) => {
        f.payment.data = encodeAbiParameters(parseAbiParameters("uint256"), [
          99n,
        ]);
      },
    ],
    [
      "wrong NFT token",
      (f: ReturnType<typeof fixture>) => {
        f.nft.topics = encodeEventTopics({
          abi: transfer721,
          eventName: "Transfer",
          args: { from: seller, to: buyer, tokenId: 8n },
        }) as Hex[];
      },
    ],
    [
      "duplicate matching event",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.logs = [...f.receipt.logs, { ...f.funded, logIndex: 3 }];
      },
    ],
    [
      "wrong event ordering",
      (f: ReturnType<typeof fixture>) => {
        f.payment.logIndex = 3;
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(
      createWholeReceiptChainReader(f.config)("funded", f.trade, f.txHash),
    ).rejects.toThrow("RECEIPT_CHAIN_EVIDENCE_INVALID");
  });
  it("rejects every changed immutable sale/correspondence input", async () => {
    for (const key of Object.keys(fixture().trade.correspondence)) {
      const f = fixture();
      (f.trade.correspondence as Record<string, Hex>)[key] = hash("e");
      await expect(
        createWholeReceiptChainReader(f.config)("funded", f.trade, f.txHash),
      ).rejects.toThrow();
    }
    const f = fixture();
    f.trade.sale.price = 101n;
    await expect(
      createWholeReceiptChainReader(f.config)("funded", f.trade, f.txHash),
    ).rejects.toThrow();
  });
  it("rejects insufficient confirmations, wrong chain, changed runtime and reorg", async () => {
    for (const mode of ["depth", "chain", "code", "block", "reorg"]) {
      const f = fixture();
      if (mode === "depth") f.client.getBlockNumber.mockResolvedValue(10n);
      if (mode === "chain") f.client.getChainId.mockResolvedValue(1);
      if (mode === "code") f.client.getCode.mockResolvedValue("0x6001");
      if (mode === "block")
        f.client.getBlock.mockResolvedValue({ hash: hash("c"), number: 10n });
      if (mode === "reorg")
        f.client.getBlock
          .mockResolvedValueOnce({ hash: f.blockHash, number: 10n })
          .mockResolvedValueOnce({ hash: hash("c"), number: 10n });
      await expect(
        createWholeReceiptChainReader(f.config)("funded", f.trade, f.txHash),
      ).rejects.toThrow();
    }
  });
  it("does not retry unavailable reads or synthesize an event", async () => {
    const f = fixture();
    f.client.getTransactionReceipt.mockRejectedValue(
      Error("TEST_ONLY_OFFLINE"),
    );
    await expect(
      createWholeReceiptChainReader(f.config)("funded", f.trade, f.txHash),
    ).rejects.toThrow();
    expect(f.client.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it("snapshots journal input before awaits", async () => {
    const f = fixture();
    f.client.getChainId.mockImplementation(async () => {
      f.trade.sale.price = 999n;
      return 560048;
    });
    const event = await createWholeReceiptChainReader(f.config)(
      "funded",
      f.trade,
      f.txHash,
    );
    expect(event.kind === "funded" && event.trade.amount).toBe(100n);
  });
  it("refuses unapproved runtime/chain and weakened confirmation configuration", () => {
    const f = fixture();
    for (const config of [
      { ...f.config, chainId: 1 },
      { ...f.config, confirmations: 1 },
      { ...f.config, runtimeCodeHash: hash("0") },
    ])
      expect(() => createWholeReceiptChainReader(config)).toThrow();
  });
});
