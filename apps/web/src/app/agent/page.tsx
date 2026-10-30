import type { Metadata } from "next";
import { AgentRuntimeConsole } from "@/components/agent-runtime-console";
export const metadata: Metadata = { title: "Bounded agent runtime" };
export default function AgentPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">Stage 2 · Bounded authority</p>
        <h1>Bounded agent runtime.</h1>
        <p>
          View signed-intent execution, durable recovery and attributed
          evidence. Autonomous execution is unavailable without a supported
          delegated authority interface. Existing owner-confirmed market
          workflows remain available.
        </p>
      </header>
      <AgentRuntimeConsole />
    </main>
  );
}
