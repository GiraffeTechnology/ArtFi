export type HelpLink = Readonly<{ label: string; href: string }>;
export type HelpQuestion = Readonly<{
  id: string;
  question: string;
  paragraphs: readonly string[];
  links?: readonly HelpLink[];
}>;
export type HelpSection = Readonly<{
  id: string;
  title: string;
  questions: readonly HelpQuestion[];
}>;

// Public product guidance only. Account data, operational configuration and
// execution authority are obtained through their existing protected workflows.
export const helpSections = [
  {
    id: "products",
    title: "Choose the right product",
    questions: [
      {
        id: "product-differences",
        question: "How do the three ArtFi sections differ?",
        paragraphs: [
          "Digital NFTs are digital editions. Charity editions connect to the CCHS workflow and do not represent physical artwork. Whole-artwork RWA tokens are delivery vouchers or warehouse receipts for identified works under the applicable custody and registry record.",
          "Fractional tokens belong to an asset-specific vault or participation structure. Their economic and governance rights follow that structure. A fraction is not a whole-artwork delivery voucher.",
        ],
        links: [
          { label: "Digital NFTs", href: "/nft" },
          { label: "Whole-artwork receipts", href: "/rwa" },
          { label: "Fractional trading", href: "/market/fractionals" },
        ],
      },
      {
        id: "record-authority",
        question:
          "Does a token transfer prove physical delivery or registry ownership?",
        paragraphs: [
          "The blockchain records token state and settlement. The approved registry of record establishes recorded holdership within its scope. ArtFi displays reconcilable projections of those records.",
          "A successful transfer does not by itself prove physical delivery, redemption or a registry update. Read the chain, registry and custody information separately. A disagreement or stale source must remain visible rather than being replaced by an assumed result.",
        ],
        links: [{ label: "Read the receipt asset information", href: "/rwa" }],
      },
      {
        id: "test-assets",
        question: "What do TESTNET and NO REAL-WORLD VALUE mean?",
        paragraphs: [
          "The approved write-testing chain is Hoodi. Isolated test assets are marked TESTNET, NO REAL-WORLD VALUE and NO LEGAL EFFECT. They do not establish a real donation, holder benefit or right to a physical work.",
          "Historical Sepolia charity records remain separate. A test asset, fixture or successful technical check does not establish a production release or a mainnet transaction.",
        ],
      },
    ],
  },
  {
    id: "wallet",
    title: "Wallet, login and privacy",
    questions: [
      {
        id: "connection-login",
        question: "Is connecting a wallet the same as signing in?",
        paragraphs: [
          "No. Public marketplace browsing is available without login. Assets, balances, holdings, private history and protected actions require an authenticated session bound to the wallet and chain.",
          "Use the sign-in controls for the account you intend to use. After logout, expiry or an account or chain change, sign in again as requested before reading private records or trading.",
        ],
        links: [{ label: "Personal center", href: "/portfolio" }],
      },
      {
        id: "wallet-entry",
        question: "Why might the separate Wallet entry be unavailable?",
        paragraphs: [
          "ArtFi reads the Wallet deployment address from its configured service. If the entry is unavailable, ArtFi cannot infer another host or port. Opening the separate Wallet does not create a shared session or grant ArtFi permission to sign.",
          "A wallet confirmation applies to the exact action shown in that wallet. Read the account, chain, target, asset, quantity, price, payment token, fees and expiry before confirming.",
        ],
      },
      {
        id: "private-material",
        question: "What information belongs in a support request?",
        paragraphs: [
          "Describe the visible error, the action and the time. Use a public transaction hash or the operation or case identifier only where the protected support workflow calls for it.",
          "Never send a seed phrase, private key, password, one-time code, signature, raw signed transaction or private artwork master. The help page does not collect account data or wallet permissions.",
        ],
        links: [{ label: "Content reports and appeals", href: "/support" }],
      },
    ],
  },
  {
    id: "trading",
    title: "Orders, results and recovery",
    questions: [
      {
        id: "native-market",
        question: "Where do I manage NFT listings, purchases and offers?",
        paragraphs: [
          "Use ArtFi's native NFT screens for discovery, review and the supported listing, purchase, offer, acceptance and cancellation workflows. Wallets authorize the applicable signature or transaction; the venue and protocol determine publication and settlement.",
          "An unavailable or unsupported action remains unavailable with its actual reason. A venue that does not support Hoodi cannot be exercised by relabelling a mainnet item as a testnet item.",
        ],
        links: [{ label: "NFT marketplace", href: "/nft" }],
      },
      {
        id: "pending-result",
        question:
          "A signature or transaction was submitted. Has the action completed?",
        paragraphs: [
          "Signed, published, submitted, accepted, pending, confirmed and settled describe different observations. A submitted request is not proof of settlement. Check the existing result view and the attributed transaction or order record.",
          "If the outcome is unknown after a timeout, refresh or interrupted connection, reconcile the existing operation before trying another action. Do not assume a missing response means that nothing was sent.",
        ],
        links: [
          { label: "Market activity", href: "/market/activity" },
          { label: "Your holdings and records", href: "/portfolio" },
          { label: "Agent operation history", href: "/agent" },
        ],
      },
      {
        id: "amend-cancel",
        question:
          "How do order amendment, cancellation and partial fills work?",
        paragraphs: [
          "An amendment replaces the signed intent. The existing order workflow retires the original authority before publishing its replacement. A bounded partial fill consumes part of the authorized quantity; it does not grant unlimited authority.",
          "Use the cancellation path for the applicable market. An off-chain cancellation is limited to the protocol's supported guarantees and is not automatically a final on-chain revocation. Read the resulting state before acting again.",
        ],
        links: [
          { label: "Fractional market", href: "/market/fractionals" },
          { label: "NFT orders", href: "/nft" },
        ],
      },
      {
        id: "auction-exit",
        question:
          "How are auction bids, refunds and pauses different from fixed-price listings?",
        paragraphs: [
          "An auction may lock the listed asset for its defined window. Review the reserve, minimum increment, end time and any late-bid extension before bidding. The displayed observation time matters because chain state can change.",
          "Fixed-price listing does not itself move the asset into resting escrow. Auction settlement and withdrawal of settled credits use their existing exit paths. A failed or pending refund is not a completed payment.",
        ],
        links: [{ label: "Auction workflow", href: "/market/auctions" }],
      },
    ],
  },
  {
    id: "charity",
    title: "Charity editions and holder files",
    questions: [
      {
        id: "charity-rights",
        question: "What does a charity edition provide?",
        paragraphs: [
          "The only holder benefit is access to the specified high-resolution watermarked copy after wallet ownership is verified. An edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
          "The unwatermarked master is never a public preview or a website download. A missing marketplace image does not authorize publishing it.",
        ],
        links: [
          { label: "Charity editions and disclosures", href: "/charity" },
        ],
      },
      {
        id: "holder-download",
        question: "Why might a watermarked holder file be unavailable?",
        paragraphs: [
          "Use the edition's protected holder-access flow with the wallet that holds the required token. Connecting a wallet alone is insufficient; ownership and the approved file must be verified.",
          "The watermarked holder file and private master have different hashes. The holder file is delivered without a browser preview. Missing release or access evidence keeps that delivery unavailable.",
        ],
        links: [
          { label: "Open an edition's holder-access page", href: "/charity" },
        ],
      },
      {
        id: "donation-receipt",
        question:
          "Does buying an edition give me a donation receipt or tax credit?",
        paragraphs: [
          "No receipt or tax credit is promised by ArtFi. Primary proceeds are designated for CCHS and use its confirmed beneficiary wallet. CCHS is the sole receipt issuer; contact CCHS directly about any receipt.",
          "Sellout requires a zero distribution-wallet balance and reconciled external sale evidence. Physical-donation acceptance is recorded only after that sellout record. Neither record creates a physical-artwork claim for an NFT holder.",
        ],
        links: [{ label: "CCHS", href: "https://cchsc.ca" }],
      },
    ],
  },
  {
    id: "governance",
    title: "Fractions, revenue and governance",
    questions: [
      {
        id: "vault-membership",
        question: "How do I participate in an asset's DAO?",
        paragraphs: [
          "Use the vault and governance flow for the specific asset. Wallet control, the underlying NFT's continuing vault custody and the relevant fractional-token membership are separate checks.",
          "Voting uses historical ERC20Votes snapshots. A current token balance alone cannot replace the proposal's historical voting record or create extra voting rights.",
        ],
        links: [{ label: "Vault and DAO workflows", href: "/dao" }],
      },
      {
        id: "proposal-lifecycle",
        question: "Does a passed vote immediately execute a proposal?",
        paragraphs: [
          "Drafting, proposing, voting, timelock queueing and execution are separate stages. Read the proposal category, snapshot, recorded outcome and current timelock state before using the supported next step.",
          "Forced-buyout initiation also requires the specified independent pricing evidence. Automatic debit, forced liquidation and real buyout settlement remain disabled in this cycle.",
        ],
        links: [{ label: "Proposal and voting workspace", href: "/dao" }],
      },
      {
        id: "revenue-snapshot",
        question:
          "Does holding fractions guarantee a return or an immediate revenue payment?",
        paragraphs: [
          "No return or payment is guaranteed. Revenue distributions, where configured and applicable to the asset, use snapshot balances and individual claims rather than push payments.",
          "The distribution's snapshot, claim eligibility, contract state and confirmed transaction determine a claim result. A displayed estimate or submitted claim is not a completed payment.",
        ],
        links: [{ label: "Fractional assets", href: "/market/fractionals" }],
      },
    ],
  },
  {
    id: "support",
    title: "Messages, language and support",
    questions: [
      {
        id: "messages",
        question:
          "Where do I read notifications and change delivery preferences?",
        paragraphs: [
          "Open your authenticated personal center for the notification controls available in the deployed version. The inbox, delivery status and preferences must be backed by the configured service.",
          "An unavailable inbox or delivery channel does not mean a transaction failed, succeeded or was never submitted. Use the operation's own result and history for that question.",
        ],
        links: [{ label: "Personal center", href: "/portfolio" }],
      },
      {
        id: "language",
        question: "What happens if translation is unavailable?",
        paragraphs: [
          "Use the site language selector for English, Simplified Chinese, Traditional Chinese, French, Spanish, German, Korean or Japanese. English is authoritative for the non-Chinese translations.",
          "If translation fails, the authoritative English remains available. A convenience translation does not change the asset's rights, signed terms or transaction authority.",
        ],
      },
      {
        id: "reports-appeals",
        question:
          "How do I report content or read and appeal a moderation decision?",
        paragraphs: [
          "Use Content reports and appeals from an authenticated wallet. Read the case and its decision through that protected workflow, then submit an eligible appeal there.",
          "Moderation reviews marketplace content. It cannot transfer, arbitrarily freeze or reassign assets, resolve registry holdership or sign a transaction for you.",
        ],
        links: [
          { label: "Open content reports and appeals", href: "/support" },
        ],
      },
    ],
  },
] as const satisfies readonly HelpSection[];
