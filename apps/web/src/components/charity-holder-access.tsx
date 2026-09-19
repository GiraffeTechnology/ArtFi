"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

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

type Step =
  | "idle"
  | "requesting-challenge"
  | "awaiting-signature"
  | "verifying"
  | "verified"
  | "error";

type HolderDescriptor = {
  contentType: string;
  byteLength: number;
  sha256: string;
};

const stepLabels: Record<Step, string> = {
  idle: "Ownership not yet verified",
  "requesting-challenge": "Preparing the ownership challenge",
  "awaiting-signature": "Waiting for the wallet signature",
  verifying: "Checking the signature and the on-chain balance",
  verified: "Ownership verified",
  error: "Verification needs attention",
};

async function readDetail(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { detail?: string };
    return body.detail ?? fallback;
  } catch {
    return fallback;
  }
}

export function CharityHolderAccess({ tokenId }: { tokenId: string }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState<string>();
  const [descriptor, setDescriptor] = useState<HolderDescriptor>();
  const [expiresAt, setExpiresAt] = useState<string>();

  const verify = useCallback(async () => {
    if (!address) return;
    setDescriptor(undefined);
    setMessage(undefined);
    try {
      setStep("requesting-challenge");
      const challengeResponse = await fetch("/api/charity/holder/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, tokenId }),
      });
      if (!challengeResponse.ok) {
        setMessage(
          await readDetail(
            challengeResponse,
            "The ownership challenge could not be created.",
          ),
        );
        setStep("error");
        return;
      }
      const challenge = (await challengeResponse.json()) as { message: string };

      setStep("awaiting-signature");
      let signature: string;
      try {
        signature = await signMessageAsync({ message: challenge.message });
      } catch {
        // A declined signature is a choice, not a fault. It is reported without alarm.
        setMessage("The signature request was declined in the wallet.");
        setStep("error");
        return;
      }

      setStep("verifying");
      const verifyResponse = await fetch("/api/charity/holder/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      if (!verifyResponse.ok) {
        setMessage(
          await readDetail(
            verifyResponse,
            "Ownership of this edition could not be verified.",
          ),
        );
        setStep("error");
        return;
      }
      const verified = (await verifyResponse.json()) as { expiresAt: string };
      setExpiresAt(verified.expiresAt);

      // The descriptor is what the holder is about to receive. It is fetched separately from the
      // bytes so the page can state the file's type, size and digest before anything downloads.
      const descriptorResponse = await fetch(
        `/api/charity/editions/${tokenId}/holder-asset`,
        { cache: "no-store" },
      );
      if (descriptorResponse.ok) {
        setDescriptor((await descriptorResponse.json()) as HolderDescriptor);
        setMessage(undefined);
      } else {
        setMessage(
          await readDetail(
            descriptorResponse,
            "The watermarked file is not available for this edition.",
          ),
        );
      }
      setStep("verified");
    } catch {
      setMessage("Charity holder verification is unavailable.");
      setStep("error");
    }
  }, [address, signMessageAsync, tokenId]);

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
                disabled={!mounted}
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
        <div className="charity-holder-access__grant">
          <dl>
            <div>
              <dt>File type</dt>
              <dd>{descriptor.contentType}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{descriptor.byteLength.toLocaleString()} bytes</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd className="charity-digest" data-no-translate>
                {descriptor.sha256}
              </dd>
            </div>
            {expiresAt && (
              <div>
                <dt>Access expires</dt>
                <dd>{new Date(expiresAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <a
            className="primary"
            download
            href={`/api/charity/editions/${tokenId}/holder-asset/file`}
          >
            Download the watermarked copy
          </a>
          <p>
            The file downloads rather than opening in the browser, and the
            unwatermarked master is never served by any route.
          </p>
        </div>
      )}
    </section>
  );
}
