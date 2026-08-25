import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TABLE_MAX_ROWS, TABLE_PAGE_DEFAULT, TABLE_SORT_MAX_OFFSET } from "../shared/table-limits";
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
  affectsSortedOrder: boolean | string;
};
type RevisionRecoveryOptions = {
  minimumRevision?: number | null;
  ownerIsCurrent?: IsCurrent;
  background?: boolean;
  onFailure?: (cause: unknown) => void;
};
type TableSortState = {
  column: string | null;
  dir: "asc" | "desc";
};
type TableLoadOutcome = "adopted" | "superseded" | "stale" | "retry";
type StaleRevisionFailure = "throw" | "keep-current" | "invalidate";
type LoadOptions = {
  background?: boolean;
  minimumRevision?: number | null;
  onFailure?: (cause: unknown) => void;
  staleRevisionFailure?: StaleRevisionFailure;
  retryStaleRevision?: boolean;
};
type RestoreDepthOptions = {
  ownerIsCurrent?: IsCurrent;
  background?: boolean;
  onFailure?: (cause: unknown) => void;
  staleRevisionFailure?: StaleRevisionFailure;
  preserveDepthOnChurn?: boolean;
  retryStaleRevision?: boolean;
};
type StaleRevisionDecision = "accept" | "retry" | "cancel";
type RevisionRecoveryTarget = {
  page: TableData | null;
  sortKey: string;
  appendedPageTarget: number;
};
type RevisionPollMode = "off" | "recovery" | "refresh";

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
const DEPTH_RESTORE_MESSAGE = "The table depth could not be restored.";
const STALE_REFRESH_MESSAGE = "Table refresh is delayed while waiting for the latest revision.";
const STALE_TABLE_REVISION_MESSAGE = "The table kept returning an older revision.";
const INVALID_TABLE_PAGINATION_MESSAGE = "The table returned incomplete pagination information.";
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_REVISION_RETRY_DELAYS_MS = [50, 200] as const;
const REVISION_POLL_INTERVAL_MS = 5_000;
const REVISION_POLL_MAX_BACKOFF_MS = 60_000;
const REVISION_RECOVERY_ERROR_THRESHOLD = 3;
// An invalid server sort cannot remain the active view. Keep recovery polling
// until an authoritative unsorted page can replace it, even if its caller was
// only an ordinary background refresh.
const INVALID_SORT_STALE_REVISION_FAILURE: StaleRevisionFailure = "invalidate";
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

function tableSortKey(column: string | null, dir: "asc" | "desc") {
  return column ? `${column}:${dir}` : "";
}

function firstTablePageParams(sort: string | null, dir: "asc" | "desc") {
  const params = new URLSearchParams({ limit: String(TABLE_PAGE_DEFAULT), count: "true" });
  if (sort) {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  return params;
}

function nextTablePageParams(currentPage: TableData) {
  const params = new URLSearchParams({ limit: String(currentPage.limit) });
  if (currentPage.sort) {
    if (currentPage.nextOffset === null) return null;
    params.set("sort", currentPage.sort);
    params.set("dir", currentPage.dir);
    params.set("offset", String(currentPage.nextOffset));
  } else {
    if (!currentPage.nextCursor) return null;
    params.set("afterPosition", String(currentPage.nextCursor.position));
    params.set("afterId", currentPage.nextCursor.rowId);
  }
  return params;
}

class StaleTableRevisionError extends Error {
  constructor() {
    super(STALE_TABLE_REVISION_MESSAGE);
    this.name = "StaleTableRevisionError";
  }
}

class IncompleteTablePaginationError extends Error {
  constructor() {
    super(INVALID_TABLE_PAGINATION_MESSAGE);
    this.name = "IncompleteTablePaginationError";
  }
}

function waitForStaleRevisionRetry(attempt: number, retryDelays: readonly number[]) {
  const delay = retryDelays[attempt];
  if (delay === undefined) throw new StaleTableRevisionError();
  return new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

async function readWithStaleRevisionRetries<T>(
  read: () => Promise<T>,
  classify: (result: T) => StaleRevisionDecision | Promise<StaleRevisionDecision>,
  isCurrent: IsCurrent,
  retryDelays: readonly number[] = STALE_REVISION_RETRY_DELAYS_MS,
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await read();
    const decision = await classify(result);
    if (decision === "accept") return result;
    if (decision === "cancel") return null;
    await waitForStaleRevisionRetry(attempt, retryDelays);
    if (!isCurrent()) return null;
  }
}

function revisionFloor(...revisions: (number | null | undefined)[]) {
  let floor: number | null = null;
  for (const revision of revisions) {
    if (revision !== null && revision !== undefined && (floor === null || revision > floor)) floor = revision;
  }
  return floor;
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

// The table's page was archived or deleted underneath this view. Terminal for
// the component: nothing it could request would succeed afterwards.
function isPageUnavailableError(cause: unknown): cause is ApiClientError {
  return cause instanceof ApiClientError && cause.code === "page_not_found";
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
  onPageUnavailable?: (pageId: string) => void;
  onSelectPage: (pageId: string) => void;
  backlinksRevision: number;
};

export function TablePage({
  page,
  member,
  onPageChanged,
  onPageUnavailable,
  onSelectPage,
  backlinksRevision,
}: TablePageProps) {
  const canEdit = member.role !== "viewer";
  const [table, setTable] = useState<TableData | null>(null);
  const tableRef = useRef<TableData | null>(null);
  const [leaseToken, setLeaseToken] = useState<string | null>(null);
  const [leasePending, setLeasePending] = useState(canEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revisionRecoveryPending, setRevisionRecoveryPending] = useState(false);
  const [revisionRecoveryError, setRevisionRecoveryError] = useState<string | null>(null);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const [terminalPageUnavailable, setTerminalPageUnavailable] = useState(false);
  // Kept apart from leaseError: a successful renewal clears the lease notice on
  // every interval and would otherwise erase an unsaved-edit warning.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Mirrors revisionRef for rendering: a mutation that failed with an unknown
  // outcome drops the revision, and polling has to resume to recover it.
  const [revisionKnown, setRevisionKnown] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortRequest, setSortRequest] = useState<TableSortState>({
    column: null,
    dir: "asc",
  });
  const { column: sortColumn, dir: sortDir } = sortRequest;
  const appliedSortKeyRef = useRef(tableSortKey(sortColumn, sortDir));
  // Mirrored so `load` can read the current sort without taking it as a dependency:
  // the mount effect keys off `load`, and rebuilding it would re-acquire the lease.
  const sortRef = useRef<{ column: string | null; dir: "asc" | "desc" }>({ column: null, dir: "asc" });
  useEffect(() => {
    sortRef.current = { column: sortColumn, dir: sortDir };
  }, [sortColumn, sortDir]);
  const requestSort = useCallback((column: string | null, dir: "asc" | "desc") => {
    // Keep async request guards current before the state-driven load effect runs.
    sortRef.current = { column, dir };
    setSortRequest({ column, dir });
  }, []);
  const clearSort = useCallback(() => requestSort(null, sortRef.current.dir), [requestSort]);
  // Pages appended past the first. While any are loaded the background poll stands
  // down, so browsing deep into a table is not yanked back to the top every 5s.
  const appendedPagesRef = useRef(0);
  // The revision the currently loaded page boundary was computed against. Only
  // `load` and `loadMore` may move it: `nextOffset` is a position in one exact
  // snapshot, and own saves bump `table.revision` in place without recomputing it.
  const pageSnapshotRevisionRef = useRef<number | null>(null);
  // A revision bump does not necessarily invalidate a sorted offset: editing another
  // column leaves the ordering intact. Track only mutations that can move rows.
  const sortedSnapshotDirtyRef = useRef(false);
  const [tableBusy, setTableBusy] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [cellResetGenerations, setCellResetGenerations] = useState<Record<string, number>>({});
  const revisionRef = useRef<number | null>(null);
  // When a revision is invalidated, retain the strongest known floor until an
  // authoritative load satisfies it. This lets background recovery continue an
  // interrupted mutation or sort recovery without regressing to displayed data.
  const revisionRecoveryFloorRef = useRef<number | null>(null);
  const revisionRecoveryTargetRef = useRef<RevisionRecoveryTarget | null>(null);
  const revisionRecoveryPendingRef = useRef(false);
  const leaseTokenRef = useRef<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  // Only row additions and removals can disturb the default (position, id)
  // presentation while a keyset request is in flight. Cell and schema saves do
  // not need to delay unsorted pagination.
  const rowOrderMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const unsortedSnapshotDirtyRef = useRef(false);
  const leaseActionRef = useRef<{ owner: IsCurrent; promise: Promise<void> } | null>(null);
  const leaseMonotonicDeadlineRef = useRef<number | null>(null);
  const leaseWallDeadlineRef = useRef<number | null>(null);
  const leaseRenewalRef = useRef<{ token: string; generation: number; promise: Promise<boolean> } | null>(null);
  const leaseRenewalGenerationRef = useRef(0);
  const pendingCellResetsRef = useRef(new Set<string>());
  const leaseConflictGenerationRef = useRef(0);
  const loadsInFlightRef = useRef(0);
  // User-initiated loads only. The 5-second background poll counts toward
  // loadsInFlightRef (so polls never overlap other requests) but not here: driving
  // tableBusy from every poll tick would re-render the page and flicker-disable
  // "Load more rows" for the duration of each background request.
  const userLoadsInFlightRef = useRef(0);
  // Background depth recovery never joins mutationQueue: a lagging replica must
  // not delay saves. This generation lets a newly queued mutation discard a
  // background snapshot that started before it, while the pending count keeps a
  // new poll from starting until all already queued mutations have settled.
  const mutationGenerationRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const wakeRevisionRecoveryRef = useRef<() => void>(() => undefined);
  const configureRevisionPollingRef = useRef<(mode: RevisionPollMode) => void>(() => undefined);
  const revisionPollModeRef = useRef<RevisionPollMode>("off");
  const revisionRecoveryWakePendingRef = useRef(false);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  // A generation can advance before its request settles. Remember which
  // generation actually adopted a snapshot so a queued restore can distinguish
  // a successful replacement from a merely in-flight superseding request.
  const authoritativeLoadGenerationRef = useRef(0);
  // Mirrors terminalPageUnavailable for async code that must not act on stale
  // render state, e.g. a queued mutation deciding whether a missing lease is
  // worth reporting.
  const pageUnavailableRef = useRef(false);
  const onPageUnavailableRef = useRef(onPageUnavailable);
  const tableLoaded = table !== null;

  const currentRevisionFloor = useCallback(
    (...revisions: (number | null | undefined)[]) =>
      revisionFloor(
        revisionRecoveryFloorRef.current,
        revisionRef.current,
        pageSnapshotRevisionRef.current,
        ...revisions,
      ),
    [],
  );

  const preserveRevisionFloor = useCallback((...revisions: (number | null | undefined)[]) => {
    revisionRecoveryFloorRef.current = revisionFloor(revisionRecoveryFloorRef.current, ...revisions);
  }, []);

  const clearRevisionRecovery = useCallback(() => {
    revisionRecoveryFloorRef.current = null;
    revisionRecoveryTargetRef.current = null;
    revisionRecoveryPendingRef.current = false;
    revisionRecoveryWakePendingRef.current = false;
    setRevisionRecoveryPending(false);
    setRevisionRecoveryError(null);
  }, []);

  const deferRevisionRecovery = useCallback(
    (
      minimumRevision: number | null,
      recoveryPage: TableData | null = tableRef.current,
      appendedPageTarget = appendedPagesRef.current,
    ) => {
      preserveRevisionFloor(currentRevisionFloor(recoveryPage?.revision, minimumRevision));
      const sortKey = recoveryPage
        ? tableSortKey(recoveryPage.sort, recoveryPage.dir)
        : tableSortKey(sortRef.current.column, sortRef.current.dir);
      const currentTarget = revisionRecoveryTargetRef.current;
      if (currentTarget?.sortKey === sortKey) {
        revisionRecoveryTargetRef.current = {
          page: currentTarget.page ?? recoveryPage,
          sortKey,
          appendedPageTarget: Math.max(currentTarget.appendedPageTarget, appendedPageTarget),
        };
      } else {
        revisionRecoveryTargetRef.current = { page: recoveryPage, sortKey, appendedPageTarget };
      }
      revisionRecoveryPendingRef.current = true;
      setRevisionRecoveryPending(true);
      // Preserve unrelated transport or sort errors, but replace the terminal-
      // sounding stale exhaustion message now that automatic recovery is active.
      setLoadError((current) => (current === STALE_TABLE_REVISION_MESSAGE ? null : current));
    },
    [currentRevisionFloor, preserveRevisionFloor],
  );

  useEffect(() => {
    tableRef.current = table;
  }, [table]);

  useEffect(() => {
    onPageUnavailableRef.current = onPageUnavailable;
  }, [onPageUnavailable]);

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
  // Every request site that can learn the page is gone (a table load, a lease
  // acquisition or renewal, a mutation) funnels through here, so polling,
  // renewal, and queued edits stop no matter which request noticed first.
  const markPageUnavailable = useCallback(
    (message: string) => {
      if (pageUnavailableRef.current || !mountedRef.current) return;
      pageUnavailableRef.current = true;
      const currentLease = leaseTokenRef.current;
      clearLocalLease();
      if (currentLease) releaseTableLease(page.id, currentLease);
      setTerminalPageUnavailable(true);
      setSaveError(null);
      clearRevisionRecovery();
      setLoadError(null);
      setLeaseError(message);
      onPageUnavailableRef.current?.(page.id);
    },
    [clearLocalLease, clearRevisionRecovery, page.id],
  );
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

  const forgetCellInputs = useCallback((shouldForget: (key: string) => boolean) => {
    for (const key of pendingCellResetsRef.current) {
      if (shouldForget(key)) pendingCellResetsRef.current.delete(key);
    }
    setCellResetGenerations((current) => {
      const entries = Object.entries(current).filter(([key]) => !shouldForget(key));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, []);

  const invalidateRevision = useCallback(() => {
    revisionRecoveryFloorRef.current = revisionFloor(
      revisionRecoveryFloorRef.current,
      revisionRef.current,
      pageSnapshotRevisionRef.current,
    );
    revisionRef.current = null;
    setRevisionKnown(false);
  }, []);

  const changeLoadCount = useCallback((delta: 1 | -1, background: boolean) => {
    loadsInFlightRef.current += delta;
    if (!background) {
      userLoadsInFlightRef.current += delta;
      if (mountedRef.current) setTableBusy(userLoadsInFlightRef.current > 0);
    }
    if (
      delta === -1 &&
      !loadsInFlightRef.current &&
      !pendingMutationsRef.current &&
      revisionRecoveryWakePendingRef.current
    ) {
      wakeRevisionRecoveryRef.current();
    }
  }, []);

  const handleStaleRevisionFailure = useCallback(
    (
      cause: unknown,
      failure: StaleRevisionFailure,
      minimumRevision: number | null,
      isCurrent: IsCurrent,
      recoveryPage: TableData | null = tableRef.current,
      appendedPageTarget = appendedPagesRef.current,
    ): TableLoadOutcome | null => {
      if (!(cause instanceof StaleTableRevisionError)) return null;
      // The final retry rejection crosses a promise boundary before reaching its
      // caller's catch block. A newer load can supersede it in that gap.
      if (!isCurrent()) return "superseded";
      if (failure === "throw") return null;
      preserveRevisionFloor(minimumRevision);
      if (failure === "invalidate") invalidateRevision();
      deferRevisionRecovery(minimumRevision, recoveryPage, appendedPageTarget);
      return "stale";
    },
    [deferRevisionRecovery, invalidateRevision, preserveRevisionFloor],
  );

  const recoverInvalidSort = useCallback(
    (cause: unknown, generation: number, isCurrent: IsCurrent, minimumRevision: number | null = null) => {
      if (
        !isCurrent() ||
        generation !== loadGenerationRef.current ||
        !(cause instanceof ApiClientError) ||
        cause.code !== "invalid_table_sort" ||
        !sortRef.current.column
      ) {
        return null;
      }
      const recoveryFloor = currentRevisionFloor(minimumRevision);
      preserveRevisionFloor(recoveryFloor);
      const recoveryDir = sortRef.current.dir;
      // This recovery owns the replacement load directly. Mark the matching
      // state transition as applied so the sort effect does not issue a duplicate.
      appliedSortKeyRef.current = tableSortKey(null, recoveryDir);
      requestSort(null, recoveryDir);
      setLoadError(null);
      return { minimumRevision: recoveryFloor };
    },
    [currentRevisionFloor, preserveRevisionFloor, requestSort],
  );

  const adoptAuthoritativeTable = useCallback(
    (
      authoritative: TableData,
      appendedPages: number,
      leaseConflictGeneration: number,
      background: boolean,
      loadGeneration: number,
    ) => {
      const recoveryFloor = revisionRecoveryFloorRef.current;
      if (recoveryFloor !== null && authoritative.revision < recoveryFloor) {
        throw new StaleTableRevisionError();
      }
      revisionRef.current = authoritative.revision;
      authoritativeLoadGenerationRef.current = loadGeneration;
      setRevisionKnown(true);
      const validRows = new Set(authoritative.rows.map((row) => row.id));
      const validColumns = new Set(authoritative.columns.map((column) => column.id));
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
      appendedPagesRef.current = appendedPages;
      pageSnapshotRevisionRef.current = authoritative.revision;
      sortedSnapshotDirtyRef.current = false;
      unsortedSnapshotDirtyRef.current = false;
      const recoveryTarget = revisionRecoveryTargetRef.current;
      const authoritativeSort = tableSortKey(authoritative.sort, authoritative.dir);
      if (
        !background ||
        !recoveryTarget ||
        recoveryTarget.sortKey !== authoritativeSort ||
        appendedPages >= recoveryTarget.appendedPageTarget ||
        !authoritative.hasMore
      ) {
        clearRevisionRecovery();
      }
      setTable(authoritative);
      setLoadError(null);
      if (authoritative.lease.expiresAt === null && leaseConflictGeneration === leaseConflictGenerationRef.current) {
        setLeaseError((current) => (current === LEASE_CONFLICT_MESSAGE ? null : current));
      }
    },
    [clearRevisionRecovery],
  );

  const load = useCallback(
    async function loadTable(isCurrent: IsCurrent, options: LoadOptions = {}): Promise<TableLoadOutcome> {
      const {
        background = false,
        minimumRevision = null,
        onFailure,
        staleRevisionFailure = "throw",
        retryStaleRevision = true,
      } = options;
      const generation = ++loadGenerationRef.current;
      const mutationGeneration = mutationGenerationRef.current;
      const leaseConflictGeneration = leaseConflictGenerationRef.current;
      const loadIsCurrent = () => isCurrent() && generation === loadGenerationRef.current;
      const requestIsCurrent = () =>
        loadIsCurrent() && (!background || mutationGeneration === mutationGenerationRef.current);
      changeLoadCount(1, background);
      try {
        const params = firstTablePageParams(sortRef.current.column, sortRef.current.dir);
        const result = await readWithStaleRevisionRetries(
          () =>
            api<{ table: TableData }>(`/api/tables/${page.id}?${params}`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          (candidate) => {
            if (!requestIsCurrent()) return "cancel";
            // A snapshot read before a mutation this client already merged would
            // revert that edit on screen and regress the mutation base.
            const requiredRevision = currentRevisionFloor(minimumRevision);
            return requiredRevision !== null && candidate.table.revision < requiredRevision ? "retry" : "accept";
          },
          requestIsCurrent,
          retryStaleRevision ? STALE_REVISION_RETRY_DELAYS_MS : [],
        );
        if (!result || !requestIsCurrent()) return "superseded";
        adoptAuthoritativeTable(result.table, 0, leaseConflictGeneration, background, generation);
        return "adopted";
      } catch (cause) {
        const recoveryFloor = currentRevisionFloor(minimumRevision);
        const staleOutcome = handleStaleRevisionFailure(cause, staleRevisionFailure, recoveryFloor, requestIsCurrent);
        if (staleOutcome) return staleOutcome;
        const invalidSortRecovery = recoverInvalidSort(cause, generation, loadIsCurrent, minimumRevision);
        if (invalidSortRecovery) {
          return loadTable(isCurrent, {
            background,
            minimumRevision: invalidSortRecovery.minimumRevision,
            onFailure,
            staleRevisionFailure: INVALID_SORT_STALE_REVISION_FAILURE,
            retryStaleRevision,
          });
        }
        if (mountedRef.current && generation === loadGenerationRef.current && isPageUnavailableError(cause)) {
          // Terminal even when the effect that issued this load is gone, but only
          // while no newer load superseded it: a stale page_not_found can belong
          // to a page that was archived and has since been restored, and whatever
          // load superseded this one re-checks the page either way.
          markPageUnavailable(cause.message);
        } else if (!requestIsCurrent()) {
          onFailure?.(cause);
          return "superseded";
        } else {
          onFailure?.(cause);
          if (!background || !revisionRecoveryPendingRef.current) {
            setLoadError(errorMessage(cause, "Table could not be loaded."));
          }
        }
        throw cause;
      } finally {
        changeLoadCount(-1, background);
      }
    },
    [
      adoptAuthoritativeTable,
      changeLoadCount,
      currentRevisionFloor,
      handleStaleRevisionFailure,
      markPageUnavailable,
      page.id,
      recoverInvalidSort,
    ],
  );

  const restoreDepthNow = useCallback(
    async (
      currentPage: TableData,
      appendedPageTarget: number,
      minimumRevision: number | null,
      options: RestoreDepthOptions = {},
    ): Promise<TableLoadOutcome> => {
      const {
        ownerIsCurrent = isMounted,
        background = false,
        onFailure,
        staleRevisionFailure = "throw",
        preserveDepthOnChurn = false,
        retryStaleRevision = true,
      } = options;
      const requestedSort = tableSortKey(currentPage.sort, currentPage.dir);
      if (
        !ownerIsCurrent() ||
        !mountedRef.current ||
        requestedSort !== tableSortKey(sortRef.current.column, sortRef.current.dir)
      ) {
        return "superseded";
      }
      changeLoadCount(1, background);
      if (staleRevisionFailure !== "keep-current") invalidateRevision();
      const generation = ++loadGenerationRef.current;
      const mutationGeneration = mutationGenerationRef.current;
      const leaseConflictGeneration = leaseConflictGenerationRef.current;
      const recoveryIsCurrent = () =>
        ownerIsCurrent() &&
        mountedRef.current &&
        generation === loadGenerationRef.current &&
        requestedSort === tableSortKey(sortRef.current.column, sortRef.current.dir);
      const isCurrent = () =>
        recoveryIsCurrent() && (!background || mutationGeneration === mutationGenerationRef.current);
      const recoverAfterChurn = () => {
        if (preserveDepthOnChurn) {
          deferRevisionRecovery(
            currentRevisionFloor(minimumRevision, currentPage.revision),
            currentPage,
            appendedPageTarget,
          );
          return "retry" as const;
        }
        return load(ownerIsCurrent, {
          background,
          minimumRevision,
          onFailure,
          staleRevisionFailure,
          retryStaleRevision,
        });
      };
      try {
        const firstParams = firstTablePageParams(currentPage.sort, currentPage.dir);
        const first = await readWithStaleRevisionRetries(
          () =>
            api<{ table: TableData }>(`/api/tables/${page.id}?${firstParams}`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          (candidate) => {
            if (!isCurrent()) return "cancel";
            const requiredRevision = currentRevisionFloor(minimumRevision, currentPage.revision);
            return requiredRevision !== null && candidate.table.revision < requiredRevision ? "retry" : "accept";
          },
          isCurrent,
          retryStaleRevision ? STALE_REVISION_RETRY_DELAYS_MS : [],
        );
        if (!first) return "superseded";
        if (tableSortKey(first.table.sort, first.table.dir) !== requestedSort) {
          return recoverAfterChurn();
        }

        const snapshotRevision = first.table.revision;
        let restored = first.table;
        let appendedPages = 0;
        let incompletePagination = false;
        const loaded = new Set(restored.rows.map((row) => row.id));
        while (appendedPages < appendedPageTarget && restored.hasMore) {
          const params = nextTablePageParams(restored);
          if (!params) {
            incompletePagination = true;
            break;
          }
          const next = await api<{ table: TableData }>(`/api/tables/${page.id}?${params}`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!isCurrent()) return "superseded";
          if (
            next.table.revision !== snapshotRevision ||
            tableSortKey(next.table.sort, next.table.dir) !== requestedSort
          ) {
            // Another writer moved the table while its depth was being rebuilt. A
            // foreground action may fall back to page one, but a background poll
            // must preserve the displayed depth and retry after churn settles.
            return recoverAfterChurn();
          }
          const rows = next.table.rows.filter((row) => !loaded.has(row.id));
          rows.forEach((row) => loaded.add(row.id));
          restored = {
            ...restored,
            rows: [...restored.rows, ...rows],
            hasMore: next.table.hasMore,
            nextCursor: next.table.nextCursor,
            nextOffset: next.table.nextOffset,
            truncated: next.table.truncated,
          };
          appendedPages += 1;
        }
        if (!isCurrent()) return "superseded";
        const requiredRevision = currentRevisionFloor(minimumRevision, currentPage.revision);
        if (requiredRevision !== null && restored.revision < requiredRevision) {
          throw new StaleTableRevisionError();
        }
        if (incompletePagination && background) {
          deferRevisionRecovery(requiredRevision, currentPage, appendedPageTarget);
          throw new IncompleteTablePaginationError();
        }
        adoptAuthoritativeTable(restored, appendedPages, leaseConflictGeneration, background, generation);
        if (incompletePagination) {
          setLoadError(INVALID_TABLE_PAGINATION_MESSAGE);
        }
        return "adopted";
      } catch (cause) {
        const recoveryFloor = currentRevisionFloor(minimumRevision, currentPage.revision);
        const staleOutcome = handleStaleRevisionFailure(
          cause,
          staleRevisionFailure,
          recoveryFloor,
          isCurrent,
          currentPage,
          appendedPageTarget,
        );
        if (staleOutcome) return staleOutcome;
        const invalidSortRecovery = recoverInvalidSort(cause, generation, recoveryIsCurrent, recoveryFloor);
        if (invalidSortRecovery) {
          return load(ownerIsCurrent, {
            background,
            minimumRevision: invalidSortRecovery.minimumRevision,
            onFailure,
            staleRevisionFailure: INVALID_SORT_STALE_REVISION_FAILURE,
            retryStaleRevision,
          });
        }
        if (mountedRef.current && generation === loadGenerationRef.current && isPageUnavailableError(cause)) {
          markPageUnavailable(cause.message);
        } else if (!isCurrent()) {
          onFailure?.(cause);
          return "superseded";
        } else {
          onFailure?.(cause);
          if (!background || !revisionRecoveryPendingRef.current) {
            setLoadError(errorMessage(cause, DEPTH_RESTORE_MESSAGE));
          }
        }
        throw cause;
      } finally {
        changeLoadCount(-1, background);
      }
    },
    [
      adoptAuthoritativeTable,
      changeLoadCount,
      currentRevisionFloor,
      deferRevisionRecovery,
      handleStaleRevisionFailure,
      invalidateRevision,
      isMounted,
      load,
      markPageUnavailable,
      page.id,
      recoverInvalidSort,
    ],
  );

  const restoreDepth = useCallback(
    async (currentPage: TableData, appendedPageTarget: number, options: RestoreDepthOptions = {}) => {
      // Block later mutations behind this rebuild. They need one authoritative revision,
      // while every page boundary is re-derived from that same revision in sequence.
      const queuedGeneration = loadGenerationRef.current;
      const restore = () => {
        if (queuedGeneration !== loadGenerationRef.current) {
          if (
            mountedRef.current &&
            (options.ownerIsCurrent ?? isMounted)() &&
            authoritativeLoadGenerationRef.current <= queuedGeneration &&
            tableSortKey(currentPage.sort, currentPage.dir) ===
              tableSortKey(sortRef.current.column, sortRef.current.dir)
          ) {
            deferRevisionRecovery(currentRevisionFloor(currentPage.revision), currentPage, appendedPageTarget);
          }
          return "superseded" as const;
        }
        return restoreDepthNow(currentPage, appendedPageTarget, currentRevisionFloor(currentPage.revision), options);
      };
      const pending = mutationQueue.current.then(restore, restore);
      mutationQueue.current = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    [currentRevisionFloor, deferRevisionRecovery, isMounted, restoreDepthNow],
  );

  // Appends the next keyset or offset page. Deliberately separate from `load`,
  // which always returns to the first page so a refresh has one predictable meaning.
  async function loadMore(currentPage: TableData) {
    // An unknown revision means a full-page load is restoring the authoritative
    // mutation base. Pagination must neither supersede that load nor keep future
    // recovery polls from running.
    if (userLoadsInFlightRef.current || revisionRef.current === null || !currentPage.hasMore) {
      return;
    }

    const params = nextTablePageParams(currentPage);
    if (!params) return;

    // Advancing the generation discards a background refresh still in flight, so its
    // page-one result cannot land after this append and yank the view back to the top.
    const generation = ++loadGenerationRef.current;
    const requestedSort = tableSortKey(currentPage.sort, currentPage.dir);
    const snapshotRevision = pageSnapshotRevisionRef.current ?? currentPage.revision;
    const requestedAppendedPages = appendedPagesRef.current + 1;
    const isCurrent = () =>
      mountedRef.current &&
      generation === loadGenerationRef.current &&
      requestedSort === tableSortKey(sortRef.current.column, sortRef.current.dir);
    const canAppend = () => isCurrent() && revisionRef.current !== null;
    changeLoadCount(1, false);
    try {
      if (
        (currentPage.sort && sortedSnapshotDirtyRef.current) ||
        (!currentPage.sort && unsortedSnapshotDirtyRef.current)
      ) {
        await restoreDepth(currentPage, requestedAppendedPages, { staleRevisionFailure: "invalidate" });
        return;
      }
      let result: { table: TableData } | null;
      if (currentPage.sort) {
        result = await api<{ table: TableData }>(`/api/tables/${page.id}?${params}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // Any sorted value can move a row across an offset boundary, so wait for
        // every mutation before deciding whether this snapshot is still usable.
        await mutationQueue.current;
        if (!isCurrent() || tableSortKey(result.table.sort, result.table.dir) !== requestedSort) {
          return;
        }
        // Sorted offsets are positions in one exact snapshot. Saves that do not
        // affect the ordering may advance the local mutation revision, but the
        // response must remain between that revision and the boundary snapshot.
        const currentRevision = revisionRef.current;
        const responseMatchesUsableSnapshot =
          currentRevision !== null &&
          result.table.revision >= snapshotRevision &&
          result.table.revision <= currentRevision;
        if (sortedSnapshotDirtyRef.current || !responseMatchesUsableSnapshot) {
          await restoreDepth(currentPage, requestedAppendedPages, { staleRevisionFailure: "invalidate" });
          return;
        }
      } else {
        let shouldRestoreDepth = false;
        result = await readWithStaleRevisionRetries(
          () =>
            api<{ table: TableData }>(`/api/tables/${page.id}?${params}`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          async (candidate) => {
            // Loaded-row cell edits do not disturb a keyset cursor; only additions
            // and removals need to settle before validating this response.
            await rowOrderMutationQueueRef.current;
            if (!canAppend() || tableSortKey(candidate.table.sort, candidate.table.dir) !== requestedSort) {
              return "cancel";
            }
            if (unsortedSnapshotDirtyRef.current) {
              shouldRestoreDepth = true;
              return "cancel";
            }
            return candidate.table.revision < snapshotRevision ? "retry" : "accept";
          },
          canAppend,
        );
        if (shouldRestoreDepth && canAppend()) {
          await restoreDepth(currentPage, requestedAppendedPages, { staleRevisionFailure: "invalidate" });
          return;
        }
      }
      if (!result || !canAppend()) return;
      appendedPagesRef.current += 1;
      pageSnapshotRevisionRef.current = result.table.revision;
      if (revisionRecoveryPendingRef.current) {
        deferRevisionRecovery(currentRevisionFloor(result.table.revision), currentPage, appendedPagesRef.current);
      }
      setTable((current) => {
        if (!current || tableSortKey(current.sort, current.dir) !== requestedSort) {
          return current;
        }
        const loaded = new Set(current.rows.map((row) => row.id));
        return {
          ...current,
          rows: [...current.rows, ...result.table.rows.filter((row) => !loaded.has(row.id))],
          hasMore: result.table.hasMore,
          nextCursor: result.table.nextCursor,
          nextOffset: result.table.nextOffset,
          truncated: result.table.truncated,
        };
      });
    } catch (cause) {
      const recoveryFloor = currentRevisionFloor(snapshotRevision, currentPage.revision);
      if (cause instanceof StaleTableRevisionError && isCurrent()) {
        await restoreDepth(currentPage, requestedAppendedPages, { staleRevisionFailure: "keep-current" });
        return;
      }
      const invalidSortRecovery = recoverInvalidSort(cause, generation, isCurrent, recoveryFloor);
      if (invalidSortRecovery) {
        await load(isMounted, {
          minimumRevision: invalidSortRecovery.minimumRevision,
          staleRevisionFailure: INVALID_SORT_STALE_REVISION_FAILURE,
        });
        return;
      }
      // Pagination can be the request that discovers the page is gone, and its
      // rejection is swallowed by the click handler; latch the terminal state here
      // under the same currency rule as load.
      if (mountedRef.current && generation === loadGenerationRef.current && isPageUnavailableError(cause)) {
        markPageUnavailable(cause.message);
      }
      throw cause;
    } finally {
      changeLoadCount(-1, false);
    }
  }

  const sortKey = tableSortKey(sortColumn, sortDir);
  useEffect(() => {
    if (appliedSortKeyRef.current === sortKey) return;
    appliedSortKeyRef.current = sortKey;
    void load(isMounted).catch(() => undefined);
  }, [isMounted, load, sortKey]);

  const attemptRevisionRecovery = useCallback(
    async ({
      minimumRevision = null,
      ownerIsCurrent = isMounted,
      background = false,
      onFailure,
    }: RevisionRecoveryOptions = {}): Promise<TableLoadOutcome> => {
      const activeSort = tableSortKey(sortRef.current.column, sortRef.current.dir);
      const pendingTarget = revisionRecoveryTargetRef.current;
      const currentPage =
        pendingTarget?.sortKey === activeSort ? (pendingTarget.page ?? tableRef.current) : tableRef.current;
      const appendedPageTarget =
        pendingTarget?.sortKey === activeSort ? pendingTarget.appendedPageTarget : appendedPagesRef.current;
      const recoveryFloor = currentRevisionFloor(minimumRevision, currentPage?.revision);
      preserveRevisionFloor(recoveryFloor);
      const canRestoreCurrentDepth = currentPage && tableSortKey(currentPage.sort, currentPage.dir) === activeSort;
      if (background && canRestoreCurrentDepth) {
        // Every background revision-recovery poll is one bounded depth probe. Its
        // outer scheduler owns retries and backoff.
        return restoreDepthNow(currentPage, appendedPageTarget, recoveryFloor, {
          ownerIsCurrent,
          background: true,
          onFailure,
          staleRevisionFailure: "keep-current",
          preserveDepthOnChurn: true,
          retryStaleRevision: false,
        });
      }
      let pendingLoad = load(ownerIsCurrent, {
        background,
        minimumRevision: recoveryFloor,
        onFailure,
        staleRevisionFailure: background ? "keep-current" : "throw",
        retryStaleRevision: !background,
      });
      let recoveryLoadGeneration = loadGenerationRef.current;
      let outcome = await pendingLoad;
      // A foreground sort change can supersede this request before its replacement
      // finishes. Own one final page-one load for the live sort. Background polls
      // return the supersession outcome so their scheduler can retry promptly.
      if (outcome === "superseded" && revisionRef.current === null && ownerIsCurrent() && !background) {
        pendingLoad = load(ownerIsCurrent, {
          minimumRevision: recoveryFloor,
          onFailure,
          staleRevisionFailure: "throw",
        });
        recoveryLoadGeneration = loadGenerationRef.current;
        outcome = await pendingLoad;
      }
      if (
        !background &&
        outcome === "adopted" &&
        authoritativeLoadGenerationRef.current === recoveryLoadGeneration &&
        canRestoreCurrentDepth &&
        appendedPageTarget > 0 &&
        revisionRef.current !== null &&
        ownerIsCurrent() &&
        tableSortKey(currentPage.sort, currentPage.dir) === tableSortKey(sortRef.current.column, sortRef.current.dir)
      ) {
        // Keep the rebuild outside mutationQueue so later edits are not blocked.
        // The mutation completion path wakes polling as soon as the queue drains.
        deferRevisionRecovery(recoveryFloor, currentPage, appendedPageTarget);
        revisionRecoveryWakePendingRef.current = true;
      }
      return outcome;
    },
    [currentRevisionFloor, deferRevisionRecovery, isMounted, load, preserveRevisionFloor, restoreDepthNow],
  );

  const recoverRevision = useCallback(
    async (options: RevisionRecoveryOptions = {}) => {
      if (revisionRef.current !== null) return true;
      try {
        await attemptRevisionRecovery(options);
        return revisionRef.current !== null;
      } catch {
        return false;
      }
    },
    [attemptRevisionRecovery],
  );

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
    function renewLease(token: string, minimumGeneration = 0): Promise<boolean> {
      const current = leaseRenewalRef.current;
      if (current?.token === token) {
        if (current.generation >= minimumGeneration) return current.promise;
        return current.promise
          .catch(() => false)
          .then(() => (leaseTokenRef.current === token ? renewLease(token, minimumGeneration) : false));
      }
      const requestedAt = leaseClock();
      const generation = ++leaseRenewalGenerationRef.current;
      const attempt = api<TableLeaseTiming>(`/api/tables/${page.id}/lease`, {
        method: "PATCH",
        body: json({ leaseToken: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).then(
        (result) => {
          assertLeaseTiming(result);
          if (leaseTokenRef.current !== token) return false;
          setLocalLeaseDeadline(requestedAt, result.leaseDurationMs);
          return true;
        },
        (cause: unknown) => {
          // Renewal is the only request an idle editor keeps making, so it is
          // usually where an archived table is first noticed. Clearing the
          // lease here turns every caller's lease-ending fallback into a no-op.
          if (isPageUnavailableError(cause)) markPageUnavailable(cause.message);
          throw cause;
        },
      );
      const tracked = { token, generation, promise: Promise.resolve(false) };
      tracked.promise = attempt.finally(() => {
        if (leaseRenewalRef.current === tracked) leaseRenewalRef.current = null;
      });
      leaseRenewalRef.current = tracked;
      return tracked.promise;
    },
    [markPageUnavailable, page.id, setLocalLeaseDeadline],
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
    async (isCurrent: IsCurrent, priorLoad?: Promise<unknown>) => {
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
        if (isPageUnavailableError(cause)) {
          markPageUnavailable(cause.message);
          return;
        }
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
    [
      canEdit,
      clearLocalLease,
      ensureLeaseUsable,
      invalidateRevision,
      load,
      markPageUnavailable,
      page.id,
      setLocalLeaseDeadline,
    ],
  );

  const acquire = useCallback(
    (isCurrent: IsCurrent, priorLoad?: Promise<unknown>) => {
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

  const revisionPollMode: RevisionPollMode = terminalPageUnavailable
    ? "off"
    : revisionRecoveryPending || !revisionKnown
      ? "recovery"
      : leaseToken && tableLoaded
        ? "off"
        : "refresh";

  // Keep one scheduler alive across the recovery state transitions caused by its
  // own requests. A small mode effect below starts and stops it without discarding
  // backoff or an in-flight attempt's accounting.
  useEffect(() => {
    revisionPollModeRef.current = revisionPollMode;
    configureRevisionPollingRef.current(revisionPollMode);
  }, [revisionPollMode]);

  useEffect(() => {
    let active = true;
    let mode: RevisionPollMode = "off";
    let pollTimer: number | undefined;
    let pollRunning = false;
    let wakeAfterRunning = false;
    let delayedFailures = 0;
    let consecutiveRecoveryErrors = 0;
    const isCurrent = () => active && mode !== "off" && mountedRef.current;
    const recoveryIsActive = () => revisionRecoveryPendingRef.current || revisionRef.current === null;
    const resetFailureState = () => {
      delayedFailures = 0;
      consecutiveRecoveryErrors = 0;
      if (mountedRef.current) setRevisionRecoveryError(null);
    };
    const clearPollTimer = () => {
      if (pollTimer === undefined) return;
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
    };
    const armPoll = (delay: number) => {
      if (!active || mode === "off") return;
      clearPollTimer();
      pollTimer = window.setTimeout(() => {
        pollTimer = undefined;
        void poll();
      }, delay);
    };
    const schedulePoll = () =>
      armPoll(
        recoveryIsActive()
          ? Math.min(REVISION_POLL_INTERVAL_MS * 2 ** delayedFailures, REVISION_POLL_MAX_BACKOFF_MS)
          : REVISION_POLL_INTERVAL_MS,
      );
    async function poll() {
      if (!isCurrent()) return;
      if (loadsInFlightRef.current || pendingMutationsRef.current) {
        // A requested wake stays prompt while another foreground operation owns
        // the load slot. Its completion also calls wakePoll through changeLoadCount.
        if (revisionRecoveryWakePendingRef.current) armPoll(REVISION_POLL_INTERVAL_MS);
        else schedulePoll();
        return;
      }
      pollRunning = true;
      revisionRecoveryWakePendingRef.current = false;
      const recoveryWasActive = recoveryIsActive();
      const mutationGeneration = mutationGenerationRef.current;
      const pollRequestIsCurrent = () => isCurrent() && mutationGeneration === mutationGenerationRef.current;
      let delayedOutcome: TableLoadOutcome | null = null;
      let recoveryError: unknown = null;
      const recordFailure = (cause: unknown) => {
        recoveryError ??= cause;
      };
      try {
        if (recoveryWasActive) {
          delayedOutcome = await attemptRevisionRecovery({
            ownerIsCurrent: isCurrent,
            background: true,
            onFailure: recordFailure,
          });
        } else if (!appendedPagesRef.current) {
          delayedOutcome = await load(isCurrent, {
            background: true,
            onFailure: recordFailure,
            staleRevisionFailure: "keep-current",
          });
        }
      } catch (cause) {
        recordFailure(cause);
        delayedOutcome = pollRequestIsCurrent() ? "retry" : "superseded";
      }
      if (!active || mode === "off") {
        pollRunning = false;
        return;
      }
      if (recoveryIsActive()) {
        // Superseded data is harmless, but a request that rejected before being
        // superseded still contributes to transport backoff and error reporting.
        delayedFailures =
          !recoveryWasActive || delayedOutcome === "adopted"
            ? 0
            : recoveryError || delayedOutcome !== "superseded"
              ? Math.min(delayedFailures + 1, 4)
              : 0;
        if (recoveryWasActive && delayedOutcome !== "adopted" && recoveryError && revisionRecoveryPendingRef.current) {
          consecutiveRecoveryErrors += 1;
          if (consecutiveRecoveryErrors >= REVISION_RECOVERY_ERROR_THRESHOLD) {
            setRevisionRecoveryError(errorMessage(recoveryError, DEPTH_RESTORE_MESSAGE));
          }
        } else if (delayedOutcome !== "superseded") {
          consecutiveRecoveryErrors = 0;
          setRevisionRecoveryError(null);
        }
      } else {
        resetFailureState();
      }
      pollRunning = false;
      if (wakeAfterRunning) {
        wakeAfterRunning = false;
        armPoll(0);
      } else {
        schedulePoll();
      }
    }
    const wakePoll = () => {
      if (!active || mode === "off") return;
      revisionRecoveryWakePendingRef.current = true;
      if (pollRunning) wakeAfterRunning = true;
      else armPoll(0);
    };
    const configurePoll = (nextMode: RevisionPollMode) => {
      if (!active || mode === nextMode) return;
      const previousMode = mode;
      mode = nextMode;
      if (mode === "off") {
        clearPollTimer();
        wakeAfterRunning = false;
        revisionRecoveryWakePendingRef.current = false;
        resetFailureState();
        return;
      }
      if (previousMode === "recovery" && mode !== "recovery") {
        resetFailureState();
        clearPollTimer();
      }
      if (pollRunning || pollTimer !== undefined) return;
      if (revisionRecoveryWakePendingRef.current && !pendingMutationsRef.current) wakePoll();
      else schedulePoll();
    };
    wakeRevisionRecoveryRef.current = wakePoll;
    configureRevisionPollingRef.current = configurePoll;
    configurePoll(revisionPollModeRef.current);
    return () => {
      active = false;
      if (wakeRevisionRecoveryRef.current === wakePoll) {
        wakeRevisionRecoveryRef.current = () => undefined;
      }
      if (configureRevisionPollingRef.current === configurePoll) {
        configureRevisionPollingRef.current = () => undefined;
      }
      clearPollTimer();
    };
  }, [attemptRevisionRecovery, load]);

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
    { resetKey, affectsSortedOrder }: MutationOptions,
  ) {
    mutationGenerationRef.current += 1;
    pendingMutationsRef.current += 1;
    const execute = async () => {
      const failForLostLease = () => {
        // Once the page itself is gone the missing lease is not news: the
        // page-unavailable notice already explains why edits stopped, and the
        // draft stays visible in its disabled input.
        if (pageUnavailableRef.current) return null;
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
        if (leaseTokenRef.current !== currentLease) return failForLostLease();
        const currentRevision = revisionRef.current;
        // Invalidated while the lease was being verified: recover it at the
        // top of the loop rather than failing without a reload attempt.
        if (currentRevision === null) continue;
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
          if (
            sortRef.current.column &&
            (affectsSortedOrder === true || affectsSortedOrder === sortRef.current.column)
          ) {
            sortedSnapshotDirtyRef.current = true;
          }
          if (affectsSortedOrder === true) unsortedSnapshotDirtyRef.current = true;
          setSaveError(null);
          setTable((current) => (current ? { ...current, revision: result.revision } : current));
          return result;
        } catch (cause) {
          if (!isMounted()) return null;
          // Terminal whichever lease the request carried, so it outranks the
          // lease-identity check: a 404 that lands after the local lease
          // expired must still stop polling instead of reading as lease loss.
          if (isPageUnavailableError(cause)) {
            markPageUnavailable(cause.message);
            return null;
          }
          if (leaseTokenRef.current !== currentLease) {
            return failForLostLease();
          }
          if (cause instanceof ApiClientError && cause.code === "table_revision_conflict") {
            invalidateRevision();
            const terminalConflict = revisionConflictRetried;
            if (terminalConflict) resetCellInputAfterLoad(resetKey);
            else setSaveError(cause.message);
            const recovered = await recoverRevision({
              minimumRevision: currentRevision,
            });
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
            setSaveError(LEASE_LOST_SAVE_MESSAGE);
            return null;
          }
          if (cause instanceof ApiClientError && cause.status === 404) {
            invalidateRevision();
            setSaveError(cause.message);
            resetCellInputAfterLoad(resetKey);
            await recoverRevision({ minimumRevision: currentRevision });
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
          await recoverRevision({ minimumRevision: currentRevision });
          return null;
        }
      }
      return failForLostLease();
    };
    const pending = mutationQueue.current.then(execute, execute);
    const tracked = pending.finally(() => {
      pendingMutationsRef.current -= 1;
      if (
        !pendingMutationsRef.current &&
        revisionRecoveryPendingRef.current &&
        revisionRecoveryWakePendingRef.current
      ) {
        wakeRevisionRecoveryRef.current();
      }
    });
    mutationQueue.current = tracked.then(
      () => undefined,
      () => undefined,
    );
    if (affectsSortedOrder === true) rowOrderMutationQueueRef.current = mutationQueue.current;
    return tracked;
  }

  async function addColumn() {
    if (!table) return;
    const name = prompt("Column name", "Property")?.trim();
    if (!name) return;
    const type = (prompt("Type: text, number, checkbox, date, or select", "text") ?? "") as ColumnType;
    if (!["text", "number", "checkbox", "date", "select"].includes(type)) return;
    const result = await mutation<{ column: TableColumn }>(
      `/api/tables/${page.id}/columns`,
      "POST",
      { name, type },
      { affectsSortedOrder: false },
    );
    if (result) {
      setTable((current) =>
        current ? { ...current, columns: [...current.columns, { ...result.column, options: [] }] } : current,
      );
    }
  }

  async function removeColumn(column: TableColumn) {
    if (!confirm(`Delete “${column.name}” and every value in it?`)) return;
    const result = await mutation(
      `/api/tables/${page.id}/columns/${column.id}`,
      "DELETE",
      {},
      { affectsSortedOrder: column.id },
    );
    if (result) {
      const suffix = `:${column.id}`;
      forgetCellInputs((key) => key.endsWith(suffix));
      if (sortRef.current.column === column.id) clearSort();
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
      { affectsSortedOrder: false },
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
    const result = await mutation<{ row: TableRow }>(
      `/api/tables/${page.id}/rows`,
      "POST",
      {},
      { affectsSortedOrder: true },
    );
    if (result) setTable((current) => (current ? { ...current, rows: [...current.rows, result.row] } : current));
  }

  async function removeRow(row: TableRow) {
    const result = await mutation(`/api/tables/${page.id}/rows/${row.id}`, "DELETE", {}, { affectsSortedOrder: true });
    if (result) {
      const prefix = `${row.id}:`;
      forgetCellInputs((key) => key.startsWith(prefix));
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
      { resetKey: cellInputKey(rowId, columnId), affectsSortedOrder: columnId },
    );
    if (!result) return false;
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
    return true;
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
    // Sorting is the server's job now, so the rows arrive already ordered. The filter
    // stays local, which is why it is labelled as covering loaded rows only.
    return rows;
  }, [filter, table]);
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
        {!terminalPageUnavailable && !leaseToken && canEdit && (
          <button className="quiet-button" disabled={leasePending} onClick={() => void tryAcquire()}>
            Try edit lock
          </button>
        )}
        {member.role === "owner" && !terminalPageUnavailable && !leaseToken && (
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
      {revisionRecoveryPending && <div className="notice">{STALE_REFRESH_MESSAGE}</div>}
      {revisionRecoveryError && <div className="notice notice-danger">{revisionRecoveryError}</div>}
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
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter loaded rows…" />
          <span>
            {visibleRows.length} / {table?.rowCount ?? table?.rows.length ?? 0} rows
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
                        onClick={() => {
                          if (sortColumn !== column.id) {
                            requestSort(column.id, "asc");
                          } else if (sortDir === "asc") {
                            requestSort(column.id, "desc");
                          } else clearSort();
                        }}
                      >
                        {column.name} <small>{column.type}</small>
                        {sortColumn === column.id ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
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
                          onCommit={(value) => setCell(row.id, column.id, value)}
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
            {table.hasMore && (table.nextCursor || table.nextOffset !== null) && (
              <button
                className="load-more"
                disabled={tableBusy || !revisionKnown}
                onClick={() => void loadMore(table).catch(() => undefined)}
              >
                Load more rows
              </button>
            )}
            {table.truncated && (
              <output className="table-limit-notice">
                Showing the first {TABLE_SORT_MAX_OFFSET.toLocaleString("en-US")} sorted rows. Clear the sort to browse
                the rest.
              </output>
            )}
            {editingReady && (
              <button
                className="add-row"
                onClick={() => void addRow()}
                disabled={(table.rowCount ?? table.rows.length) >= TABLE_MAX_ROWS}
              >
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
  onCommit: (value: string | number | boolean | null) => Promise<boolean>;
}) {
  if (column.type === "checkbox") {
    return (
      <input
        aria-label={column.name}
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(event) => void onCommit(event.target.checked)}
      />
    );
  }
  if (column.type === "select") {
    return (
      <select
        aria-label={column.name}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(event) => void onCommit(event.target.value || null)}
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
  return <DraftCellInput column={column} value={value} disabled={disabled} onCommit={onCommit} />;
}

function DraftCellInput({
  column,
  value,
  disabled,
  onCommit,
}: {
  column: TableColumn;
  value: string | number | boolean | null;
  disabled: boolean;
  onCommit: (value: string | number | boolean | null) => Promise<boolean>;
}) {
  const normalizedValue = normalizedInputValue(column, value);
  const lastEnqueuedValue = useRef(normalizedValue);
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
          void onCommit(nextValue).then((committed) => {
            if (!committed && Object.is(lastEnqueuedValue.current, nextValue)) {
              lastEnqueuedValue.current = normalizedValue;
            }
          });
        }
      }}
    />
  );
}
