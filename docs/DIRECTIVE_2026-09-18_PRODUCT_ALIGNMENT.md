# Client directive — product positioning alignment

| Field     | Value                                                     |
| --------- | --------------------------------------------------------- |
| Issued    | 2026-09-18                                                |
| Issuer    | Client (ArtCCH)                                           |
| Authority | Explicit later client ruling (`AGENTS.md` §1, priority 2) |
| Scope     | Documentation and product constraint layer only           |
| Applies   | `GiraffeTechnology/ArtFi`, all branches                   |

---

## 0. Nature of this directive

This is a ruling, not a proposal. It corrects the product narrative. It does **not** redesign ArtFi,
and it changes no code, no contract, and no requirement status.

It is the source that `README.md`, `AGENTS.md` §1.1 and `PRD.md` §1 now cite.

---

## 1. Product positioning

**ArtFi is a commercial application, not a demo.**

ArtFi is a digital art and RWA asset platform supporting three product lines:

1. ERC-8415 based asset products
2. Artwork investment products
3. Charity NFT editions

---

## 2. Asset models

### A. Full artwork asset receipt

Purpose: enable individual artwork ownership representation and transfer.

```text
Artwork → Custody → Registry → ERC-8415 asset representation → Market transfer
```

A token may represent one specific artwork custody certificate.

### B. Artwork investment fund

Purpose: create an asset-specific investment product.

```text
Artwork → Single-asset fund → Fund token → DAO governance
```

The fund token represents investor participation. Each artwork may form an independent investment
product with tokenized participation and asset-specific governance.

---

## 3. DAO governance

Governance authority depends on the product model.

- **Fund products:** fund token holders participate in governance.
- **Direct artwork receipt products:** governance follows the defined asset authority model.

**Token possession alone does not define governance rights unless specified by the asset model.**

---

## 4. Charity NFT editions

Charity NFT editions are an independent business module for cultural and philanthropic purposes.
They are not required to follow the ERC-8415 asset model and must not be forced into it.

---

## 5. Product invariants

These rules preserve the commercial product design.

1. **ArtFi is a commercial platform.** It must not be treated as an ERC-8415 demo application.
2. **Supported product models** are artwork receipt assets, artwork investment funds, and charity
   NFT editions.
3. **ERC-8415 boundary.** ERC-8415 applies to asset identity, registry synchronization,
   ownership-related workflows, and asset lifecycle management.
4. **Charity NFT boundary.** Charity NFT is an independent product line and must not be forced into
   the ERC-8415 asset model.
5. **Governance boundary.** DAO governance follows the underlying product structure. Economic
   participation and governance authority must be explicitly defined by the corresponding asset
   model.

---

## 6. What this directive does not change

- No code, contract, test, or deployment tooling is modified by it.
- No requirement status or count in `docs/STATUS.md` moves.
- The promotion gates in `docs/ACCEPTANCE.md` are unaffected.
- The test chain remains Hoodi `560048`; the production chain remains undecided.
- Issue #110 is the product baseline and incorporates #84. This directive is consolidated into #110
  §1; it remains the record of the ruling that produced it.
