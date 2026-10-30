# Auction bid callback browser fixture

The fixture mounts the actual AuctionMarket and original UserSessionProvider, ClientSessionController and transaction journal. Only the wallet hooks/RPC/receipt adapters and same-origin authentication/catalog responses are synthetic. Every unrelated network request is blocked.

Scenarios exercise an auction change during an actual delayed session check, changed terms after a confirmed approval, changed terms while simulation waits, an UNKNOWN approval journal, exact successful approval/bid requests and wallet departure during simulation. These are browser integration checks, not real signatures, funds, deployed-contract or full application acceptance.

Build with the existing approved Vite module through scripts/build-auction-bid-fixture.mjs, setting ARTFI_AUCTION_BID_VITE_MODULE and ARTFI_AUCTION_BID_OUTPUT. Run playwright.auction-bid.config.ts with ARTFI_AUCTION_BID_FIXTURE pointing to its fixture.js, ARTFI_AUCTION_BID_RESULTS for task output and, when applicable, ARTFI_E2E_CHROMIUM_PATH for the existing browser. Execute product checks only in the owner's already approved remote server environment. No dependency or browser installation is performed by this fixture.
