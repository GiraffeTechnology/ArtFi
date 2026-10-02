"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useSignMessage } from "wagmi";

import {
  verifyHolderAccess,
  type HolderState,
  type HolderStep,
} from "@/lib/charity-holder-state";

/**
 * The holder benefit, end to end — #110 §2 CH.5.
 *
 * CH.5 is one promise: prove you hold this edition, receive the watermarked copy. Until this
 * surface existed the proof ran only in API routes no screen reached, which `ACCEPTANCE.md` §7.17
 * counts as presenting a benefit without the runtime behind it.
 *
 * The flow is four server answers, and the component shows each one as it is:
 *
 *   1. a challenge that names this edition — a signature for one edition unlocks no other;
 *   2. the wallet's signature over that exact text;
 *   3. server-side verification of both the signature and an on-chain balance;
 *   4. the file itself, fetched through the gated route.
 *
 * Every failure is reported in the server's own words rather than retried, softened, or replaced
 * with an optimistic state. A wallet that does not hold the edition is told so plainly, and no
 * step is ever skipped client-side: the button is a request, not the decision.
 */

const stepLabels: Record<HolderStep, string> = {
  idle: "Ownership not yet verified",
  "requesting-challenge": "Preparing the ownership challenge",
  "awaiting-signature": "Waiting for the wallet signature",
  verifying: "Checking the signature and the on-chain balance",
  verified: "Ownership verified",
  error: "Verification needs attention",
};

export function CharityHolderAccess({ tokenId }: { tokenId: string }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  // Remount on every authority/edition change, including disconnect and returning to a wallet.
  return (
    <HolderAccessSession
      key={`${tokenId}:${address?.toLowerCase()}:${isConnected}:${chainId}`}
      tokenId={tokenId}
    />
  );
}

function HolderAccessSession({ tokenId }: { tokenId: string }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [{ step, message, descriptor, expiresAt }, setState] =
    useState<HolderState>({ step: "idle" });
  const active = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (step !== "verified" || !expiresAt) return;
    const expire = () =>
      setState({
        step: "error",
        message: "Holder access expired. Verify ownership again.",
      });
    const timer = window.setTimeout(
      expire,
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [step, expiresAt]);

  async function verify() {
    if (!address || !isConnected || inFlight.current) return;
    inFlight.current = true;
    try {
      await verifyHolderAccess({
        address,
        tokenId,
        signMessage: (message) =>
          signMessageAsync({ message, account: address }),
        isCurrent: () => active.current,
        update: setState,
      });
    } finally {
      inFlight.current = false;
    }
  }

  const busy =
    step === "requesting-challenge" ||
    step === "awaiting-signature" ||
    step === "verifying";

  return (
    <section
      aria-label="Charity edition holder access"
      className="charity-holder-access"
      data-testid="charity-holder-access"
    >
      <h3>Holder access</h3>
      <p>
        The only holder benefit is a high-resolution watermarked copy, released
        after wallet ownership is verified. Verification proves two things: that
        you control the wallet, and that the wallet holds this edition.
      </p>

      <p className="charity-holder-access__status" role="status">
        {stepLabels[step]}
      </p>

      {!isConnected && (
        <div className="charity-holder-access__connect">
          <ConnectButton.Custom>
            {({ mounted, openConnectModal }) => (
              <button
                className="primary"
                disabled={!mounted || !openConnectModal}
                onClick={openConnectModal}
                type="button"
              >
                Connect wallet to verify ownership
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      )}

      {isConnected && step !== "verified" && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => void verify()}
          type="button"
        >
          {busy ? "Verifying…" : "Verify ownership"}
        </button>
      )}

      {message && (
        <p className="charity-holder-access__message" role="alert">
          {message}
        </p>
      )}

      {step === "verified" && descriptor && (
        <>
          <section aria-label="Watermarked file" className="contract-facts">
            <div>
              <span>File type</span>
              <strong>{descriptor.contentType}</strong>
            </div>
            <div>
              <span>Size</span>
              <strong>{descriptor.byteLength.toLocaleString()} bytes</strong>
            </div>
            <div>
              <span>SHA-256</span>
              <strong className="charity-digest" data-no-translate>
                {descriptor.sha256}
              </strong>
            </div>
            {expiresAt && (
              <div>
                <span>Access expires</span>
                <strong>{new Date(expiresAt).toLocaleString()}</strong>
              </div>
            )}
          </section>
          <a
            className="primary"
            download
            href={`/api/charity/editions/${tokenId}/holder-asset/file`}
            onClick={(event) => {
              if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
                event.preventDefault();
                setState({
                  step: "error",
                  message: "Holder access expired. Verify ownership again.",
                });
              }
            }}
          >
            Download the watermarked copy
          </a>
          <p>
            The file downloads rather than opening in the browser, and the
            unwatermarked master is never served by any route.
          </p>
        </>
      )}
    </section>
  );
}
