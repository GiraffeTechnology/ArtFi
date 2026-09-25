# Deployment and test requirements — charity editions on Hoodi

| Field    | Value                                                                      |
| -------- | -------------------------------------------------------------------------- |
| Scope    | Charity NFT editions (`S-CH`) only. No other product line, no other module |
| Chain    | Hoodi `560048`. Nothing here ever touches Sepolia, mainnet or a real asset |
| For      | The delivery side, to deploy, execute and report back                      |
| Standing | **Record only.** It creates no requirement — see §0                        |

## 0. What this document is, and is not

Every requirement below is an **existing** one — `PRD.md` §4.7 `CH.1`–`CH.11`, §7.0, the topology
ruling of 2026-09-05 (#74), and the evidence rules in `ACCEPTANCE.md` §3. This file is priority 6 in
the `AGENTS.md` §1 authority order: it restates them as an executable sequence and **adds nothing**.
If a step here has no cited requirement, it is a defect in this file, not a new obligation.

**It proves the technical path only.** Client ruling of 2026-09-19, recorded in `PRD.md` §7.0: the
test chain holds no real asset and carries no legal liability, so **no CCHS or ArtCCH document is a
precondition for any step**. Nothing here is evidence about money, donations, receipts or legal
effect, and no step may produce a claim about them.

**It promotes nothing by itself.** A green run is evidence; whoever records it decides what moves in
`STATUS.md`, against the six values in `ACCEPTANCE.md` §2 and on the exact reviewed commit.

---

## 1. Naming rule — no real address, host or IP, anywhere

**#110 §4 and `ACCEPTANCE.md` §7.8.** Every endpoint in this document is a placeholder, and the rule
applies to what the run produces as much as to the run itself:

| Placeholder           | Means                                              |
| --------------------- | -------------------------------------------------- |
| `<HOODI_RPC>`         | The Hoodi JSON-RPC endpoint                        |
| `<OBJECT_STORE>`      | The S3-compatible endpoint holding the holder file |
| `<OBJECT_BUCKET>`     | Its bucket                                         |
| `<WEB_ORIGIN>`        | The origin the web app is served from              |
| `<EDITIONS_CONTRACT>` | The deployed Hoodi contract address                |

**Never written into this repository, a report, a commit message, a log or a screenshot:** a real
hostname, a real IP address, an internal topology detail, a bucket name that identifies an
organization, or any key, seed phrase or credential (`AGENTS.md` §6).

**Screenshots are the easy way to leak one.** Step E captures browser screenshots, and a browser
shows its address bar. **Serve the app from `localhost` for the run, or crop the address bar.** A
contract address is public on chain and may be recorded; a host is not.

---

## 2. What the charity path actually needs

Verified against the code, because deploying more than is needed is its own risk.

### 2.1 Required

| Component              | Why                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hoodi RPC access       | Both browser and server read the chain directly                                                                                                                        |
| `ArtFiCharityEditions` | Deployed on Hoodi                                                                                                                                                      |
| The web runtime        | `/charity`, `/charity/[tokenId]` and the four `/api/charity/*` routes                                                                                                  |
| An S3-compatible store | Holds the watermarked holder file. **A loopback endpoint is sufficient** — `charity-object-store.ts` accepts `http://127.0.0.1:…` and requires HTTPS for anything else |

### 2.2 Not required — do not stand these up for this run

**The charity path never calls the Go API, MySQL or Redis.** `/charity` and `/charity/[tokenId]`
read the contract through the browser's chain client; the four API routes are Next.js server routes
that read the chain, an env-held descriptor and the object store. No charity component references
`NEXT_PUBLIC_API_URL`.

If a charity step appears to need a database, **stop** — either the step is wrong, or something
outside this scope is being exercised.

### 2.3 Two accounts, three roles

The delivery side holds Hoodi test funds in the ERC-8415 wallet across two accounts (`artfi1`,
`artfi2`). **Funding is not a blocker.** They map onto what the run needs:

| Role                | Use               | Why                                                                                          |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Distribution wallet | `artfi1`          | Receives all 100 units at series creation                                                    |
| Holder              | `artfi2`          | §6 F requires a holder **distinct from** the distribution wallet                             |
| Zero-balance wallet | any third address | §6 G requires a wallet holding **zero** units. **It needs no funds** to fail the way it must |

> **The same wallet holds Sepolia funds. This plan never spends them.**
>
> Sepolia carries the frozen real batch — 37 works, 3,700 units, a completed record of real assets
> that `PRD.md` §7.0 says **does not migrate, is never re-minted and never rewritten**. Spendable
> Sepolia funds in the wallet running a Hoodi plan is the one way this run could do irreversible
> damage, so it is named here rather than left to care: **every transaction goes to Hoodi
> `560048`.** `DeployCharityEditions` reverts `UnsupportedChain` anywhere else — a guard to rely on,
> not one to route around. Touching the Sepolia batch is a stop condition (§8).

---

## 3. Deployment requirements

### 3.1 The execution-zone gate — read this before debugging anything

`charity-holder-auth.ts` **refuses to read the chain** unless the runtime declares itself in the
approved execution zone:

```
ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE=sin
```

Without it, ownership verification throws `Charity holder chain verification is restricted to the
SIN execution zone`, and §6 F and G fail for a reason that has nothing to do with charity logic.
This is the topology ruling of 2026-09-05 (#74) enforced in code: public-chain operation runs in the
approved zone, and the check **fails closed** rather than assuming.

**Set it deliberately, and only where the ruling allows.** Setting it to make a test pass in a zone
the ruling does not cover defeats the control rather than satisfying it — report that instead.

### 3.2 Environment

Server-side. **None of these may be committed.**

| Variable                                        | Value                                  | Requirement    |
| ----------------------------------------------- | -------------------------------------- | -------------- |
| `ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE`             | `sin`                                  | §3.1           |
| `ARTFI_RPC_URL`                                 | `<HOODI_RPC>`                          | `CH.5`         |
| `ARTFI_CHARITY_EDITIONS_ADDRESS`                | `<EDITIONS_CONTRACT>`                  | `CH.5`         |
| `ARTFI_CHARITY_HOLDER_SESSION_SECRET`           | 32+ characters, random                 | `CH.5`         |
| `ARTFI_WEB_URL`                                 | `<WEB_ORIGIN>` — HTTPS, or `localhost` | `CH.5`         |
| `ARTFI_CHARITY_HOLDER_ASSET_MANIFEST`           | the reviewed descriptor, §3.4          | `CH.6`         |
| `ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT`          | `<OBJECT_STORE>`                       | `CH.5`         |
| `ARTFI_CHARITY_HOLDER_OBJECT_BUCKET`            | `<OBJECT_BUCKET>`                      | `CH.5`         |
| `ARTFI_CHARITY_HOLDER_OBJECT_ACCESS_KEY_ID`     | store credential                       | `AGENTS.md` §6 |
| `ARTFI_CHARITY_HOLDER_OBJECT_SECRET_ACCESS_KEY` | store credential                       | `AGENTS.md` §6 |

Browser-side. **A public contract address only — never a signer or a credential.**

| Variable                                     | Value                 |
| -------------------------------------------- | --------------------- |
| `NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS` | `<EDITIONS_CONTRACT>` |
| `NEXT_PUBLIC_HOODI_RPC_URL`                  | `<HOODI_RPC>`         |

A **partial** object-store configuration is treated as none, by design: the run reports delivery
unavailable rather than guessing the rest of a credential set.

### 3.3 The object store

One bucket, **not public**. `CH.6` keeps charity masters out of public storage, and this store is
deliberately separate from the `R2_*` bucket, which is published under a public base URL.

Put two files in it for the run:

- a **master** stand-in, from the test payload;
- a **watermarked** holder file that is **not** byte-identical to the master and does **not** hash to
  the master's digest (`CH.11`).

### 3.4 The descriptor

`ARTFI_CHARITY_HOLDER_ASSET_MANIFEST` is JSON keyed by token ID:

```json
{
  "<tokenId>": {
    "class": "watermarked-holder",
    "tokenId": "<tokenId>",
    "sha256": "<digest of the watermarked file>",
    "masterSha256": "<digest of the master>",
    "contentType": "image/png",
    "byteLength": 0,
    "objectKey": "<key in the bucket>"
  }
}
```

Every field is checked. A missing class, a digest equal to `masterSha256`, or any `previewUrl` is
refused and yields no bytes.

### 3.5 Secrets

The signing method is supplied to Forge. **No key, seed phrase or credential is written to this
repository, an env file in Git, CI, or a log** (`AGENTS.md` §6). Role variables hold **addresses**,
not keys.

---

## 4. Before the first transaction

### 4.1 Preconditions the delivery side owns

| Input                              | State                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Hoodi RPC egress                   | Required                                                                                                      |
| Funded Hoodi accounts              | **Held** — §2.3                                                                                               |
| The Hoodi AI test payload (`VD.3`) | **Does not exist yet.** `VD.3` is `NOT-IMPLEMENTED`, and `PRD.md` §7.0 makes producing it the delivery side's |
| An S3-compatible store             | Loopback is sufficient — §2.1                                                                                 |

If the payload does not exist, produce it first under §5. **Do not substitute the real Sepolia
artworks for it under any circumstances.**

### 4.2 Fixed and recorded now

These are what the report is checked against: the commit SHA under test; `EDITIONS_PER_ARTWORK` and
`PRIMARY_PRICE_WEI` as compiled; the four role addresses; the distribution wallet.

---

## 5. Isolation rules — breaking any one stops the run

From `PRD.md` §7.0. Each is an audit failure, not a warning. **Stop and report**; do not continue
and note it afterwards.

1. **Its own namespace.** Never written into `release/mint-batches/ye-yongrun-unit-a01-a38` or any
   existing batch directory.
2. **Its own deployment.** Never the Sepolia `ArtFiCharityEditions` instance.
3. **No real artist's name, signature, work title or style description**, and no image that could be
   confused with a real work.
4. **Never in a production or mainnet manifest.**
5. **No CCHS donation, receipt, valuation or holder-advantage language anywhere in the payload.**
   That path belongs to the real batch alone. Its absence is the point, not an omission to fix.

And the markers. `TESTNET`, `NO REAL-WORLD VALUE`, `NO LEGAL EFFECT` must appear in **all four**
places §7.0 names: token metadata, contract or series level at deployment, on screen wherever the
set is displayed, and as a top-level field in the batch manifest. **Check all four. Three is a
failure.**

---

## 6. The sequence

### A — Deploy

```bash
# Roles are addresses, not keys. The signing method is supplied to Forge.
export ARTFI_ADMIN=0x… ARTFI_EDITION_CREATOR=0x… ARTFI_DONATION_RECORDER=0x… ARTFI_PAUSER=0x…
forge script script/DeployCharityEditions.s.sol --rpc-url <HOODI_RPC> --broadcast
```

Fill a deployment manifest from
`packages/contracts/deployments/sepolia-charity-editions.example.json`, **with `chainId` set to
`560048`** — the example carries Sepolia's `11155111` and is a template, not a value to copy.

**Capture:** deployment transaction hash, contract address, runtime bytecode SHA-256, the four role
addresses **as actually set on chain**, block number.

**Proves:** the contract deploys and its roles are what the manifest claims.
**Does not prove:** anything about a series, a holder, or a file.

### B — Deployment verification, before any charity test

Prove the environment is what §3 requires, so that a later failure is a charity failure and not a
configuration one.

- `EDITIONS_PER_ARTWORK` reads `100` and `PRIMARY_PRICE_WEI` reads `10000000000000000` **from the
  deployed contract**, not from source;
- the web runtime answers `/api/health` with `chainId: 560048`;
- `/operations` reports **Chain: ok** against Hoodi, and names no endpoint or host;
- the object store answers a signed read for the holder key.

### C — Create one series from the test payload

Call `createSeries(artworkId, masterArtworkHash, metadataHash, distributionWallet, metadataURI)`.

**Capture:** transaction hash, the emitted `SeriesCreated`, the token ID, and a read-back of
`series(tokenId)`, `totalSupply(tokenId)` and `balanceOf(distributionWallet, tokenId)`.

**Assert:** `totalSupply == 100` exactly (`CH.1`); the distribution wallet holds all 100 at creation;
the recorded unit price reads `0.01 ETH` (`CH.2`); the metadata carries the three §5 markers and
**no** artwork preview field (`CH.7`).

### D — Prove the supply is fixed

Four rejections, each its own attempt. **Capture the revert reason for each.**

| Attempt                                           | Must revert with         | Requirement |
| ------------------------------------------------- | ------------------------ | ----------- |
| A second series with the same `artworkId`         | `DuplicateArtwork`       | `CH.1`      |
| A second series with the same `masterArtworkHash` | `DuplicateMasterArtwork` | `CH.1`      |
| `recordSellout` while the distributor holds units | `SeriesNotSoldOut`       | `CH.3`      |
| `recordPhysicalDonation` before any sellout       | `SelloutNotRecorded`     | `CH.4`      |

There is no additional-mint and no external burn entry point. **Do not add one to test one.**

### E — Read it back from the UI

Open `/charity` and `/charity/<tokenId>`, **desktop and mobile**. **Capture screenshots at both
widths, with no host visible (§1).**

**Assert:** every figure matches the chain read from C — exactly, not approximately;
`Artwork preview: Not provided` (`CH.7`); the rights notice states all four `CH.8`/`CH.9` facts on
both pages (`CH.8`); the §5 markers are on screen — the third of the four places; and **no buy, bid,
offer or settle control exists** (`CH.2`).

**On images, assert the source and not the count.** `CH.7` is "public token **metadata** contains no
artwork preview", and its own text allows an external marketplace to show a generic missing-image
treatment; `CH.6` forbids the **master** reaching a browser. Neither forbids site chrome. So:

- every `<img>` on a charity surface resolves to the static `/brand/` assets — the brand mark is
  `next/image`-rewritten, so decode `/_next/image?url=…` before reading the origin;
- **none** resolves to a `/api/charity/…` route, a `holder-asset` path, or the object store.

> **Corrected after the first run.** This step previously read "no image element anywhere on either
> page", which is stricter than `CH.7` and `CH.6` require, and the run correctly reported the two
> brand images against it. That was a defect in this document, not in the product. Judging an image
> by its filename is the same mistake one level down — the brand mark is
> `artcch-logo-master.svg`, and a naive `master` pattern flags it — so the assertion is on where the
> image is served from.

Then a negative: point the app at an address with no series. It must report unavailable and list
nothing. **An empty page that looks healthy is a failure** — `ACCEPTANCE.md` §3.

### F — The holder benefit, end to end

`CH.5`, and the step that has never been executed anywhere.

1. Transfer units from the distribution wallet to the second account (§2.3).
2. From `/charity/<tokenId>`, connect the **holding** wallet, verify ownership, download.

**Capture:** the SHA-256 of the file actually received, and the response headers.

**Assert:** the received digest equals the descriptor's `sha256` and **differs from the master's**
(`CH.11`); `Content-Disposition: attachment` and the file does not render inline (`CH.6`); the page
never displayed the master and no route served it (`CH.6`).

### G — Prove the gate is real

Each **must fail**, and the report must say how. **Capture status codes.**

| Attempt                                                         | Expected              | Requirement |
| --------------------------------------------------------------- | --------------------- | ----------- |
| Request the file with no verification at all                    | `401`                 | `CH.5`      |
| Verify with a wallet that holds **zero** units                  | `403`                 | `CH.5`      |
| Verify for token A, then request token B's file with that grant | `401`                 | `CH.5`      |
| Point the descriptor's `sha256` at the master's digest          | `409`, nothing served | `CH.11`     |
| Swap the stored object for the master, leaving the descriptor   | `409`, nothing served | `CH.6`      |
| Unset the object store, keep the descriptor                     | `503`, nothing served | `CH.5`      |

**A row that yields bytes where the table says it must not is the most serious result this document
can produce. Stop and report it immediately.**

### H — Lifecycle, in order

1. Move all remaining units out of the distribution wallet.
2. `recordSellout` — must now succeed. **Capture the receipt** (`CH.3`).
3. `recordPhysicalDonation` — must now succeed. **Capture the receipt** (`CH.4`).
4. `recordPhysicalDonation` again — must revert `PhysicalDonationAlreadyRecorded` (`CH.4`).
5. `pause`, then attempt a series creation and a transfer; both must be blocked. `unpause`.

### I — A release package for the series you created

```bash
node scripts/release/verify-charity-edition-package.mjs <manifest.json> --local-assets
```

Include `holderAsset.file` and `holderAsset.sha256` — the 37 frozen packages predate that binding,
so **this is the first package for which `CH.11`'s packaging half can be proven at all**.

**The manifest is a test-payload manifest, and the verifier now knows the difference.** Set
`chainId` to `560048`, give the series an artwork id **outside** the real batch's `UNIT-` namespace,
publish its metadata **outside** `…/sepolia/ye-yongrun/`, and declare §7.0's fourth place:

```json
"testAssetMarkers": ["TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"]
```

Each of those is enforced, and the mirror of each is too: the Sepolia real batch is rejected if it
declares the markers, because a frozen record of real assets that called itself valueless would be
false.

> **Corrected after the first run.** The verifier previously hard-required `chainId === 11155111`,
> a `UNIT-` artwork id and the real batch's metadata path, so **this step could not have passed on
> Hoodi at any point** — a defect in the verifier and in this document, found while fixing step E
> rather than by reaching step I. `PRD.md` §7.0 is titled "two payloads, two chains"; the verifier
> now branches on that instead of knowing only one of them.

**Assert:** it passes and reports `holderAssetDistinctFromMaster: true`. Then set `artworkId` to
`UNIT-A02` and re-run: it must reject by name (`PRD.md` §8.4, `ACCEPTANCE.md` §7.9).

Then `CH.10`, which nothing else in this sequence reaches. The verifier requires
`rights.listingActionConfirmed` to be exactly `false` — a package that claims a listing action was
confirmed must not pass. Re-run twice more:

| `rights.listingActionConfirmed` | Expected             | Requirement |
| ------------------------------- | -------------------- | ----------- |
| `true`                          | rejected             | `CH.10`     |
| absent from the manifest        | rejected, not passed | `CH.10`     |

The second row is the one worth running: a missing field must fail closed rather than be read as a
default.

---

## 7. What to report back

One report, against the commit SHA fixed in §4.2. Per `ACCEPTANCE.md` §3, a claim without a citation
is not evidence.

**Per step:** what ran, transaction hashes and receipts, the exact assertion outcomes, and the
screenshots from E — **with no host or IP visible**.

**Then, plainly:**

- **What passed**, with its evidence.
- **What failed**, with the actual output — not a description of it.
- **What was not run**, and why. A skipped step is a result; recording it as untested costs nothing
  and hiding it costs the next person a day.
- **Anything observed that this document did not anticipate.** That is the most useful part of any
  run.

**Do not** mark any `STATUS.md` row `VERIFIED` as part of executing this. The run produces evidence;
promotion is a separate decision against the exact reviewed commit.

---

## 8. Stop conditions

Stop and report immediately. None of these is something to work around.

- Any §5 isolation rule breaks.
- Any §6 G row yields bytes.
- A master is reachable by any route, or appears in any public object or metadata field.
- The deploy script is asked to run on a chain other than Hoodi.
- A key, seed phrase or credential would have to be written into the repository, CI or a log to
  continue.
- A real host, IP or internal topology detail would have to appear in the report or a screenshot.
- The real Sepolia batch or its artworks would have to be touched, re-minted or rewritten.

## 9. Teardown

The deployment is a test artifact. Keep the manifest, the transaction hashes and the report — that
is the evidence. **Remove the object-store credentials from the runtime afterwards**, and leave the
descriptor manifest unset once the run is over, so a later environment cannot serve a holder file
nobody is watching.

Do **not** delete the on-chain record. It is immutable and it is the proof.

## 10. What a fully green run does and does not establish

**Does:** the charity path works end to end on a test chain — deploy, fixed supply, the refusals
that keep it fixed, the UI reading real chain state, a verified holder receiving a watermarked file
that is provably not the master, the lifecycle order, and a package that passes the verifier.

**Does not:** say anything about real assets, money, donations, receipts, tax or legal effect;
establish production readiness, availability or operations; or clear `G3-A`, `G3-B` or `G4`. It is
the technical path, which is exactly what the client asked it to be.

---

## 11. Assignment and coverage

**Owner: the delivery side (Codex).** Client instruction, 2026-09-19. The supervision side wrote
these requirements and cannot execute them — no chain egress and no funded wallet — so this document
is the whole of the brief. Where it is wrong or incomplete, say so in the report rather than working
around it silently; §7's last bullet exists for exactly that.

All eleven `CH` rows in `docs/STATUS.md` are `IMPLEMENTED-NOT-VERIFIED`. This run is the runtime
evidence they lack. It does not promote them — §7 is explicit, and promotion is a separate decision
against the exact reviewed commit under `ACCEPTANCE.md` §3.

| Row     | Steps that produce its evidence | Note                                                                                  |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `CH.1`  | C, D                            | 100 units exactly, and the two duplicate rejections                                   |
| `CH.2`  | C, E                            | Price read from the deployed contract; no buy, bid, offer or settle control on screen |
| `CH.3`  | D, H                            | Refused before sellout, accepted after                                                |
| `CH.4`  | D, H                            | Refused before sellout, accepted after, refused on replay                             |
| `CH.5`  | F, G                            | The benefit end to end, and all six ways it must fail closed                          |
| `CH.6`  | F, G                            | Master never served, never rendered, and the swapped-object rejection                 |
| `CH.7`  | C, E                            | No preview field in metadata, no image element on either page                         |
| `CH.8`  | E                               | The rights notice on both pages, desktop and mobile                                   |
| `CH.9`  | E                               | **Disclosure half only** — see below                                                  |
| `CH.10` | I                               | Added above; nothing else in the sequence reaches it                                  |
| `CH.11` | F, G, I                         | Holder file differs from master by hash, at runtime and in the package                |

**Two rows this run cannot fully establish, stated so the report does not overclaim.**

- **`CH.9`** is "proceeds to the CCHS wallet; ArtFi issues no receipt". On a test chain there are no
  proceeds. The run can prove the disclosure is on screen and that ArtFi exposes no settlement or
  receipt path at all; it cannot prove where real money went, and must not be written up as though
  it did.
- **`CH.2`**'s second half is the same shape: that ArtFi settles nothing is proven by the absence of
  a control and a path, not by a payment that was observed to go elsewhere.

This is the §10 distinction applied per row. A green run here establishes that the technical path
works on Hoodi. It establishes nothing economic and nothing legal, and no CCHS or ArtCCH document is
a precondition for any of it (`PRD.md` §7.0).

---

## 12. Where the charity module stands — close-out, 2026-09-25

Written against the branch as it is, with each claim checked rather than recalled.

### 12.1 Built, and green without a chain

| Layer     | What exists                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Contract  | `ArtFiCharityEditions.sol` + `DeployCharityEditions.s.sol` (Hoodi-gated). `CharityEditions.t.sol`: **9 tests pass**                    |
| Web       | `/charity`, `/charity/[tokenId]`, six components, four `/api/charity/*` routes, five `lib/charity-*` modules with their unit tests     |
| Browser   | `charity-editions.spec.ts`, `charity-editions-populated.spec.ts`, `charity-test-asset-markers.spec.ts`                                 |
| Packaging | `verify-charity-edition-package.mjs` and its regression suite; the 37 frozen packages verify unchanged, 3,700 units, 0 public previews |

All four verifier gates pass: schema, verifier regression, frozen batch, and the Hoodi deployment
record.

### 12.2 §7.0's four marker places

| Place                        | State                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| 1 · token metadata           | **Open.** It lives in the `VD.3` test payload, which is `NOT-IMPLEMENTED` |
| 2 · contract or series level | Done — `release/hoodi-admin-safe-deployment.*`, enforced by its verifier  |
| 3 · on screen                | Done — `CharityTestAssetMarkers` on both surfaces, desktop and mobile     |
| 4 · batch manifest           | Done — required on a test payload, forbidden on the real batch            |

Place 2 is recorded as **correctable** (`AGENTS.md` §5). §7.0 says "at contract or series level at
deployment", which could also mean on-chain. The deployment record is the reading that needs no
contract change and no redeploy; putting it on chain would cost both, and steps A–D would have to
be run again. If that is wanted, it is an additive contract change, not a redesign.

### 12.3 Runtime: incomplete, and nothing is promoted

The Hoodi run of 2026-09-20 reached **A–D**. **E** failed on two findings; both are fixed — the
on-screen markers were genuinely missing, and this document's own "no image element anywhere"
assertion was stricter than `CH.7` and `CH.6` require. **F–I were never executed**, correctly, since
§5 stops the run on an isolation failure.

**All eleven `CH` rows remain `IMPLEMENTED-NOT-VERIFIED` and no status value has moved.** Three
reasons, each sufficient on its own: the run did not finish; A–D ran against a commit older than the
step E fix; and the receipts are held by the delivery side and have not been filed against a
reviewed commit per `ACCEPTANCE.md` §3.

### 12.4 What would close it

One complete A–I run on the current commit, reported per §7, then a separate promotion decision.
The `VD.3` payload is the only prerequisite still missing, and producing it is the delivery side's
(`PRD.md` §7.0). Nothing else is waiting on anything: no client decision is open on this module, and
the supervision side has no further code to write for it until a run says otherwise.
