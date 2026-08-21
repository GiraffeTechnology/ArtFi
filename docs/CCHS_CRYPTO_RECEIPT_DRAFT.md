# CCHS Crypto Gift and NFT Fundraising Receipting Draft

Status: **DRAFT - NOT AN OFFICIAL DONATION RECEIPT**

This document is a working bilingual copy and field specification for review by CCHS's authorized
receipting officer and Canadian legal/tax adviser. ArtFi must not issue, sign, calculate, promise, or
market an official donation receipt on CCHS's behalf.

## Public-facing notice

### 中文

本项目的初始发行收益指定归 CCHS。是否构成加拿大税法下可开具官方捐赠收据的礼物、礼物
金额、NFT 及相关数字权益所构成的 donor advantage（捐赠人利益）之公允价值，以及最终
eligible amount（可抵税捐赠金额），均由 CCHS 根据加拿大税务局规则和个别交易事实独立
决定。购买或持有 NFT 不保证取得官方捐赠收据或任何税务优惠。

持有人如需申请，应直接向 CCHS 提交真实捐赠人姓名及地址、交易网络、交易哈希、区块和
时间、ETH 数量，以及 CCHS 要求的其他资料。ArtFi 不代开收据，也不决定可开票金额。

NFT 仅代表 100 枚固定版本之一及经持币验证后访问带水印高清图的有限权益；不包含实物
所有权、占有、赎回、版权、复制权或商业使用权。该 NFT 及访问权益可能构成 donor
advantage，必须由 CCHS 在礼物发生时进行合理、公允且可核验的估值。若礼物或 advantage
的公允价值无法可靠确定，或未满足 CRA 的真实赠与和 split-receipting 要求，CCHS 不得开具
官方捐赠收据。

### English

Initial-edition proceeds are designated for CCHS. CCHS alone determines whether a transaction is a
gift eligible for an official Canadian donation receipt, the amount of the gift, the fair market
value of the NFT and any related donor advantage, and the final eligible amount under applicable
Canada Revenue Agency rules. Purchasing or holding an NFT does not guarantee a receipt or any tax
benefit.

A holder requesting consideration must contact CCHS directly and provide the true donor's name and
address, network, transaction hash, block and timestamp, ETH quantity, and any other information
CCHS requires. ArtFi does not issue receipts or determine receiptable amounts.

The NFT represents one of 100 fixed editions and limited token-gated access to a watermarked
high-resolution image. It conveys no title to, possession of, or redemption right in the physical
artwork and no copyright, reproduction, or commercial-use rights. The NFT and access benefit may
constitute a donor advantage and must be valued reasonably and verifiably at the time of the gift.
CCHS must not issue an official donation receipt if the fair market value of the gift or advantage
cannot be determined or the transaction does not meet the CRA's gift and split-receipting rules.

## Suggested property and advantage descriptions

Use these descriptions only after CCHS has classified the transaction and verified the facts.

**Property received by CCHS**

> [ETH quantity] Ether (ETH) received by a CCHS-controlled wallet on [network] in transaction
> [transaction hash], block [block number], at [UTC timestamp]. The Canadian-dollar fair market
> value at the time CCHS received the property was determined using [approved source and consistent
> methodology], with the supporting market snapshot retained in CCHS's records.

**Advantage to the donor**

> One transferable ERC-1155 token, edition [number] of 100 for artwork [work identifier], together
> with token-gated access to a watermarked high-resolution digital image. No physical-artwork title,
> possession, redemption, copyright, reproduction, or commercial-use right is included. Fair market
> value of the advantage at the time of the gift: CAD [amount], determined by [qualified person and
> method].

If CCHS determines that the NFT transaction is a sale rather than a qualifying gift, no official
donation receipt should be issued. If the advantage cannot be valued, no official donation receipt
should be issued. CCHS should apply the CRA's split-receipting thresholds and retain its calculation.

## Required receipt fields

The final CCHS-issued receipt must contain every field required by section 3501 of the Income Tax
Regulations, including:

- the statement "Official donation receipt for income tax purposes";
- CCHS's legal name and Canadian address exactly as registered with the CRA;
- CCHS's CRA registration number;
- a unique receipt serial number and the place of issue;
- date the gift was received and, when different, date the receipt was issued;
- the true donor's full name and address;
- description and Canadian-dollar fair market value of the property received;
- description and Canadian-dollar fair market value of every advantage;
- eligible amount of the gift in Canadian dollars;
- appraiser's name and address when the property was appraised;
- signature of a person authorized by CCHS; and
- "Canada Revenue Agency - canada.ca/charities-giving".

Never prefill CCHS's legal name, address, registration number, signer, eligible amount, or appraisal
details from unverified sources.

## Valuation and evidence rule

For receipting, the controlling valuation timestamp is when CCHS receives the gift, not when the
receipt is later issued. The approved public ETH/CAD quote and fair-market-value calculation must
be anchored to that CCHS-received timestamp.

CCHS should adopt one reasonable and consistently applied ETH/CAD valuation method and retain:

- network, wallet, transaction hash, block number, and UTC receipt timestamp;
- ETH quantity and confirmation evidence;
- exchange/provider, market pair, quote timestamp, raw quote, and calculation method;
- immutable snapshot or export and its SHA-256 digest;
- NFT/benefit valuation evidence and the identity/qualification of the valuer;
- the split-receipting calculation and authorized approval record; and
- the issued, amended, or cancelled receipt audit trail.

## VI application requirements

The receipt or explanatory letter must use the controlled CCHS assets without redrawing:

- `cchs-lockup-horizontal.svg` for the standard horizontal lockup;
- `cchs-mark-master.svg`, `cchs-mark-black.svg`, or `cchs-mark-white.svg` only as approved;
- CCHS Heritage Vermilion `#C63A30`, Deep Ink `#14211E`, Warm White `#F4F1E9`;
- Source Han Serif / Noto Serif SC for Chinese headings, Source Han Sans / HarmonyOS Sans for Chinese
  body, Inter for English, and IBM Plex Mono for serial numbers, dates, wallet addresses, and hashes;
- 12-column layout, 8-point spacing rhythm, generous whitespace, and vermilion at no more than the
  VI's recommended accent proportion.

Production requires CCHS brand-owner approval, legal/tax review, confirmation of the registered
legal identity and CRA number, and a rendered proof. Do not add "Canada" or a third line to the
approved logo lockup.

The controlled CCHS VI manual was reviewed on abcdyi. Its internal storage path remains private
operations evidence and is not published in Git.

## Authoritative references

- CRA, Issuing complete and accurate donation receipts:
  https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/checklists-charities/issuing-complete-accurate-donation-receipts.html
- CRA, Sample official donation receipts:
  https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/sample-official-donation-receipts.html
- CRA, Determining fair market value of non-cash gifts:
  https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/operating-a-registered-charity/issuing-receipts/determining-fair-market-value-gifts-kind-non-cash-gifts.html
- CRA, Split receipting:
  https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/operating-a-registered-charity/issuing-receipts/split-receipting.html
- CRA, Determining the value of crypto-assets for tax filing:
  https://www.canada.ca/en/revenue-agency/programs/about-canada-revenue-agency-cra/compliance/cryptocurrency-guide/value-crypto.html
