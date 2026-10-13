import { useEffect, useState, type ReactNode } from "react";
import type { ClientMemberContext, Page } from "../shared/types";
import { api, apiErrorMessage } from "./api";
import { CollaborativeTablePage } from "./CollaborativeTablePage";

/** Roll out per table. Legacy installations remain usable until the owner completes a verified cutover. */
export function TableAuthorityGate({
  page,
  member,
  metadata,
  onSelectPage,
  legacy,
}: {
  page: Page;
  member: ClientMemberContext;
  metadata?: ReactNode;
  onSelectPage: (id: string) => void;
  legacy: ReactNode;
}) {
  const [state, setState] = useState<"loading" | "d1" | "seeding" | "do" | "repairing">("loading");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;

    void api<{ authority?: { state: "d1" | "seeding" | "do" | "repairing" } | null }>(
      `/api/tables/${page.id}/authority`,
    )
      .then((result) => {
        if (active) setState(result?.authority?.state ?? "d1");
      })
      .catch((cause) => {
        if (active) {
          setState("d1");
          setError(apiErrorMessage(cause, "Table collaboration status could not be checked."));
        }
      });
    return () => {
      active = false;
    };
  }, [page.id]);
  const enable = async () => {
    setBusy(true);
    setError("");
    setState("seeding");
    try {
      const result = await api<{ authority: { state: "do" } }>(`/api/tables/${page.id}/authority`, {
        method: "POST",
        signal: AbortSignal.timeout(120000),
      });
      setState(result.authority.state);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Migration is paused. Retry to resume its verified seed."));
    } finally {
      setBusy(false);
    }
  };
  if (state === "do" || state === "repairing")
    return (
      <CollaborativeTablePage
        page={page}
        member={member}
        {...(metadata === undefined ? {} : { metadata })}
        onSelectPage={onSelectPage}
      />
    );
  if (state === "loading") return <output>Loading table…</output>;
  return (
    <>
      <div className="table-upgrade">
        {member.role === "owner" && member.features?.tableAuthority && (
          <button disabled={busy} onClick={() => void enable()}>
            {state === "seeding" ? "Resume table migration" : "Enable collaborative views and properties"}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        {state === "seeding" && (
          <output>The table is fenced while its verified copy is prepared. Retry migration to resume.</output>
        )}
      </div>
      {state === "d1" && legacy}
    </>
  );
}
