import type { Metadata } from "next";
import { AdministrationConsole } from "@/components/administration-console";

export const metadata: Metadata = { title: "Administration" };
export default function AdministrationPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">Application administration</p>
        <h1>Content review and operations.</h1>
        <p>
          Review content reports, decide private appeals, publish service
          notices and inspect durable audit records. This role grants no
          custody, registry or trading authority.
        </p>
      </header>
      <AdministrationConsole />
    </main>
  );
}
