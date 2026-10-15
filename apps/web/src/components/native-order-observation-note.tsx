"use client";

import { useEffect, useState } from "react";
import {
  nativeOrderObservationFreshness,
  type NativeOrderObservation,
} from "@/lib/native-order-observation";

export function NativeOrderObservationNote({
  observation,
}: {
  observation: NativeOrderObservation;
}) {
  const [clock, setClock] = useState<number>();
  useEffect(() => {
    const update = () => setClock(Date.now());
    const initial = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [observation]);
  const freshness =
    clock === undefined
      ? "clock-unavailable"
      : nativeOrderObservationFreshness(observation, clock);
  return (
    <aside aria-label="Order chain observation">
      <p>
        All statuses below were read at the same Hoodi block{" "}
        <span data-no-translate>{observation.blockNumber}</span>.
      </p>
      <p className="charity-digest">
        Block hash: <span data-no-translate>{observation.blockHash}</span>
      </p>
      <p>
        Chain timestamp, seconds:{" "}
        <span data-no-translate>{observation.blockTimestamp}</span>. Observed by
        this browser at{" "}
        <time
          data-no-translate
          dateTime={new Date(observation.observedAt).toISOString()}
        >
          {new Date(observation.observedAt).toISOString()}
        </time>
        .
      </p>
      <p role="status">
        {freshness === "older"
          ? "This snapshot is over 30 seconds old. Refresh orders for a new observation."
          : freshness === "recent"
            ? "A recent snapshot is displayed. New blocks can change these states."
            : "Snapshot age is unavailable until the browser clock can be checked. Refresh orders before relying on it."}
      </p>
      <p>
        These are recorded chain observations, not reserved availability or
        finality. Consumed authority may mean settlement or withdrawal.
        Balances, allowances, signatures and approved-source evidence are
        checked by the original transaction flow; token state does not prove
        registry transfer or physical delivery.
      </p>
    </aside>
  );
}
