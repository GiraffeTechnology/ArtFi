import type { Metadata } from "next";

import { OperationsStatus } from "@/components/operations-status";

export const metadata: Metadata = { title: "Operations" };

export default function OperationsPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>Operations</span>
        <strong>Read-only status — no alerting, nothing stored</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Operations</p>
        <h1>Dependency status.</h1>
        <p>
          Every dependency this build relies on, checked when this page is
          opened and reported as observed. A check that could not run says so
          rather than showing green. No endpoint, host or address is named here.
        </p>
      </header>
      <OperationsStatus />
    </main>
  );
}
