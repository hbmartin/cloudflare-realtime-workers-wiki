import { useEffect, useState } from "react";
import type { WatchState } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";

export function WatchControl({
  resourceType,
  resourceId,
  compact = false,
}: {
  resourceType: "page" | "space";
  resourceId: string;
  compact?: boolean;
}) {
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = resourceType === "page" ? "page" : "space";

  useEffect(() => {
    let active = true;
    void api<{ watch: WatchState }>(
      `/api/${resourceType === "page" ? "pages" : "spaces"}/${encodeURIComponent(resourceId)}/watch`,
    )
      .then((data) => {
        if (active) setWatch(data.watch);
      })
      .catch((cause) => {
        if (active) setError(apiErrorMessage(cause, `Watch status for this ${label} is unavailable.`));
      });
    return () => {
      active = false;
    };
  }, [label, resourceId, resourceType]);

  if (error)
    return (
      <span className="watch-error" title={error}>
        !
      </span>
    );
  const state = watch?.state ?? "none";
  const next = state === "watching" ? "muted" : state === "muted" ? "none" : "watching";
  const action =
    next === "watching"
      ? `Watch this ${label}`
      : next === "muted"
        ? `Mute this ${label}`
        : `Stop watching this ${label}`;
  const inherited = resourceType === "page" && watch?.source === "space";

  return (
    <button
      className={`watch-control state-${state}${compact ? " compact" : ""}`}
      aria-label={action}
      aria-pressed={state === "watching"}
      disabled={!watch || busy}
      title={inherited ? "Watching through this space" : action}
      onClick={async () => {
        setBusy(true);
        try {
          const data = await api<{ watch: WatchState }>(
            `/api/${resourceType === "page" ? "pages" : "spaces"}/${encodeURIComponent(resourceId)}/watch`,
            { method: "PUT", body: json({ state: next }) },
          );
          setWatch(data.watch);
          setError("");
        } catch (cause) {
          setError(apiErrorMessage(cause, `Watch status for this ${label} could not be changed.`));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span aria-hidden="true">{state === "watching" ? "◉" : state === "muted" ? "◌" : "○"}</span>
      <span className={compact ? "visually-hidden" : undefined}>
        {busy
          ? "Updating…"
          : inherited
            ? "Watching space"
            : state === "watching"
              ? "Watching"
              : state === "muted"
                ? "Muted"
                : "Watch"}
      </span>
    </button>
  );
}
