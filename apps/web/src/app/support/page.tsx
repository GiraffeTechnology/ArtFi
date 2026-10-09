import type { Metadata } from "next";
import { ModerationSupport } from "@/components/moderation-support";

export const metadata: Metadata = { title: "Content reports and appeals" };
export default function SupportPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">Marketplace support</p>
        <h1>Content reports and appeals.</h1>
        <p>
          Ask for a review of marketplace content, read the decision and appeal
          it from your authenticated wallet. This process does not resolve
          ownership, execute transactions or replace the applicable registry.
        </p>
      </header>
      <ModerationSupport />
    </main>
  );
}
