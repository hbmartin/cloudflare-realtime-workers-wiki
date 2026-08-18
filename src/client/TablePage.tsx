import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMemberContext } from "../shared/types";
import type {
  ColumnType,
  Page,
  TableColumn,
  TableData,
  TableLeaseResponse,
  TableLeaseTiming,
  TableRow,
} from "../shared/types";
import { ApiClientError, api, json } from "./api";
import { BacklinksPanel } from "./BacklinksPanel";

type IsCurrent = () => boolean;
type MutationOptions = {
  resetKey?: string;
};

const LEASE_CONFLICT_MESSAGE = "Another editor has this table open for editing.";
const LEASE_EXPIRED_MESSAGE = "The editing lease expired. Reloaded the authoritative table.";
const LEASE_VERIFICATION_MESSAGE =
  "Editing was paused because the lease could not be verified after the system clock changed.";
const SAVE_FAILED_MESSAGE = "The table update could not be saved.";
const LEASE_LOST_SAVE_MESSAGE = "The table update was not saved because editing access was lost.";
const REVISION_RECOVERY_SAVE_MESSAGE =
  "The table update was not saved because the authoritative table revision could not be reloaded.";
const REVISION_CONFLICT_SAVE_MESSAGE =
  "The table update was not saved because the table kept changing. Reloaded the authoritative table.";
const REQUEST_TIMEOUT_MS = 15_000;
// Must stay above REQUEST_TIMEOUT_MS so a renewal cannot still be in flight
// when the next one is due.
const LEASE_RENEWAL_INTERVAL_MS = 20_000;
// Deadlines are scheduled with setTimeout, whose delay overflows past 2^31-1 ms
// and fires immediately. Reject implausible durations rather than clamp them:
// a lease that long is a broken response, not a usable one.
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

type LeaseClock = { monotonic: number; wall: number };
type LocalLeaseStatus = "valid" | "expired" | "wall-clock-disagreement";

function leaseClock(): LeaseClock {
  return { monotonic: performance.now(), wall: Date.now() };
}

function cellInputKey(rowId: string, columnId: string) {
  return `${rowId}:${columnId}`;
}

function normalizedInputValue(column: TableColumn, value: string | number | boolean | null) {
  if (value === null || value === "") return null;
  return column.type === "number" ? Number(value) : String(value);
}

// Distinguishable from a transport failure so renewal can fail closed on it.
class LeaseResponseError extends Error {
  constructor() {
    super("The lease service returned an invalid response.");
    this.name = "LeaseResponseError";
  }
}

function assertLeaseTiming(value: unknown): asserts value is TableLeaseTiming {
  const duration = (value as { leaseDurationMs?: unknown } | null)?.leaseDurationMs;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > MAX_LEASE_DURATION_MS) {
    throw new LeaseResponseError();
  }
}

function assertLeaseResponse(value: unknown): asserts value is TableLeaseResponse {
  assertLeaseTiming(value);
  const token = (value as { leaseToken?: unknown }).leaseToken;
  if (typeof token !== "string" || !token) throw new LeaseResponseError();
}

function releaseTableLease(pageId: string, leaseToken: string) {
  void api(`/api/tables/${pageId}/lease`, {
    method: "DELETE",
    body: json({ leaseToken }),
    keepalive: true,
  }).catch((cause) => console.error("Failed to release table lease", cause));
}

function errorMessage(cause: unknown, fallback: string) {
  if (!(cause instanceof Error)) return fallback;
  return cause.name === "TimeoutError" ? fallback : cause.message;
}

function isDefinitiveMutationRejection(cause: unknown): cause is ApiClientError {
  return (
    cause instanceof ApiClientError &&
    (cause.status === 400 ||
      cause.status === 413 ||
      cause.status === 415 ||
      cause.status === 422 ||
      cause.status === 429)
  );
}

export type TablePageProps = {
  page: Page;
  member: ClientMemberContext;
  onPageChanged: (page: Page) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
};

export function TablePage({ page, member, onPageChanged, onSelectPage, backlinksRevision }: TablePageProps) {
  const canEdit = member.role !== "viewer";
  const [table, setTable] = useState<TableData | null>(null);
  const [leaseToken, setLeaseToken] = useState<string | null>(null);
  const [leasePending, setLeasePending] = useState(canEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  // Kept apart from leaseError: a successful renewal clears the lease notice on
  // every interval and would otherwise erase an unsaved-edit warning.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Mirrors revisionRef for rendering: a mutation that failed with an unknown
  // outcome drops the revision, and polling has to resume to recover it.
  const [revisionKnown, setRevisionKnown] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [title, setTitle] = useState(page.title);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [cellResetGenerations, setCellResetGenerations] = useState<Record<string, number>>({});
  const revisionRef = useRef<number | null>(null);
  const leaseTokenRef = useRef<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const leaseActionRef = useRef<{ owner: IsCurrent; promise: Promise<void> } | null>(null);
  const leaseMonotonicDeadlineRef = useRef<number | null>(null);
  const leaseWallDeadlineRef = useRef<number | null>(null);
  const leaseRenewalRef = useRef<{ token: string; generation: number; promise: Promise<boolean> } | null>(null);
  const leaseRenewalGenerationRef = useRef(0);
  const pendingCellResetsRef = useRef(new Set<string>());
  const leaseConflictGenerationRef = useRef(0);
  const loadsInFlightRef = useRef(0);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const tableLoaded = table !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const currentLease = leaseTokenRef.current;
      leaseTokenRef.current = null;
      leaseMonotonicDeadlineRef.current = null;
      leaseWallDeadlineRef.current = null;
      if (currentLease) releaseTableLease(page.id, currentLease);
    };
  }, [page.id]);

  const isMounted = useCallback(() => mountedRef.current, []);
  const clearLocalLease = useCallback(() => {
    leaseTokenRef.current = null;
    leaseMonotonicDeadlineRef.current = null;
    leaseWallDeadlineRef.current = null;
    setLeaseToken(null);
  }, []);
  const setLocalLeaseDeadline = useCallback((requestedAt: LeaseClock, duration: number) => {
    leaseMonotonicDeadlineRef.current = requestedAt.monotonic + duration;
    leaseWallDeadlineRef.current = requestedAt.wall + duration;
  }, []);
  // The monotonic clock is authoritative for ordinary elapsed time. If only
  // the wall deadline elapsed, the machine may have slept or its clock may
  // have jumped, so ask the server before discarding a potentially live lease.
  const localLeaseStatus = useCallback((): LocalLeaseStatus => {
    const monotonicDeadline = leaseMonotonicDeadlineRef.current;
    const wallDeadline = leaseWallDeadlineRef.current;
    if (monotonicDeadline === null || wallDeadline === null || performance.now() >= monotonicDeadline) {
      return "expired";
    }
    return Date.now() >= wallDeadline ? "wall-clock-disagreement" : "valid";
  }, []);

  const resetCellInput = useCallback((key: string | undefined) => {
    if (!key || !mountedRef.current) return;
    setCellResetGenerations((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  }, []);

  const resetCellInputAfterLoad = useCallback((key: string | undefined) => {
    if (key) pendingCellResetsRef.current.add(key);
  }, []);

  const forgetRowCellInputs = useCallback((rowId: string) => {
    const prefix = `${rowId}:`;
    for (const key of pendingCellResetsRef.current) {
      if (key.startsWith(prefix)) pendingCellResetsRef.current.delete(key);
    }
    setCellResetGenerations((current) => {
      const entries = Object.entries(current).filter(([key]) => !key.startsWith(prefix));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, []);

  const forgetColumnCellInputs = useCallback((columnId: string) => {
    const suffix = `:${columnId}`;
    for (const key of pendingCellResetsRef.current) {
      if (key.endsWith(suffix)) pendingCellResetsRef.current.delete(key);
    }
    setCellResetGenerations((current) => {
      const entries = Object.entries(current).filter(([key]) => !key.endsWith(suffix));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, []);

  const invalidateRevision = useCallback(() => {
    revisionRef.current = null;
    setRevisionKnown(false);
  }, []);

  const load = useCallback(
    async (isCurrent: IsCurrent) => {
      const generation = ++loadGenerationRef.current;
      const leaseConflictGeneration = leaseConflictGenerationRef.current;
      loadsInFlightRef.current += 1;
      try {
        const result = await api<{ table: TableData }>(`/api/tables/${page.id}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!isCurrent() || generation !== loadGenerationRef.current) return;
        revisionRef.current = result.table.revision;
        setRevisionKnown(true);
        const validRows = new Set(result.table.rows.map((row) => row.id));
        const validColumns = new Set(result.table.columns.map((column) => column.id));
        const isValidCellKey = (key: string) => {
          const separator = key.indexOf(":");
          return separator >= 0 && validRows.has(key.slice(0, separator)) && validColumns.has(key.slice(separator + 1));
        };
        const resets = pendingCellResetsRef.current;
        pendingCellResetsRef.current = new Set();
        setCellResetGenerations((current) => {
          let changed = false;
          const next: Record<string, number> = {};
          for (const [key, value] of Object.entries(current)) {
            if (isValidCellKey(key)) next[key] = value;
            else changed = true;
          }
          for (const key of resets) {
            if (!isValidCellKey(key)) continue;
            next[key] = (next[key] ?? 0) + 1;
            changed = true;
          }
          return changed ? next : current;
        });
        setTable(result.table);
        setLoadError(null);
        if (result.table.lease.expiresAt === null && leaseConflictGeneration === leaseConflictGenerationRef.current) {
          setLeaseError((current) => (current === LEASE_CONFLICT_MESSAGE ? null : current));
        }
      } catch (cause) {
        if (isCurrent() && generation === loadGenerationRef.current) {
          setLoadError(errorMessage(cause, "Table could not be loaded."));
        }
        throw cause;
      } finally {
        loadsInFlightRef.current -= 1;
      }
    },
    [page.id],
  );

  const recoverRevision = useCallback(async () => {
    if (revisionRef.current !== null) return true;
    try {
      await load(isMounted);
      return revisionRef.current !== null;
    } catch {
      return false;
    }
  }, [isMounted, load]);

  const endLease = useCallback(
    async (token: string, message: string, shouldRelease = true) => {
      if (leaseTokenRef.current !== token) return;
      clearLocalLease();
      setLeaseError(message);
      if (shouldRelease) releaseTableLease(page.id, token);
      await load(isMounted).catch(() => undefined);
    },
    [clearLocalLease, isMounted, load, page.id],
  );

  const renewLocalLease = useCallback(
    (token: string, minimumGeneration = 0): Promise<boolean> => {
      const current = leaseRenewalRef.current;
      if (current?.token === token) {
        if (current.generation >= minimumGeneration) return current.promise;
        return current.promise
          .catch(() => false)
          .then(() => (leaseTokenRef.current === token ? renewLocalLease(token, minimumGeneration) : false));
      }
      const requestedAt = leaseClock();
      const generation = ++leaseRenewalGenerationRef.current;
      const attempt = api<TableLeaseTiming>(`/api/tables/${page.id}/lease`, {
        method: "PATCH",
        body: json({ leaseToken: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).then((result) => {
        assertLeaseTiming(result);
        if (leaseTokenRef.current !== token) return false;
        setLocalLeaseDeadline(requestedAt, result.leaseDurationMs);
        return true;
      });
      const tracked = { token, generation, promise: Promise.resolve(false) };
      tracked.promise = attempt.finally(() => {
        if (leaseRenewalRef.current === tracked) leaseRenewalRef.current = null;
      });
      leaseRenewalRef.current = tracked;
      return tracked.promise;
    },
    [page.id, setLocalLeaseDeadline],
  );

  const ensureLeaseUsable = useCallback(
    async (token: string) => {
      const status = localLeaseStatus();
      if (status === "valid") return true;
      if (status === "expired") {
        await endLease(token, LEASE_EXPIRED_MESSAGE, false);
        return false;
      }
      const minimumGeneration = leaseRenewalGenerationRef.current + 1;
      try {
        const renewed = await renewLocalLease(token, minimumGeneration);
        if (!renewed) return false;
        const renewedStatus = localLeaseStatus();
        if (renewedStatus === "valid") return true;
        await endLease(
          token,
          renewedStatus === "expired" ? LEASE_EXPIRED_MESSAGE : LEASE_VERIFICATION_MESSAGE,
          renewedStatus === "wall-clock-disagreement",
        );
      } catch (cause) {
        if (leaseTokenRef.current === token) {
          await endLease(
            token,
            cause instanceof ApiClientError && cause.status === 409 ? cause.message : LEASE_VERIFICATION_MESSAGE,
            !(cause instanceof ApiClientError && cause.status === 409),
          );
        }
      }
      return false;
    },
    [endLease, localLeaseStatus, renewLocalLease],
  );

  const runLeaseAction = useCallback((isCurrent: IsCurrent, action: () => Promise<void>) => {
    if (!isCurrent()) return Promise.resolve();
    const current = leaseActionRef.current;
    if (current?.owner === isCurrent) return current.promise;
    setLeasePending(true);
    const attempt = current
      ? current.promise.catch(() => undefined).then(() => (isCurrent() ? action() : undefined))
      : action();
    const tracked = { owner: isCurrent, promise: Promise.resolve() };
    tracked.promise = attempt.finally(() => {
      if (leaseActionRef.current !== tracked) return;
      leaseActionRef.current = null;
      if (mountedRef.current) setLeasePending(false);
    });
    leaseActionRef.current = tracked;
    return tracked.promise;
  }, []);

  const performAcquire = useCallback(
    async (isCurrent: IsCurrent, priorLoad?: Promise<void>) => {
      if (!canEdit) return;
      const requestedAt = leaseClock();
      let result: TableLeaseResponse;
      try {
        result = await api<TableLeaseResponse>(`/api/tables/${page.id}/lease`, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        try {
          assertLeaseResponse(result);
        } catch (cause) {
          const token = (result as { leaseToken?: unknown } | null)?.leaseToken;
          if (typeof token === "string" && token) releaseTableLease(page.id, token);
          throw cause;
        }
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof ApiClientError && cause.code === "lease_conflict") {
          leaseConflictGenerationRef.current += 1;
          clearLocalLease();
          setLeaseError(LEASE_CONFLICT_MESSAGE);
          // Settle the mount load before the retry supersedes it, so a failing
          // retry still leaves that table on screen. The generation bump above
          // keeps its older lease snapshot from clearing the notice.
          await priorLoad?.catch(() => undefined);
          if (isCurrent()) await load(isCurrent).catch(() => undefined);
          return;
        }
        throw cause;
      }
      if (!isCurrent()) {
        releaseTableLease(page.id, result.leaseToken);
        return;
      }
      leaseTokenRef.current = result.leaseToken;
      setLocalLeaseDeadline(requestedAt, result.leaseDurationMs);
      // Let the immediate mount load settle before starting the authoritative
      // post-acquisition load. This preserves a successful fallback if the
      // latter request fails without exposing edits against its older revision.
      await priorLoad?.catch(() => undefined);
      if (!isCurrent()) {
        if (leaseTokenRef.current === result.leaseToken) {
          leaseTokenRef.current = null;
          leaseMonotonicDeadlineRef.current = null;
          leaseWallDeadlineRef.current = null;
          releaseTableLease(page.id, result.leaseToken);
        }
        return;
      }
      if (!(await ensureLeaseUsable(result.leaseToken))) return;
      invalidateRevision();
      setLeaseToken(result.leaseToken);
      setLeaseError(null);
      setSaveError(null);
      await load(isCurrent).catch(() => undefined);
    },
    [canEdit, clearLocalLease, ensureLeaseUsable, invalidateRevision, load, page.id, setLocalLeaseDeadline],
  );

  const acquire = useCallback(
    (isCurrent: IsCurrent, priorLoad?: Promise<void>) => {
      if (!canEdit) return Promise.resolve();
      return runLeaseAction(isCurrent, () => performAcquire(isCurrent, priorLoad));
    },
    [canEdit, performAcquire, runLeaseAction],
  );

  const reportLeaseError = useCallback((cause: unknown) => {
    if (mountedRef.current) setLeaseError(errorMessage(cause, "The editing lease could not be acquired."));
  }, []);

  useEffect(() => {
    let active = true;
    const isCurrent = () => active && mountedRef.current;
    const initialLoad = load(isCurrent);
    void initialLoad.catch(() => undefined);
    if (canEdit) void acquire(isCurrent, initialLoad).catch(reportLeaseError);
    return () => {
      active = false;
    };
  }, [load, acquire, canEdit, reportLeaseError]);

  useEffect(() => {
    if (leaseToken && tableLoaded && revisionKnown) return undefined;
    let active = true;
    const isCurrent = () => active && mountedRef.current;
    const poll = window.setInterval(() => {
      if (!loadsInFlightRef.current) void load(isCurrent).catch(() => undefined);
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [leaseToken, load, revisionKnown, tableLoaded]);

  useEffect(() => {
    if (!leaseToken) return undefined;
    let active = true;
    let renewing = false;
    let expiryTimer: number | undefined;
    let renew: number | undefined;
    const stopRenewal = () => {
      active = false;
      if (renew !== undefined) window.clearInterval(renew);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", checkExpiry);
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener("pageshow", checkExpiry);
    };
    const expireLease = () => {
      if (!active) return;
      stopRenewal();
      void endLease(leaseToken, LEASE_EXPIRED_MESSAGE, false);
    };
    const checkExpiry = () => {
      const status = localLeaseStatus();
      if (status === "expired") {
        expireLease();
        return;
      }
      if (status === "valid") {
        scheduleExpiry();
        return;
      }
      if (status === "wall-clock-disagreement") {
        void ensureLeaseUsable(leaseToken).then((usable) => {
          if (!active) return;
          if (!usable) {
            stopRenewal();
            return;
          }
          scheduleExpiry();
          setLeaseError(null);
        });
      }
    };
    const scheduleExpiry = () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      const monotonicDeadline = leaseMonotonicDeadlineRef.current;
      if (monotonicDeadline === null) {
        expireLease();
        return;
      }
      expiryTimer = window.setTimeout(checkExpiry, Math.max(0, monotonicDeadline - performance.now()));
    };
    const renewLease = async () => {
      if (renewing || !active) return;
      renewing = true;
      try {
        const renewed = await renewLocalLease(leaseToken);
        if (active && renewed) {
          scheduleExpiry();
          setLeaseError(null);
        }
      } catch (cause) {
        if (!active) return;
        // A response we cannot read leaves the real deadline unknown, so drop
        // the lease instead of editing against it — the same call the
        // acquisition path makes on an unreadable response.
        if (cause instanceof LeaseResponseError) {
          stopRenewal();
          await endLease(leaseToken, cause.message);
          return;
        }
        const retryable = !(cause instanceof ApiClientError) || cause.status === 429 || cause.status >= 500;
        if (retryable) {
          const status = localLeaseStatus();
          if (status !== "valid") {
            stopRenewal();
            await endLease(
              leaseToken,
              status === "expired" ? LEASE_EXPIRED_MESSAGE : LEASE_VERIFICATION_MESSAGE,
              status === "wall-clock-disagreement",
            );
            return;
          }
          setLeaseError(`${errorMessage(cause, "The editing lease could not be renewed.")} Retrying.`);
          return;
        }
        stopRenewal();
        await endLease(
          leaseToken,
          cause.status === 409 ? "The editing lease was lost. Reloaded the authoritative table." : cause.message,
          cause.status !== 401,
        );
      } finally {
        renewing = false;
      }
    };
    renew = window.setInterval(() => void renewLease(), LEASE_RENEWAL_INTERVAL_MS);
    document.addEventListener("visibilitychange", checkExpiry);
    window.addEventListener("focus", checkExpiry);
    window.addEventListener("pageshow", checkExpiry);
    scheduleExpiry();
    return stopRenewal;
  }, [endLease, ensureLeaseUsable, leaseToken, localLeaseStatus, renewLocalLease]);

  async function saveTitle() {
    const normalized = title.trim() || "Untitled";
    if (normalized === page.title) return;
    const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
      method: "PATCH",
      body: json({ title: normalized, revision: page.revision }),
    });
    onPageChanged(result.page);
  }

  async function mutation<T>(
    path: string,
    method: string,
    body: Record<string, unknown>,
    { resetKey }: MutationOptions = {},
  ) {
    const execute = async () => {
      const failForLostLease = () => {
        resetCellInput(resetKey);
        if (isMounted()) setSaveError(LEASE_LOST_SAVE_MESSAGE);
        return null;
      };
      const currentLease = leaseTokenRef.current;
      if (!currentLease) return failForLostLease();
      let revisionConflictRetried = false;
      while (leaseTokenRef.current === currentLease) {
        if (revisionRef.current === null) {
          const recovered = await recoverRevision();
          if (leaseTokenRef.current !== currentLease) return failForLostLease();
          if (!recovered) {
            resetCellInputAfterLoad(resetKey);
            if (isMounted()) setSaveError(REVISION_RECOVERY_SAVE_MESSAGE);
            return null;
          }
        }
        if (!(await ensureLeaseUsable(currentLease))) return failForLostLease();
        const currentRevision = revisionRef.current!;
        try {
          const result = await api<T & { revision: number }>(path, {
            method,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: json({
              ...body,
              leaseToken: currentLease,
              expectedRevision: currentRevision,
            }),
          });
          if (!isMounted()) return null;
          // The request may have committed before the old lease was cleared but
          // returned after another lease was acquired. Its result belongs to the
          // authoritative reload for that lease, not this local state.
          if (leaseTokenRef.current !== currentLease) return null;
          revisionRef.current = result.revision;
          setSaveError(null);
          setTable((current) => (current ? { ...current, revision: result.revision } : current));
          return result;
        } catch (cause) {
          if (!isMounted()) return null;
          if (leaseTokenRef.current !== currentLease) {
            return failForLostLease();
          }
          if (cause instanceof ApiClientError && cause.code === "table_revision_conflict") {
            invalidateRevision();
            const terminalConflict = revisionConflictRetried;
            if (terminalConflict) resetCellInputAfterLoad(resetKey);
            else setSaveError(cause.message);
            const recovered = await recoverRevision();
            if (leaseTokenRef.current !== currentLease) return failForLostLease();
            if (!recovered) {
              resetCellInputAfterLoad(resetKey);
              setSaveError(REVISION_RECOVERY_SAVE_MESSAGE);
              return null;
            }
            if (terminalConflict) {
              setSaveError(REVISION_CONFLICT_SAVE_MESSAGE);
              return null;
            }
            revisionConflictRetried = true;
            continue;
          }
          if (cause instanceof ApiClientError && cause.status === 409) {
            resetCellInputAfterLoad(resetKey);
            await endLease(currentLease, cause.message);
            setSaveError(LEASE_LOST_SAVE_MESSAGE);
            return null;
          }
          if (cause instanceof ApiClientError && cause.status === 403) {
            await endLease(currentLease, cause.message);
            return null;
          }
          if (cause instanceof ApiClientError && cause.status === 404) {
            invalidateRevision();
            setSaveError(cause.message);
            resetCellInputAfterLoad(resetKey);
            await recoverRevision();
            return null;
          }
          // A handled client rejection is definitive: the server rejected the
          // request before applying it, so keep the known revision and the
          // user's input available for correction.
          if (isDefinitiveMutationRejection(cause)) {
            setSaveError(cause.message);
            return null;
          }
          // A timed-out or failed request may still have been applied. Its
          // outcome is ambiguous, so never replay it; pause edits and reload an
          // authoritative snapshot before the next queued mutation can run.
          invalidateRevision();
          setSaveError(errorMessage(cause, SAVE_FAILED_MESSAGE));
          resetCellInputAfterLoad(resetKey);
          await recoverRevision();
          return null;
        }
      }
      return failForLostLease();
    };
    const pending = mutationQueue.current.then(execute, execute);
    mutationQueue.current = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function addColumn() {
    if (!table) return;
    const name = prompt("Column name", "Property")?.trim();
    if (!name) return;
    const type = (prompt("Type: text, number, checkbox, date, or select", "text") ?? "") as ColumnType;
    if (!["text", "number", "checkbox", "date", "select"].includes(type)) return;
    const result = await mutation<{ column: TableColumn }>(`/api/tables/${page.id}/columns`, "POST", { name, type });
    if (result) {
      setTable((current) =>
        current ? { ...current, columns: [...current.columns, { ...result.column, options: [] }] } : current,
      );
    }
  }

  async function removeColumn(column: TableColumn) {
    if (!confirm(`Delete “${column.name}” and every value in it?`)) return;
    const result = await mutation(`/api/tables/${page.id}/columns/${column.id}`, "DELETE", {});
    if (result) {
      forgetColumnCellInputs(column.id);
      setTable((current) =>
        current ? { ...current, columns: current.columns.filter((item) => item.id !== column.id) } : current,
      );
    }
  }

  async function addOption(column: TableColumn) {
    const label = prompt(`New option for “${column.name}”`)?.trim();
    if (!label) return;
    const result = await mutation<{ option: { id: string; label: string; position: number } }>(
      `/api/tables/${page.id}/columns/${column.id}/options`,
      "POST",
      { label },
    );
    if (result)
      setTable((current) =>
        current
          ? {
              ...current,
              columns: current.columns.map((item) =>
                item.id === column.id ? { ...item, options: [...item.options, result.option] } : item,
              ),
            }
          : current,
      );
  }

  async function addRow() {
    if (!table) return;
    const result = await mutation<{ row: TableRow }>(`/api/tables/${page.id}/rows`, "POST", {});
    if (result) setTable((current) => (current ? { ...current, rows: [...current.rows, result.row] } : current));
  }

  async function removeRow(row: TableRow) {
    const result = await mutation(`/api/tables/${page.id}/rows/${row.id}`, "DELETE", {});
    if (result) {
      forgetRowCellInputs(row.id);
      setTable((current) =>
        current ? { ...current, rows: current.rows.filter((item) => item.id !== row.id) } : current,
      );
    }
  }

  async function setCell(rowId: string, columnId: string, value: string | number | boolean | null) {
    const result = await mutation(
      `/api/tables/${page.id}/cells/${rowId}/${columnId}`,
      "PUT",
      { value },
      { resetKey: cellInputKey(rowId, columnId) },
    );
    if (result)
      setTable((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row) =>
                row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: value } } : row,
              ),
            }
          : current,
      );
  }

  const visibleRows = useMemo(() => {
    if (!table) return [];
    const normalized = filter.toLowerCase();
    const rows = normalized
      ? table.rows.filter((row) =>
          Object.values(row.cells).some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(normalized),
          ),
        )
      : [...table.rows];
    if (sortColumn)
      rows.sort((left, right) =>
        String(left.cells[sortColumn] ?? "").localeCompare(String(right.cells[sortColumn] ?? ""), undefined, {
          numeric: true,
        }),
      );
    return rows;
  }, [filter, sortColumn, table]);
  const tryAcquire = async () => {
    await acquire(isMounted).catch(reportLeaseError);
  };

  const forceUnlock = () =>
    runLeaseAction(isMounted, async () => {
      try {
        await api(`/api/tables/${page.id}/force-unlock`, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        if (isMounted()) setLeaseError(errorMessage(cause, "The table could not be force-unlocked."));
        return;
      }
      if (!isMounted()) return;
      // Call performAcquire directly. acquire() would re-enter runLeaseAction
      // with the same owner and return this still-pending promise.
      await performAcquire(isMounted).catch(reportLeaseError);
    });

  const editingReady = Boolean(leaseToken && revisionKnown);

  return (
    <main className="page-canvas table-canvas">
      <div className="page-tools">
        <span className={`lease-state ${editingReady ? "lease-active" : ""}`}>
          {editingReady ? "Editing lease active" : leaseToken ? "Editing paused while table reloads" : "Read-only"}
        </span>
        {canEdit && (
          <button
            className="quiet-button"
            onClick={async () => {
              const icon = prompt("Page icon (one emoji, or leave blank to remove)", page.icon ?? "")?.trim();
              if (icon === undefined) return;
              const result = await api<{ page: Page }>(`/api/pages/${page.id}`, {
                method: "PATCH",
                body: json({ icon: icon || null, revision: page.revision }),
              });
              onPageChanged(result.page);
            }}
          >
            {page.icon ?? "Add icon"}
          </button>
        )}
        {!leaseToken && canEdit && (
          <button className="quiet-button" disabled={leasePending} onClick={() => void tryAcquire()}>
            Try edit lock
          </button>
        )}
        {member.role === "owner" && !leaseToken && (
          <button className="quiet-button" disabled={leasePending} onClick={() => void forceUnlock()}>
            Force unlock
          </button>
        )}
        <button className="quiet-button" onClick={() => setBacklinksOpen((open) => !open)}>
          Backlinks
        </button>
      </div>
      {leaseError && <div className="notice">{leaseError}</div>}
      {saveError && <div className="notice notice-danger">{saveError}</div>}
      {loadError && <div className="notice notice-danger">{loadError}</div>}
      <article className="table-paper">
        <input
          className="page-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          readOnly={!canEdit}
        />
        <div className="table-toolbar">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows…" />
          <span>
            {visibleRows.length} / {table?.rows.length ?? 0} rows
          </span>
          {editingReady && <button onClick={() => void addColumn()}>+ Property</button>}
        </div>
        {!table ? (
          <div className="editor-loading">Loading table…</div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column.id}>
                      <button
                        className="column-sort"
                        onClick={() => setSortColumn(sortColumn === column.id ? null : column.id)}
                      >
                        {column.name} <small>{column.type}</small>
                        {sortColumn === column.id ? " ↑" : ""}
                      </button>
                      {editingReady && column.type === "select" && (
                        <button
                          className="add-option"
                          onClick={() => void addOption(column)}
                          aria-label={`Add option to ${column.name}`}
                        >
                          +
                        </button>
                      )}
                      {editingReady && (
                        <button
                          className="delete-column"
                          onClick={() => void removeColumn(column)}
                          aria-label={`Delete ${column.name}`}
                        >
                          ×
                        </button>
                      )}
                    </th>
                  ))}
                  {editingReady && <th className="row-actions" aria-label="Row actions" />}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id}>
                    {table.columns.map((column) => (
                      <td key={column.id}>
                        <CellInput
                          key={`${cellResetGenerations[cellInputKey(row.id, column.id)] ?? 0}:${row.id}:${column.id}:${String(row.cells[column.id] ?? "")}`}
                          column={column}
                          value={row.cells[column.id] ?? null}
                          disabled={!editingReady}
                          onCommit={(value) => void setCell(row.id, column.id, value)}
                        />
                      </td>
                    ))}
                    {editingReady && (
                      <td className="row-actions">
                        <button onClick={() => void removeRow(row)} aria-label="Delete row">
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {editingReady && (
              <button className="add-row" onClick={() => void addRow()} disabled={table.rows.length >= 500}>
                + New row
              </button>
            )}
            {!table.columns.length && <p className="empty-copy">Add a property to start this table.</p>}
          </div>
        )}
      </article>
      {backlinksOpen && <BacklinksPanel pageId={page.id} revision={backlinksRevision} onSelect={onSelectPage} />}
    </main>
  );
}

function CellInput({
  column,
  value,
  disabled,
  onCommit,
}: {
  column: TableColumn;
  value: string | number | boolean | null;
  disabled: boolean;
  onCommit: (value: string | number | boolean | null) => void;
}) {
  const lastEnqueuedValue = useRef(normalizedInputValue(column, value));
  if (column.type === "checkbox") {
    return (
      <input
        aria-label={column.name}
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.checked)}
      />
    );
  }
  if (column.type === "select") {
    return (
      <select
        aria-label={column.name}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.value || null)}
      >
        <option value="">—</option>
        {column.options.map((option) => (
          <option value={option.id} key={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={column.name}
      type={column.type === "number" ? "number" : column.type === "date" ? "date" : "text"}
      defaultValue={value === null ? "" : String(value)}
      disabled={disabled}
      onBlur={(event) => {
        const nextValue =
          column.type === "number"
            ? event.target.value === ""
              ? null
              : Number(event.target.value)
            : event.target.value || null;
        if (!Object.is(nextValue, lastEnqueuedValue.current)) {
          lastEnqueuedValue.current = nextValue;
          onCommit(nextValue);
        }
      }}
    />
  );
}
