"use client";

import { useEffect, useState } from "react";
import {
  administrationRequest,
  type PlatformConfiguration,
} from "@/lib/administration";
import styles from "./administration.module.css";

export function PlatformNotice() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void administrationRequest<PlatformConfiguration>(
        "platform/config",
        undefined,
        { signal: controller.signal },
      )
        .then((result) => {
          if (active && current === generation)
            setNotice(result.noticeEnabled ? result.noticeText : "");
        })
        .catch(() => {
          if (active && current === generation) setNotice("");
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    const visible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return notice ? (
    <aside className={styles.notice} aria-label="Platform service notice">
      <strong>Service notice: </strong>
      {notice}
    </aside>
  ) : null;
}
