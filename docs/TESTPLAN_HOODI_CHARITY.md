# Test plan — charity editions on Hoodi

| Field    | Value                                                                      |
| -------- | -------------------------------------------------------------------------- |
| Scope    | Charity NFT editions (`S-CH`) only. No other product line, no other module |
| Chain    | Hoodi `560048`. Nothing here ever touches Sepolia, mainnet or a real asset |
| For      | The delivery side, to execute and report back                              |
| Standing | **Record only.** It creates no requirement — see §0                        |

## 0. What this plan is, and is not

Every check below is an **existing** requirement — `PRD.md` §4.7 `CH.1`–`CH.11`, §7.0, and the
evidence rules in `ACCEPTANCE.md` §3. This file is priority 6 in the `AGENTS.md` §1 authority order:
it restates them as an executable sequence and **adds nothing**. If a step here has no cited
requirement, it is a defect in this file, not a new obligation.

**It proves the technical path only.** Client ruling of 2026-09-19, recorded in `PRD.md` §7.0: the
test chain holds no real asset and carries no legal liability, so **no CCHS or ArtCCH document is a
precondition for any step**. Nothing in this run is evidence about money, donations, receipts or
legal effect, and no step may produce a claim about them.

**It does not promote anything by itself.** A green run is evidence; whoever records it decides what
moves in `STATUS.md`, against the six values in `ACCEPTANCE.md` §2 and on the exact reviewed commit.

---

## 1. Before starting

### 1.1 Required, and only the delivery side has them

| Input                              | Note                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hoodi RPC egress                   | Reads and writes                                                                                                                                                                                                                                                                     |
| Funded Hoodi accounts              | **Held by the delivery side** — the ERC-8415 wallet carries Hoodi test funds across two accounts (`artfi1`, `artfi2`). Funding is not a blocker. The signing method is supplied to Forge and **never written to this repository, an env file in Git, CI, or a log** (`AGENTS.md` §6) |
| The Hoodi AI test payload (`VD.3`) | `PRD.md` §7.0 makes producing it the delivery side's. It does not exist yet — **`VD.3` is `NOT-IMPLEMENTED`**                                                                                                                                                                        |
| An S3-compatible object store      | A local one is sufficient. `charity-object-store.ts` accepts an `http://127.0.0.1:…` loopback endpoint, so no production store is needed                                                                                                                                             |

**Two accounts is exactly what this plan needs.** Step E requires a holder distinct from the
distribution wallet, and Step F requires a wallet that holds **zero** units. Use one account as the
distribution wallet and the other as the holder; the zero-balance case can be a third address that
never receives anything, and it needs no funds to fail the way it must.

> **The same wallet holds Sepolia funds. This plan never spends them.**
>
> Sepolia carries the frozen real batch — 37 works, 3,700 units, a completed record of real assets
> that `PRD.md` §7.0 says **does not migrate, is never re-minted and never rewritten**. Having
> spendable Sepolia funds in the same wallet is the one way this run could do irreversible damage,
> so it is named here rather than left to care: **every transaction in this plan goes to Hoodi
> `560048`.** `DeployCharityEditions` reverts `UnsupportedChain` anywhere else, which is a guard to
> rely on, not one to route around. Touching the Sepolia batch is a stop condition (§5).

If the payload does not exist yet, produce it first under §7.0's isolation rules. **Do not
substitute the real Sepolia artworks for it under any circumstances.**

### 1.2 Fixed before the first transaction

Record these now; they are what the report is checked against.

- the commit SHA under test;
- `EDITIONS_PER_ARTWORK` and `PRIMARY_PRICE_WEI` as compiled;
- the four role addresses;
- the distribution wallet.

---

## 2. Isolation rules — breaking any one of these stops the run

From `PRD.md` §7.0. Each is an audit failure, not a warning. If one breaks, **stop and report**;
do not continue and note it afterwards.

1. **Its own namespace.** Never written into `release/mint-batches/ye-yongrun-unit-a01-a38` or any
   existing batch directory.
2. **Its own deployment.** Never the Sepolia `ArtFiCharityEditions` instance. The deploy script
   reverts `UnsupportedChain` off Hoodi — do not work around that.
3. **No real artist's name, signature, work title or style description**, and no image that could
   be confused with a real work.
4. **Never in a production or mainnet manifest.**
5. **No CCHS donation, receipt, valuation or holder-advantage language anywhere in the payload.**
   That path belongs to the real batch alone. Its absence is the point, not an omission to fix.

And the markers. `TESTNET`, `NO REAL-WORLD VALUE`, `NO LEGAL EFFECT` must be present in **all four**
places §7.0 names: token metadata, contract or series level at deployment, on screen wherever the
set is displayed, and as a top-level field in the batch manifest. **Check all four. Three is a
failure.**

---

## 3. The sequence

### Step A — Deploy

```bash
# Roles are addresses, not keys. The signing method is supplied to Forge.
export ARTFI_ADMIN=0x… ARTFI_EDITION_CREATOR=0x… ARTFI_DONATION_RECORDER=0x… ARTFI_PAUSER=0x…
forge script script/DeployCharityEditions.s.sol --rpc-url <hoodi> --broadcast
```

Then fill a deployment manifest from
`packages/contracts/deployments/sepolia-charity-editions.example.json`, **with `chainId` set to
`560048`** — the example carries Sepolia's `11155111` and is a template, not a value to copy.

**Capture:** deployment transaction hash, contract address, runtime bytecode SHA-256, the four role
addresses as actually set on chain, block number.

**Proves:** the contract deploys and its roles are what the manifest claims.
**Does not prove:** anything about a series, a holder, or a file.

### Step B — Create one series from the test payload

Call `createSeries(artworkId, masterArtworkHash, metadataHash, distributionWallet, metadataURI)`.

**Capture:** transaction hash, the emitted `SeriesCreated`, the resulting token ID, and a read-back
of `series(tokenId)`, `totalSupply(tokenId)` and `balanceOf(distributionWallet, tokenId)`.

**Assert:**

- `totalSupply == 100` exactly — `CH.1`;
- the distribution wallet holds all 100 at creation;
- the recorded unit price reads `0.01 ETH` — `CH.2`;
- the metadata carries the three §7.0 markers and **no** artwork preview field — `CH.7`.

### Step C — Prove the supply is fixed

Four rejections, each its own transaction attempt. **Capture the revert reason for each.**

| Attempt                                           | Must revert with         | Requirement |
| ------------------------------------------------- | ------------------------ | ----------- |
| A second series with the same `artworkId`         | `DuplicateArtwork`       | `CH.1`      |
| A second series with the same `masterArtworkHash` | `DuplicateMasterArtwork` | `CH.1`      |
| `recordSellout` while the distributor holds units | `SeriesNotSoldOut`       | `CH.3`      |
| `recordPhysicalDonation` before any sellout       | `SelloutNotRecorded`     | `CH.4`      |

There is no additional-mint and no external burn entry point. **Do not add one to test one.**

### Step D — Read it back from the UI

Configure and start the web app:

```
NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS=<contract>
NEXT_PUBLIC_HOODI_RPC_URL=<hoodi>
ARTFI_CHARITY_EDITIONS_ADDRESS=<contract>
ARTFI_CHARITY_HOLDER_SESSION_SECRET=<32+ chars>
```

Open `/charity` and `/charity/<tokenId>`, **desktop and mobile**.

**Capture:** screenshots of both at both widths.

**Assert:**

- every figure matches the chain read from Step B — not approximately, exactly;
- `Artwork preview: Not provided`, and **no image element anywhere on either page** — `CH.7`;
- the rights notice states all four `CH.8`/`CH.9` facts on both pages — `CH.8`;
- the §7.0 markers are on screen — this is the third of the four places;
- **no buy, bid, offer or settle control exists** — `CH.2`.

Then a negative: point the app at an address with no series and confirm it reports unavailable and
lists nothing. **An empty page that looks healthy is a failure** — `ACCEPTANCE.md` §3.

### Step E — The holder benefit, end to end

This is `CH.5`, and it is the step that has never been executed anywhere.

1. Transfer some units from the distribution wallet to the second account (§1.1).
2. Put a **watermarked** test file in the object store. It must **not** be byte-identical to the
   master and must not hash to the master's digest — `CH.11`.
3. Configure the descriptor and the store:

```
ARTFI_CHARITY_HOLDER_ASSET_MANIFEST={"<tokenId>":{"class":"watermarked-holder","tokenId":"<tokenId>","sha256":"…","masterSha256":"…","contentType":"image/png","byteLength":…,"objectKey":"…"}}
ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT=http://127.0.0.1:9000
ARTFI_CHARITY_HOLDER_OBJECT_BUCKET=…
ARTFI_CHARITY_HOLDER_OBJECT_ACCESS_KEY_ID=…
ARTFI_CHARITY_HOLDER_OBJECT_SECRET_ACCESS_KEY=…
```

4. From `/charity/<tokenId>`, connect the **holding** wallet, verify ownership, and download.

**Capture:** the SHA-256 of the file actually received, and the response headers.

**Assert:**

- the received digest equals the descriptor's `sha256` and **differs from the master's** — `CH.11`;
- `Content-Disposition: attachment` and the file does not render inline — `CH.6`;
- the page never displayed the master and no route served it — `CH.6`.

### Step F — Prove the gate is real

The same flow, but each of these **must fail**, and the report must say how. Capture status codes.

| Attempt                                                         | Expected              | Requirement |
| --------------------------------------------------------------- | --------------------- | ----------- |
| Request the file with no verification at all                    | `401`                 | `CH.5`      |
| Verify with a wallet that holds **zero** units                  | `403`                 | `CH.5`      |
| Verify for token A, then request token B's file with that grant | `401`                 | `CH.5`      |
| Point the descriptor's `sha256` at the master's digest          | `409`, nothing served | `CH.11`     |
| Swap the stored object for the master, leaving the descriptor   | `409`, nothing served | `CH.6`      |
| Unset the object store, keep the descriptor                     | `503`, nothing served | `CH.5`      |

**A step that yields bytes where the table says it must not is the most serious result this plan can
produce. Stop and report it immediately.**

### Step G — Lifecycle, in order

1. Move all remaining units out of the distribution wallet.
2. `recordSellout` — now it must succeed. **Capture the receipt** — `CH.3`.
3. `recordPhysicalDonation` — now it must succeed. **Capture the receipt** — `CH.4`.
4. `recordPhysicalDonation` again — must revert `PhysicalDonationAlreadyRecorded` — `CH.4`.
5. `pause`, then attempt a series creation and a transfer; both must be blocked. `unpause`.

### Step H — A release package for the series you created

Build a package manifest for it and run:

```bash
node scripts/release/verify-charity-edition-package.mjs <manifest.json> --local-assets
```

Include `holderAsset.file` and `holderAsset.sha256` — the 37 frozen packages predate that binding,
so **this is the first package for which `CH.11`'s packaging half can be proven at all**.

**Assert:** it passes, and the output reports `holderAssetDistinctFromMaster: true`.

Then confirm the verifier still refuses what it must: set `artworkId` to `UNIT-A02` and re-run — it
must reject by name — `PRD.md` §8.4 and `ACCEPTANCE.md` §7.9.

---

## 4. What to report back

One report, against the commit SHA fixed in §1.2. Per `ACCEPTANCE.md` §3, a claim without a citation
is not evidence.

**Per step:** what ran, the transaction hashes and receipts, the exact assertion outcomes, and the
screenshots for Step D.

**Then, plainly:**

- **What passed**, with its evidence.
- **What failed**, with the actual output — not a description of it.
- **What was not run**, and why. A skipped step is a result; recording it as untested costs nothing
  and hiding it costs the next person a day.
- **Anything observed that this plan did not anticipate.** That is the most useful part of any run.

**Do not** mark any `STATUS.md` row `VERIFIED` as part of executing this. The run produces evidence;
promotion is a separate decision against the exact reviewed commit.

---

## 5. Stop conditions

Stop the run and report immediately if any of these occurs. None of them is something to work
around.

- Any §2 isolation rule breaks.
- Any Step F row yields bytes.
- A master is reachable by any route, or appears in any public object or metadata field.
- The deploy script is asked to run on a chain other than Hoodi.
- A key, seed phrase or credential would have to be written into the repository, CI or a log to
  continue.
- The real Sepolia batch or its artworks would have to be touched, re-minted or rewritten.

## 6. What a fully green run does and does not establish

**Does:** the charity path works end to end on a test chain — deploy, fixed supply, the refusals
that keep it fixed, the UI reading real chain state, a verified holder receiving a watermarked file
that is provably not the master, the lifecycle order, and a package that passes the verifier.

**Does not:** say anything about real assets, money, donations, receipts, tax or legal effect;
establish production readiness, availability or operations; or clear `G3-A`, `G3-B` or `G4`. It is
the technical path, which is exactly what the client asked it to be.
