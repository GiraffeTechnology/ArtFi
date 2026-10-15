import type { Metadata } from "next";
import { NotificationInbox } from "@/components/notification-inbox";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default function NotificationsPage() {
  return (
    <main className="page-shell">
      <div className="page-heading">
        <p>Account</p>
        <h1>Notifications</h1>
        <p>
          Transaction alerts, current system messages and wallet-specific
          delivery preferences.
        </p>
      </div>
      <NotificationInbox />
    </main>
  );
}
