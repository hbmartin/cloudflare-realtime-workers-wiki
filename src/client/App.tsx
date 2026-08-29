import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ClientMemberContext } from "../shared/types";
import { buildTree } from "../shared/tree-model";
import type { MentionInboxItem, Page, PageKind, PageNode, Role, WorkspaceEvent } from "../shared/types";
import { isPage } from "../shared/validation";
import {
  ApiClientError,
  api,
  apiErrorMessage,
  authClient,
  isPageNotFoundError,
  isSuccessfulJsonResponseBodyError,
  json,
  onApiUnauthorized,
  SuccessfulApiResponseError,
} from "./api";
import { createWorkspaceEvents } from "./collaboration";
import { EditorPage } from "./EditorPage";
import { errorMessageKey } from "./error-messages";
import { invalidatePagePreview, PAGE_NAVIGATE_EVENT } from "./mentions";
import {
  authoritativePageSnapshot,
  mergePages,
  mergePageSnapshot,
  PageLoadEventBuffer,
  PageRemovalTombstones,
} from "./page-state";
import { TablePage } from "./TablePage";

type AppState =
  | { screen: "loading" }
  | { screen: "bootstrap" }
  | { screen: "signin"; message?: string }
  | { screen: "invite"; token: string }
  | { screen: "workspace"; member: ClientMemberContext };

type WorkspaceErrorSource = "archive" | "mentions" | "page-access" | "page-tree" | "trash-load" | "trash-mutation";
type ScopedWorkspaceErrorSource = "archive" | "trash-mutation";
type UnscopedWorkspaceErrorSource = Exclude<WorkspaceErrorSource, ScopedWorkspaceErrorSource>;
type WorkspaceErrorTarget =
  | { source: ScopedWorkspaceErrorSource; scope: string }
  | { source: UnscopedWorkspaceErrorSource; scope?: undefined };
type WorkspaceError =
  | { source: ScopedWorkspaceErrorSource; message: string; scope: string }
  | {
      source: UnscopedWorkspaceErrorSource;
      message: string;
      scope: undefined;
    };
type WorkspaceErrorAttempt = WorkspaceErrorTarget & { generation: number };

function workspaceErrorAttemptKey(target: WorkspaceErrorTarget) {
  return `${target.source}\u0000${target.scope ?? ""}`;
}

function updateWorkspaceErrors(current: WorkspaceError[], target: WorkspaceErrorTarget, message: string) {
  const next = message.trim();
  if (!next) return current;
  const key = errorMessageKey(next);
  if (
    current.some(
      (existing) =>
        existing.source === target.source &&
        existing.scope === target.scope &&
        errorMessageKey(existing.message) === key,
    )
  ) {
    return current;
  }
  const retained =
    target.scope === undefined
      ? target.source === "page-access"
        ? current
        : current.filter((error) => error.source !== target.source)
      : current.filter((error) => error.source !== target.source || error.scope !== target.scope);
  if (target.source === "archive" || target.source === "trash-mutation") {
    return [...retained, { source: target.source, message: next, scope: target.scope }];
  }
  return [...retained, { source: target.source, message: next, scope: undefined }];
}

function formatErrorMessages(errors: WorkspaceError[]) {
  const messages = new Map<string, string>();
  for (const { message } of errors) {
    const key = errorMessageKey(message);
    if (!messages.has(key)) messages.set(key, /[.!?…]$/.test(message) ? message : `${message}.`);
  }
  return [...messages.values()].join(" ");
}

function archivePageIds(value: unknown, rootPageId: string) {
  const pageIds =
    value !== null && typeof value === "object" && "pageIds" in value ? (value as { pageIds?: unknown }).pageIds : null;
  if (!Array.isArray(pageIds) || !pageIds.every((pageId) => typeof pageId === "string" && pageId.length > 0)) {
    return null;
  }
  const uniquePageIds = [...new Set(pageIds)];
  return uniquePageIds.includes(rootPageId) ? uniquePageIds : null;
}

function restoreResponsePages(value: unknown, rootPageId: string, workspaceId: string) {
  const pages =
    value !== null && typeof value === "object" && "pages" in value ? (value as { pages?: unknown }).pages : null;
  if (!Array.isArray(pages) || !pages.every(isPage)) return null;
  const pageIds = new Set(pages.map((page) => page.id));
  if (
    pageIds.size !== pages.length ||
    !pageIds.has(rootPageId) ||
    pages.some((page) => page.workspaceId !== workspaceId || page.archivedAt !== null)
  ) {
    return null;
  }
  return pages;
}

type MutationRequestResult<T> =
  | { kind: "committed"; value: T | null }
  | { kind: "rejected"; error: ApiClientError }
  | { kind: "uncertain"; error: unknown };

async function requestMutation<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T | null,
): Promise<MutationRequestResult<T>> {
  let value: unknown;
  try {
    value = await api<unknown>(path, init);
  } catch (error) {
    if (isSuccessfulJsonResponseBodyError(error)) return { kind: "committed", value: null };
    return error instanceof ApiClientError && error.status >= 400 && error.status < 500
      ? { kind: "rejected", error }
      : { kind: "uncertain", error };
  }
  try {
    return { kind: "committed", value: parse(value) };
  } catch (error) {
    console.error("Successful mutation response could not be validated", {
      requestPath: path,
      method: init.method ?? "GET",
      error,
    });
    return { kind: "committed", value: null };
  }
}

function requestPageRestore(rootPageId: string, workspaceId: string) {
  return requestMutation(`/api/pages/${rootPageId}/restore`, { method: "POST" }, (value) =>
    restoreResponsePages(value, rootPageId, workspaceId),
  );
}

function pageSubtreeIds(pages: Page[], rootPageId: string) {
  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const siblings = children.get(page.parentId) ?? [];
    siblings.push(page.id);
    children.set(page.parentId, siblings);
  }
  const pageIds: string[] = [];
  const seen = new Set<string>();
  const pending = [rootPageId];
  while (pending.length) {
    const pageId = pending.pop()!;
    if (seen.has(pageId)) continue;
    seen.add(pageId);
    pageIds.push(pageId);
    pending.push(...(children.get(pageId) ?? []));
  }
  return pageIds;
}

async function resolveAppState(): Promise<AppState> {
  const invite = new URLSearchParams(window.location.search).get("invite");
  if (invite) return { screen: "invite", token: invite };
  const install = await api<{ initialized: boolean }>("/api/install");
  if (!install.initialized) return { screen: "bootstrap" };
  try {
    const member = await api<ClientMemberContext>("/api/me");
    return { screen: "workspace", member };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return { screen: "signin" };
    throw error;
  }
}

export function App() {
  const [state, setState] = useState<AppState>({ screen: "loading" });
  const signOut = useCallback(() => setState({ screen: "signin" }), []);
  const sessionExpired = useCallback((error: ApiClientError) => {
    setState((current) =>
      current.screen === "workspace"
        ? { screen: "signin", message: apiErrorMessage(error, "Your session expired. Sign in again.") }
        : current,
    );
  }, []);

  const load = useCallback(() => resolveAppState().then(setState), []);

  useEffect(() => onApiUnauthorized(sessionExpired), [sessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.screen === "loading") return <Splash />;
  if (state.screen === "bootstrap") return <BootstrapScreen onComplete={load} />;
  if (state.screen === "invite")
    return (
      <InviteScreen
        token={state.token}
        onComplete={() => {
          history.replaceState(null, "", "/");
          void load();
        }}
      />
    );
  if (state.screen === "signin") return <SignInScreen onComplete={load} initialError={state.message} />;
  return <Workspace member={state.member} onSignOut={signOut} />;
}

function Splash() {
  return (
    <div className="splash">
      <div className="brand-mark">N</div>
      <p>Opening Notes…</p>
    </div>
  );
}

function AuthLayout({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand">
          <span className="brand-mark">N</span> Notes
        </div>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{copy}</p>
        </div>
        <p className="auth-footnote">Realtime and offline-first. Your data stays in your Cloudflare account.</p>
      </section>
      <section className="auth-card">{children}</section>
    </main>
  );
}

function BootstrapScreen({ onComplete }: { onComplete: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      await api("/api/install/bootstrap", { method: "POST", body: json(Object.fromEntries(values)) });
      await onComplete();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Setup failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      eyebrow="First-run setup"
      title="Make a home for your team’s knowledge."
      copy="Create the owner account and one private workspace. New members can only join with an invite."
    >
      <form className="auth-form" onSubmit={submit}>
        <h2>Set up Notes</h2>
        <label>
          Workspace name
          <input name="workspaceName" required maxLength={100} autoFocus />
        </label>
        <label>
          Your name
          <input name="name" required maxLength={100} />
        </label>
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={8} />
        </label>
        <label>
          Bootstrap token
          <input name="bootstrapToken" type="password" required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "Creating workspace…" : "Create workspace"}
        </button>
      </form>
    </AuthLayout>
  );
}

function InviteScreen({ token, onComplete }: { token: string; onComplete: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/invites/accept", {
        method: "POST",
        body: json({ ...Object.fromEntries(new FormData(event.currentTarget)), token }),
      });
      onComplete();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invite could not be accepted."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      eyebrow="You’re invited"
      title="Step into the shared notebook."
      copy="Your role is already set by the workspace owner. Create an account to begin."
    >
      <form className="auth-form" onSubmit={submit}>
        <h2>Join workspace</h2>
        <label>
          Your name
          <input name="name" required autoFocus />
        </label>
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" minLength={8} required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "Joining…" : "Accept invite"}
        </button>
      </form>
    </AuthLayout>
  );
}

function SignInScreen({ onComplete, initialError = "" }: { onComplete: () => Promise<void>; initialError?: string }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget)) as { email: string; password: string };
    try {
      const result = await authClient.signIn.email(values);
      if (result.error) {
        setError(result.error.message?.trim() || "Sign in failed.");
        return;
      }
      await onComplete();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Sign in failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      eyebrow="Private workspace"
      title="Pick up where your team left off."
      copy="Documents sync in realtime, remain available offline, and persist on Cloudflare’s edge."
    >
      <form className="auth-form" onSubmit={submit}>
        <h2>Sign in</h2>
        <label>
          Email
          <input name="email" type="email" required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </AuthLayout>
  );
}

function Workspace({ member, onSignOut }: { member: ClientMemberContext; onSignOut: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [trash, setTrash] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem("notes:last-page"));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<"pages" | "search" | "mentions" | "trash" | "settings">("pages");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ page: Page; snippet: string }>>([]);
  const [unreadMentions, setUnreadMentions] = useState(0);
  const [backlinksRevision, setBacklinksRevision] = useState(0);
  const [workspaceErrors, setWorkspaceErrors] = useState<WorkspaceError[]>([]);
  const [trashRefreshVersion, setTrashRefreshVersion] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [pendingTrashMutationIds, setPendingTrashMutationIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingPageEvents = useRef(new PageLoadEventBuffer());
  const [archiveRemovalTombstones] = useState(() => new PageRemovalTombstones());
  const pageLoadGeneration = useRef(0);
  const pageLoadPromise = useRef<Promise<{ serverPages: Page[]; removedDuringLoad: ReadonlySet<string> }> | null>(null);
  const trashLoadRequest = useRef<{
    version: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const trashMutationIdsRef = useRef(new Set<string>());
  const workspaceErrorAttemptRef = useRef(0);
  const latestWorkspaceErrorAttemptRef = useRef(new Map<string, number>());

  const isCurrentWorkspaceErrorAttempt = useCallback((attempt: WorkspaceErrorAttempt) => {
    return latestWorkspaceErrorAttemptRef.current.get(workspaceErrorAttemptKey(attempt)) === attempt.generation;
  }, []);
  const startWorkspaceErrorAttempt = useCallback((target: WorkspaceErrorTarget) => {
    const attempt = { ...target, generation: ++workspaceErrorAttemptRef.current };
    latestWorkspaceErrorAttemptRef.current.set(workspaceErrorAttemptKey(target), attempt.generation);
    return attempt;
  }, []);
  const finishWorkspaceErrorAttempt = useCallback(
    (attempt: WorkspaceErrorAttempt) => {
      if (isCurrentWorkspaceErrorAttempt(attempt)) {
        latestWorkspaceErrorAttemptRef.current.delete(workspaceErrorAttemptKey(attempt));
      }
    },
    [isCurrentWorkspaceErrorAttempt],
  );
  const reportWorkspaceError = useCallback(
    (target: WorkspaceErrorTarget | WorkspaceErrorAttempt, message: string) => {
      if ("generation" in target && !isCurrentWorkspaceErrorAttempt(target)) return;
      setWorkspaceErrors((current) => updateWorkspaceErrors(current, target, message));
    },
    [isCurrentWorkspaceErrorAttempt],
  );
  const clearWorkspaceErrors = useCallback(
    (target: WorkspaceErrorTarget | WorkspaceErrorAttempt) => {
      if ("generation" in target && !isCurrentWorkspaceErrorAttempt(target)) return;
      setWorkspaceErrors((current) => {
        const next = current.filter(
          (error) => error.source !== target.source || (target.scope !== undefined && error.scope !== target.scope),
        );
        return next.length === current.length ? current : next;
      });
    },
    [isCurrentWorkspaceErrorAttempt],
  );
  const startScopedWorkspaceErrorAttempt = useCallback(
    (source: ScopedWorkspaceErrorSource, scope: string) => {
      const attempt = startWorkspaceErrorAttempt({ source, scope });
      clearWorkspaceErrors(attempt);
      return attempt;
    },
    [clearWorkspaceErrors, startWorkspaceErrorAttempt],
  );
  const navigateToPage = useCallback(
    (pageId: string) => {
      clearWorkspaceErrors({ source: "page-access" });
      setSelectedId(pageId);
      setView("pages");
      setSidebarOpen(false);
    },
    [clearWorkspaceErrors],
  );

  const recordPageUpserts = useCallback((incoming: Page[]) => {
    pendingPageEvents.current.recordUpserts(incoming);
  }, []);
  const recordPageRemovals = useCallback((pageIds: string[]) => {
    pendingPageEvents.current.recordRemovals(pageIds);
  }, []);
  const refreshTrash = useCallback(() => {
    const pending = trashLoadRequest.current;
    if (pending) {
      trashLoadRequest.current = null;
      pending.controller.abort();
    }
    setTrashLoading(true);
    setTrashRefreshVersion((current) => current + 1);
  }, []);

  const loadPages = useCallback(() => {
    if (pageLoadPromise.current) return pageLoadPromise.current;
    const loadGeneration = ++pageLoadGeneration.current;
    pendingPageEvents.current.start();
    const loading = api<{ pages: Page[] }>("/api/pages/tree")
      .then((data) => {
        const { upserts, removals } = pendingPageEvents.current.consume();
        const observed = authoritativePageSnapshot(data.pages, upserts, removals);
        const serverPageIds = new Set(data.pages.map((page) => page.id));
        const tombstones = archiveRemovalTombstones.applyLoad(serverPageIds, loadGeneration);
        const authoritativePages = observed.pages.filter((page) => !tombstones.has(page.id));
        const authoritativeIds = new Set(authoritativePages.map((page) => page.id));
        setPages((current) => mergePageSnapshot(current, authoritativePages));
        setWorkspaceErrors((current) => {
          const next = current.filter((error) => error.source !== "archive" || observed.ids.has(error.scope));
          return next.length === current.length ? current : next;
        });
        setPagesLoaded(true);
        clearWorkspaceErrors({ source: "page-tree" });
        setSelectedId((current) =>
          current && authoritativeIds.has(current) ? current : ([...authoritativeIds][0] ?? null),
        );
        return { serverPages: data.pages, removedDuringLoad: removals };
      })
      .catch((error) => {
        pendingPageEvents.current.cancel();
        throw error;
      })
      .finally(() => {
        if (pageLoadPromise.current === loading) pageLoadPromise.current = null;
      });
    pageLoadPromise.current = loading;
    return loading;
  }, [archiveRemovalTombstones, clearWorkspaceErrors]);
  const loadTrash = useCallback(
    (version: number) => {
      const activeRequest = trashLoadRequest.current;
      if (activeRequest?.version === version) return activeRequest.promise;
      activeRequest?.controller.abort();
      const controller = new AbortController();
      const request = { version, controller, promise: Promise.resolve() };
      setTrashLoading(true);
      const loading = api<{ pages: Page[] }>("/api/pages/tree?archived=true", { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          const pageIds = new Set(data.pages.map((page) => page.id));
          setTrash(data.pages);
          setWorkspaceErrors((current) => {
            const next = current.filter((error) => error.source !== "trash-mutation" || pageIds.has(error.scope));
            return next.length === current.length ? current : next;
          });
          clearWorkspaceErrors({ source: "trash-load" });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          reportWorkspaceError({ source: "trash-load" }, apiErrorMessage(error, "Trash could not be refreshed."));
        })
        .finally(() => {
          if (trashLoadRequest.current !== request) return;
          trashLoadRequest.current = null;
          setTrashLoading(false);
        });
      request.promise = loading;
      trashLoadRequest.current = request;
      return loading;
    },
    [clearWorkspaceErrors, reportWorkspaceError],
  );
  useEffect(() => {
    if (view === "trash") void loadTrash(trashRefreshVersion);
  }, [loadTrash, trashRefreshVersion, view]);
  const loadUnreadMentions = useCallback(() => {
    const attempt = startWorkspaceErrorAttempt({ source: "mentions" });
    return api<{ unreadCount: number }>("/api/mentions/unread-count")
      .then((data) => {
        if (!isCurrentWorkspaceErrorAttempt(attempt)) return;
        setUnreadMentions(data.unreadCount);
        clearWorkspaceErrors(attempt);
      })
      .catch((error) => {
        reportWorkspaceError(attempt, apiErrorMessage(error, "Unread mentions could not be refreshed."));
      })
      .finally(() => finishWorkspaceErrorAttempt(attempt));
  }, [
    clearWorkspaceErrors,
    finishWorkspaceErrorAttempt,
    isCurrentWorkspaceErrorAttempt,
    reportWorkspaceError,
    startWorkspaceErrorAttempt,
  ]);
  const handleMentionsRead = useCallback(
    (unreadCount: number) => {
      const attempt = startWorkspaceErrorAttempt({ source: "mentions" });
      setUnreadMentions(unreadCount);
      clearWorkspaceErrors(attempt);
      finishWorkspaceErrorAttempt(attempt);
    },
    [clearWorkspaceErrors, finishWorkspaceErrorAttempt, startWorkspaceErrorAttempt],
  );
  useEffect(() => {
    void loadPages().catch((error) => {
      reportWorkspaceError({ source: "page-tree" }, apiErrorMessage(error, "The page tree could not be loaded."));
    });
  }, [loadPages, reportWorkspaceError]);
  useEffect(() => {
    void loadUnreadMentions();
  }, [loadUnreadMentions]);
  const handleWorkspaceEvent = useCallback(
    (event: WorkspaceEvent) => {
      if (event.type === "pages-upserted") {
        if (event.restored) archiveRemovalTombstones.release(event.pages.map((page) => page.id));
        recordPageUpserts(event.pages);
        for (const page of event.pages) invalidatePagePreview(page.id);
        const visiblePages = event.pages.filter((page) => !archiveRemovalTombstones.has(page.id));
        if (visiblePages.length) {
          const visiblePageIds = new Set(visiblePages.map((page) => page.id));
          setPages((current) => mergePages(current, visiblePages));
          setTrash((current) => current.filter((page) => !visiblePageIds.has(page.id)));
        }
        if (event.restored) refreshTrash();
        return;
      }
      if (event.type === "pages-removed") {
        if (event.permanently) {
          archiveRemovalTombstones.release(event.pageIds);
        } else {
          archiveRemovalTombstones.pin(event.pageIds, pageLoadGeneration.current);
        }
        recordPageRemovals(event.pageIds);
        for (const pageId of event.pageIds) invalidatePagePreview(pageId);
        const removedIds = new Set(event.pageIds);
        setPages((current) => current.filter((page) => !removedIds.has(page.id)));
        refreshTrash();
        if (event.permanently) {
          setTrash((current) => current.filter((page) => !removedIds.has(page.id)));
        }
        return;
      }
      invalidatePagePreview(event.pageId);
      setBacklinksRevision((current) => current + 1);
      if (event.mentionTargetUserIds.includes(member.user.id)) void loadUnreadMentions();
    },
    [archiveRemovalTombstones, loadUnreadMentions, member.user.id, recordPageRemovals, recordPageUpserts, refreshTrash],
  );

  useEffect(() => {
    const bundle = createWorkspaceEvents(member.workspace.id, handleWorkspaceEvent, () => {
      void loadPages().catch((error) => {
        reportWorkspaceError({ source: "page-tree" }, apiErrorMessage(error, "The page tree could not be refreshed."));
      });
      void loadUnreadMentions();
    });
    return () => bundle.destroy();
  }, [handleWorkspaceEvent, loadPages, loadUnreadMentions, member.workspace.id, reportWorkspaceError]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const pageId = (event as CustomEvent<string>).detail;
      if (!pageId) return;
      navigateToPage(pageId);
    };
    window.addEventListener(PAGE_NAVIGATE_EVENT, navigate);
    return () => window.removeEventListener(PAGE_NAVIGATE_EVENT, navigate);
  }, [navigateToPage]);

  // Render-phase adjustment, not just a display fallback: a deleted page's id left in
  // selectedId would be persisted below, and would yank the editor back to that page
  // if a collaborator later restores it from trash.
  if (pagesLoaded && selectedId && !pages.some((page) => page.id === selectedId)) {
    setSelectedId(pages[0]?.id ?? null);
  }
  const selected =
    pages.find((page) => page.id === selectedId) ?? (pagesLoaded && selectedId ? (pages[0] ?? null) : null);
  const resolvedSelectedId = selected?.id ?? selectedId;
  useEffect(() => {
    if (resolvedSelectedId) localStorage.setItem("notes:last-page", resolvedSelectedId);
  }, [resolvedSelectedId]);
  const tree = useMemo(() => buildTree(pages), [pages]);
  const breadcrumbs = useMemo(() => {
    const items: Page[] = [];
    let cursor = selected;
    while (cursor) {
      items.unshift(cursor);
      cursor = pages.find((page) => page.id === cursor?.parentId) ?? null;
    }
    return items;
  }, [pages, selected]);

  async function createPage(kind: PageKind, parentId: string | null = selected?.parentId ?? null) {
    const result = await api<{ page: Page }>("/api/pages", { method: "POST", body: json({ kind, parentId }) });
    recordPageUpserts([result.page]);
    setPages((current) => mergePages(current, [result.page]));
    navigateToPage(result.page.id);
  }
  async function archive(page: Page) {
    if (!confirm(`Move “${page.title}” and its children to trash?`)) return;
    const errorScope = page.id;
    const attempt = startScopedWorkspaceErrorAttempt("archive", errorScope);
    try {
      const knownPageIds = pageSubtreeIds(pages, page.id);
      const result = await requestMutation(`/api/pages/${page.id}`, { method: "DELETE" }, (value) =>
        archivePageIds(value, page.id),
      );
      const pageAlreadyGone = result.kind === "rejected" && isPageNotFoundError(result.error);
      const archiveWasUnverified =
        result.kind === "uncertain" || (result.kind === "committed" && result.value === null);
      const removedIds =
        result.kind === "committed"
          ? new Set(result.value ?? knownPageIds)
          : pageAlreadyGone
            ? new Set(knownPageIds)
            : null;
      if (result.kind === "committed" && result.value === null) {
        reportWorkspaceError(attempt, "The server returned an invalid archive response. Refreshing the page tree.");
      } else if (result.kind !== "committed" && !pageAlreadyGone) {
        const archiveError =
          result.error instanceof SuccessfulApiResponseError
            ? "The archive response could not be verified. Refreshing the page tree."
            : apiErrorMessage(result.error, "The page could not be archived.");
        reportWorkspaceError(attempt, archiveError);
      }
      if (removedIds) {
        archiveRemovalTombstones.pin(removedIds, pageLoadGeneration.current);
        for (const pageId of removedIds) invalidatePagePreview(pageId);
        setPages((current) => current.filter((candidate) => !removedIds.has(candidate.id)));
      } else if (result.kind === "uncertain") {
        for (const pageId of knownPageIds) invalidatePagePreview(pageId);
      }
      if (removedIds || result.kind === "uncertain") refreshTrash();
      const needsReconciliation = result.kind !== "rejected" || pageAlreadyGone;
      if (!needsReconciliation) return;
      const pendingPageLoad = pageLoadPromise.current;
      if (pendingPageLoad) await pendingPageLoad.catch(() => undefined);
      const reconciliation = loadPages();
      try {
        await reconciliation;
      } catch (error) {
        const refreshError = apiErrorMessage(error, "The page tree could not be refreshed.");
        if (archiveWasUnverified) {
          console.error("Page tree could not be refreshed after an unverified archive", error);
        }
        reportWorkspaceError({ source: "page-tree" }, refreshError);
      }
    } finally {
      finishWorkspaceErrorAttempt(attempt);
    }
  }
  async function move(
    pageId: string,
    parentId: string | null,
    beforeId: string | null = null,
    afterId: string | null = null,
  ) {
    const result = await api<{ page: Page }>(`/api/pages/${pageId}/move`, {
      method: "POST",
      body: json({ parentId, beforeId, afterId }),
    });
    recordPageUpserts([result.page]);
    setPages((current) => mergePages(current, [result.page]));
  }
  async function runSearch(value: string) {
    setSearch(value);
    if (!value.trim()) {
      setSearchResults([]);
      return;
    }
    const data = await api<{ results: Array<{ page: Page; snippet: string }> }>(
      `/api/search?q=${encodeURIComponent(value)}`,
    );
    setSearchResults(data.results);
  }
  // Under the mobile breakpoint the open drawer sits over a full-viewport scrim,
  // so navigating without closing it strands the reader behind the thing they
  // just opened. Selecting a page already closes it; these do the same.
  function showTrash() {
    setSidebarOpen(false);
    clearWorkspaceErrors({ source: "page-access" });
    refreshTrash();
    setView("trash");
  }
  function showView(next: "search" | "mentions" | "settings") {
    clearWorkspaceErrors({ source: "page-access" });
    setView(next);
    setSidebarOpen(false);
  }
  const updatePage = useCallback(
    (page: Page) => {
      recordPageUpserts([page]);
      setPages((current) => mergePages(current, [page]));
    },
    [recordPageUpserts],
  );
  const pageUnavailable = useCallback(
    (pageId: string) => {
      archiveRemovalTombstones.pin([pageId], pageLoadGeneration.current);
      const pendingPageLoad = pageLoadPromise.current;
      const reconciliation = pendingPageLoad
        ? pendingPageLoad.catch(() => undefined).then(() => loadPages())
        : loadPages();
      invalidatePagePreview(pageId);
      setPages((current) => current.filter((page) => page.id !== pageId));
      void reconciliation.catch((error) => {
        const refreshError = apiErrorMessage(error, "The page tree could not be refreshed.");
        reportWorkspaceError({ source: "page-tree" }, refreshError);
      });
    },
    [archiveRemovalTombstones, loadPages, reportWorkspaceError],
  );
  const documentAccessDenied = useCallback(
    (pageId: string, error: ApiClientError) => {
      const accessError = apiErrorMessage(error, "You no longer have access to this page.");
      reportWorkspaceError({ source: "page-access" }, accessError);
      pageUnavailable(pageId);
    },
    [pageUnavailable, reportWorkspaceError],
  );
  function beginTrashMutation(pageIds: string[]) {
    if (pageIds.some((pageId) => trashMutationIdsRef.current.has(pageId))) return false;
    for (const pageId of pageIds) trashMutationIdsRef.current.add(pageId);
    setPendingTrashMutationIds(new Set(trashMutationIdsRef.current));
    return true;
  }
  function endTrashMutation(pageIds: string[]) {
    for (const pageId of pageIds) trashMutationIdsRef.current.delete(pageId);
    setPendingTrashMutationIds(new Set(trashMutationIdsRef.current));
  }
  async function restorePage(page: Page) {
    const knownPageIds = pageSubtreeIds(trash, page.id);
    if (!beginTrashMutation(knownPageIds)) return;
    const errorScope = page.id;
    const attempt = startScopedWorkspaceErrorAttempt("trash-mutation", errorScope);
    try {
      let result: Awaited<ReturnType<typeof requestPageRestore>>;
      try {
        result = await requestPageRestore(page.id, member.workspace.id);
        if (result.kind === "committed" && result.value) {
          archiveRemovalTombstones.release(result.value.map((restored) => restored.id));
        }
        if (result.kind !== "committed") {
          reportWorkspaceError(attempt, apiErrorMessage(result.error, "The page could not be restored."));
          for (const pageId of knownPageIds) invalidatePagePreview(pageId);
        } else {
          if (!result.value) {
            reportWorkspaceError(attempt, "The server returned an invalid restore response. Refreshing pages.");
          }
          const restoredIds = new Set(result.value?.map((restored) => restored.id) ?? knownPageIds);
          if (result.value) {
            const restoredPages = result.value;
            recordPageUpserts(restoredPages);
            setPages((current) => mergePages(current, restoredPages));
          }
          for (const pageId of result.value ? restoredIds : knownPageIds) invalidatePagePreview(pageId);
          setTrash((current) => current.filter((candidate) => !restoredIds.has(candidate.id)));
        }
        refreshTrash();
      } finally {
        endTrashMutation(knownPageIds);
      }

      const responseConfirmedRestore = result.kind === "committed" && result.value !== null;
      if (result.kind === "rejected" || responseConfirmedRestore) return;

      const pendingPageLoad = pageLoadPromise.current;
      if (pendingPageLoad) await pendingPageLoad.catch(() => undefined);
      try {
        const { serverPages, removedDuringLoad } = await loadPages();
        const rootWasRestored =
          !removedDuringLoad.has(page.id) && serverPages.some((candidate) => candidate.id === page.id);
        if (rootWasRestored) {
          const serverRestoredIds = new Set(
            pageSubtreeIds(serverPages, page.id).filter((pageId) => !removedDuringLoad.has(pageId)),
          );
          archiveRemovalTombstones.release(serverRestoredIds);
          const serverRestoredPages = serverPages.filter((candidate) => serverRestoredIds.has(candidate.id));
          setPages((current) => mergePages(current, serverRestoredPages));
        }
        if (result.kind === "committed" && !result.value) {
          clearWorkspaceErrors(attempt);
        }
      } catch (error) {
        reportWorkspaceError({ source: "page-tree" }, apiErrorMessage(error, "The page tree could not be refreshed."));
      }
    } finally {
      finishWorkspaceErrorAttempt(attempt);
    }
  }
  async function permanentlyDeletePage(page: Page) {
    const knownPageIds = pageSubtreeIds(trash, page.id);
    if (knownPageIds.some((pageId) => trashMutationIdsRef.current.has(pageId))) return;
    if (!confirm(`Permanently delete “${page.title}”? This cannot be undone.`)) return;
    if (!beginTrashMutation(knownPageIds)) return;
    const errorScope = page.id;
    const attempt = startScopedWorkspaceErrorAttempt("trash-mutation", errorScope);
    try {
      const result = await requestMutation(`/api/pages/${page.id}/permanent-delete`, { method: "POST" }, (value) =>
        archivePageIds(value, page.id),
      );
      if (result.kind === "committed") {
        const deletedIds = new Set(result.value ?? knownPageIds);
        for (const pageId of deletedIds) invalidatePagePreview(pageId);
        setTrash((current) => current.filter((candidate) => !deletedIds.has(candidate.id)));
        if (!result.value) {
          reportWorkspaceError(attempt, "The server returned an invalid permanent-delete response. Refreshing trash.");
        }
      } else {
        reportWorkspaceError(attempt, apiErrorMessage(result.error, "The page could not be permanently deleted."));
      }
      refreshTrash();
    } finally {
      endTrashMutation(knownPageIds);
      finishWorkspaceErrorAttempt(attempt);
    }
  }

  const workspaceError = formatErrorMessages(workspaceErrors);
  const trashLoadFailed = workspaceErrors.some((error) => error.source === "trash-load");

  return (
    <div className="workspace-shell">
      <aside className={`workspace-sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="workspace-header">
          <span className="workspace-avatar">{member.workspace.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{member.workspace.name}</strong>
            <small>
              {member.user.name} · {member.role}
            </small>
          </div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}>
            ×
          </button>
        </header>
        <nav className="sidebar-nav">
          <button className={view === "search" ? "active" : ""} onClick={() => showView("search")}>
            <span>⌕</span> Search
          </button>
          <button className={view === "mentions" ? "active" : ""} onClick={() => showView("mentions")}>
            <span>@</span> Mentions {unreadMentions > 0 && <b className="mention-badge">{unreadMentions}</b>}
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => showView("settings")}>
            <span>⚙</span> Members
          </button>
        </nav>
        <div className="sidebar-section-title">
          <span>Pages</span>
          {member.role !== "viewer" && <button onClick={() => void createPage("document", null)}>+</button>}
        </div>
        <div
          className="tree-root"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const id = event.dataTransfer.getData("text/page-id");
            if (id) void move(id, null);
          }}
        >
          <PageTree
            nodes={tree}
            selectedId={resolvedSelectedId}
            editable={member.role !== "viewer"}
            onSelect={navigateToPage}
            onCreate={(parentId) => void createPage("document", parentId)}
            onArchive={(page) => void archive(page)}
            onDropPage={(id, parentId) => void move(id, parentId)}
            onMove={(id, parentId, beforeId, afterId) => void move(id, parentId, beforeId, afterId)}
          />
        </div>
        <button className="trash-link" onClick={showTrash}>
          ♲ Trash
        </button>
        <footer className="sidebar-footer">
          <button
            onClick={async () => {
              await authClient.signOut();
              onSignOut();
            }}
          >
            Sign out
          </button>
          <span>Cloudflare edge-native</span>
        </footer>
      </aside>

      <section className="workspace-content">
        {workspaceError && (
          <div className="form-error workspace-error" role="alert">
            <span>{workspaceError}</span>
            <button
              type="button"
              className="workspace-error-dismiss"
              aria-label="Dismiss workspace errors"
              onClick={() => setWorkspaceErrors([])}
            >
              ×
            </button>
          </div>
        )}
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          <div className="breadcrumbs">
            {breadcrumbs.map((page, index) => (
              <span key={page.id}>
                {index > 0 && <i>/</i>}
                {page.title}
              </span>
            ))}
          </div>
          {member.role !== "viewer" && (
            <div className="new-menu">
              <button className="primary-small" onClick={() => void createPage("document")}>
                + Page
              </button>
              <button className="quiet-button" onClick={() => void createPage("table")}>
                + Table
              </button>
            </div>
          )}
        </header>

        {view === "search" ? (
          <SearchView value={search} results={searchResults} onChange={runSearch} onSelect={navigateToPage} />
        ) : view === "mentions" ? (
          <MentionsView onSelect={navigateToPage} onRead={handleMentionsRead} />
        ) : view === "trash" ? (
          <TrashView
            pages={trash}
            owner={member.role === "owner"}
            loading={trashLoading}
            loadFailed={trashLoadFailed}
            pendingPageIds={pendingTrashMutationIds}
            onRestore={restorePage}
            onDelete={permanentlyDeletePage}
          />
        ) : view === "settings" ? (
          <MembersView member={member} />
        ) : selected ? (
          selected.kind === "document" ? (
            <EditorPage
              key={`${selected.id}:${selected.contentEpoch}`}
              page={selected}
              member={member}
              onPageChanged={updatePage}
              onPageUnavailable={pageUnavailable}
              onAccessDenied={documentAccessDenied}
              onSelectPage={navigateToPage}
              backlinksRevision={backlinksRevision}
            />
          ) : (
            <TablePage
              key={selected.id}
              page={selected}
              member={member}
              onPageChanged={updatePage}
              onPageUnavailable={pageUnavailable}
              onSelectPage={navigateToPage}
              backlinksRevision={backlinksRevision}
            />
          )
        ) : (
          <EmptyWorkspace canEdit={member.role !== "viewer"} onCreate={() => void createPage("document", null)} />
        )}
      </section>
      {sidebarOpen && (
        <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />
      )}
    </div>
  );
}

function PageTree({
  nodes,
  selectedId,
  editable,
  onSelect,
  onCreate,
  onArchive,
  onDropPage,
  onMove,
  grandparentId = null,
}: {
  nodes: PageNode[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onCreate: (parentId: string) => void;
  onArchive: (page: Page) => void;
  onDropPage: (id: string, parentId: string) => void;
  onMove: (id: string, parentId: string | null, beforeId: string | null, afterId: string | null) => void;
  grandparentId?: string | null;
}) {
  return nodes.map((node, index) => (
    <div className="tree-branch" key={node.id}>
      <div
        className={`tree-row ${selectedId === node.id ? "selected" : ""}`}
        draggable={editable}
        onDragStart={(event) => event.dataTransfer.setData("text/page-id", node.id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.stopPropagation();
          const id = event.dataTransfer.getData("text/page-id");
          if (id && id !== node.id) onDropPage(id, node.id);
        }}
      >
        <button
          className="page-link"
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            if (event.key === "ArrowUp" && index > 0) {
              event.preventDefault();
              onMove(node.id, node.parentId, nodes[index - 1]!.id, index > 1 ? nodes[index - 2]!.id : null);
            } else if (event.key === "ArrowDown" && index < nodes.length - 1) {
              event.preventDefault();
              onMove(
                node.id,
                node.parentId,
                index + 2 < nodes.length ? nodes[index + 2]!.id : null,
                nodes[index + 1]!.id,
              );
            } else if (event.key === "ArrowRight" && index > 0) {
              event.preventDefault();
              onMove(node.id, nodes[index - 1]!.id, null, null);
            } else if (event.key === "ArrowLeft" && node.parentId) {
              event.preventDefault();
              onMove(node.id, grandparentId, null, null);
            }
          }}
          title="Alt+arrow keys move this page"
        >
          <span>{node.icon ?? (node.kind === "table" ? "▦" : "□")}</span>
          <span>{node.title}</span>
        </button>
        {editable && (
          <div className="tree-actions">
            <button onClick={() => onCreate(node.id)} aria-label={`Add child to ${node.title}`}>
              +
            </button>
            <button onClick={() => onArchive(node)} aria-label={`Archive ${node.title}`}>
              •••
            </button>
          </div>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="tree-children">
          <PageTree
            {...{ nodes: node.children, selectedId, editable, onSelect, onCreate, onArchive, onDropPage, onMove }}
            grandparentId={node.parentId}
          />
        </div>
      )}
    </div>
  ));
}

function SearchView({
  value,
  results,
  onChange,
  onSelect,
}: {
  value: string;
  results: Array<{ page: Page; snippet: string }>;
  onChange: (value: string) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  return (
    <main className="utility-view">
      <p className="eyebrow">Workspace search</p>
      <h1>Find anything</h1>
      <input
        className="search-input"
        value={value}
        onChange={(event) => void onChange(event.target.value)}
        placeholder="Search titles and documents…"
        autoFocus
      />
      <div className="search-results">
        {results.map(({ page, snippet }) => (
          <button key={page.id} onClick={() => onSelect(page.id)}>
            <strong>{page.title}</strong>
            <span>{snippet.replace(/<\/?mark>/g, "")}</span>
          </button>
        ))}
        {value && !results.length && <p className="empty-copy">No matching pages.</p>}
      </div>
    </main>
  );
}

type MentionPageResponse = {
  mentions: MentionInboxItem[];
  asOf: number;
  nextCursor: { firstSeenAt: number; pageId: string } | null;
};

function requestMentionPage(cursor: { firstSeenAt: number; pageId: string } | null, traversalAsOf: number | null) {
  const query = new URLSearchParams();
  if (traversalAsOf !== null) query.set("asOf", String(traversalAsOf));
  if (cursor) {
    query.set("beforeAt", String(cursor.firstSeenAt));
    query.set("beforeId", cursor.pageId);
  }
  return api<MentionPageResponse>(`/api/mentions${query.size ? `?${query}` : ""}`);
}

function markMentionsRead(through: number) {
  return api<{ unreadCount: number }>("/api/mentions/read", {
    method: "POST",
    body: json({ through }),
  });
}

function MentionsView({ onSelect, onRead }: { onSelect: (id: string) => void; onRead: (unreadCount: number) => void }) {
  const [mentions, setMentions] = useState<MentionInboxItem[]>([]);
  const [error, setError] = useState("");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<{ firstSeenAt: number; pageId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const active = useRef(true);

  const loadMentionPage = useCallback(
    async (cursor: { firstSeenAt: number; pageId: string }, traversalAsOf: number | null) => {
      setLoading(true);
      setError("");
      try {
        const data = await requestMentionPage(cursor, traversalAsOf);
        if (!active.current) return;
        setMentions((current) => [...current, ...data.mentions]);
        setAsOf(data.asOf);
        setNextCursor(data.nextCursor);
        if (!data.nextCursor) {
          const read = await markMentionsRead(data.asOf);
          if (active.current) onRead(read.unreadCount);
        }
      } catch {
        if (active.current) setError("Mentions could not be loaded. Try again.");
      } finally {
        if (active.current) setLoading(false);
      }
    },
    [onRead],
  );

  useEffect(() => {
    active.current = true;
    let current = true;
    void requestMentionPage(null, null)
      .then(async (data) => {
        if (!current) return;
        setMentions(data.mentions);
        setAsOf(data.asOf);
        setNextCursor(data.nextCursor);
        if (!data.nextCursor) {
          const read = await markMentionsRead(data.asOf);
          if (current) onRead(read.unreadCount);
        }
      })
      .catch(() => {
        if (current) setError("Mentions could not be loaded. Try again.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      active.current = false;
    };
  }, [onRead]);
  return (
    <main className="utility-view">
      <p className="eyebrow">Inbox</p>
      <h1>Mentions</h1>
      {error && <p className="form-error">{error}</p>}
      <div className="mention-inbox">
        {mentions.map((mention) => (
          <button
            key={mention.page.id}
            className={mention.unread ? "unread" : ""}
            onClick={() => onSelect(mention.page.id)}
          >
            <strong>
              {mention.page.icon ?? "□"} {mention.page.title}
            </strong>
            <span>{mention.excerpt || "You were mentioned on this page."}</span>
            <small>{new Date(mention.firstSeenAt).toLocaleString()}</small>
          </button>
        ))}
        {nextCursor && (
          <button
            className="quiet-button"
            disabled={loading}
            onClick={() => {
              void loadMentionPage(nextCursor, asOf);
            }}
          >
            {loading ? "Loading…" : "Load older mentions"}
          </button>
        )}
        {!mentions.length && <p className="empty-copy">No one has mentioned you yet.</p>}
      </div>
    </main>
  );
}

function TrashView({
  pages,
  owner,
  loading,
  loadFailed,
  pendingPageIds,
  onRestore,
  onDelete,
}: {
  pages: Page[];
  owner: boolean;
  loading: boolean;
  loadFailed: boolean;
  pendingPageIds: ReadonlySet<string>;
  onRestore: (page: Page) => Promise<void>;
  onDelete: (page: Page) => Promise<void>;
}) {
  return (
    <main className="utility-view">
      <p className="eyebrow">Archive</p>
      <h1>Trash</h1>
      <p className="muted">Restoring a parent restores its entire archived subtree.</p>
      {loading && <output className="muted">{pages.length ? "Refreshing trash…" : "Loading trash…"}</output>}
      <div className="trash-list">
        {pages.map((page) => {
          const mutationPending = pendingPageIds.has(page.id);
          const actionsDisabled = loading || mutationPending;
          return (
            <div key={page.id}>
              <span>{page.kind === "table" ? "▦" : "□"}</span>
              <strong>{page.title}</strong>
              <button disabled={actionsDisabled} onClick={() => void onRestore(page)}>
                Restore
              </button>
              {owner && (
                <button className="text-danger" disabled={actionsDisabled} onClick={() => void onDelete(page)}>
                  Delete forever
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!pages.length && !loading && !loadFailed && <p className="empty-copy">Trash is empty.</p>}
    </main>
  );
}

type MemberRow = { id: string; name: string; email: string; role: Role; createdAt: number };
function MembersView({ member }: { member: ClientMemberContext }) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const load = useCallback(
    () => api<{ members: MemberRow[] }>("/api/members").then((data) => setMembers(data.members)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function invite(role: "editor" | "viewer") {
    const result = await api<{ invite: { token: string } }>("/api/invites", { method: "POST", body: json({ role }) });
    setInviteUrl(`${location.origin}/?invite=${result.invite.token}`);
  }
  return (
    <main className="utility-view">
      <p className="eyebrow">Workspace access</p>
      <h1>Members</h1>
      {member.role === "owner" && (
        <div className="invite-card">
          <div>
            <strong>Invite a teammate</strong>
            <p>Links can be used once and expire after seven days.</p>
          </div>
          <button onClick={() => void invite("editor")}>Invite editor</button>
          <button onClick={() => void invite("viewer")}>Invite viewer</button>
        </div>
      )}
      {inviteUrl && (
        <div className="invite-link">
          <input readOnly value={inviteUrl} />
          <button onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy</button>
        </div>
      )}
      <div className="member-list">
        {members.map((row) => (
          <div key={row.id}>
            <span className="member-avatar">{row.name[0]?.toUpperCase()}</span>
            <div>
              <strong>{row.name}</strong>
              <small>{row.email}</small>
            </div>
            {member.role === "owner" ? (
              <select
                value={row.role}
                onChange={async (event) => {
                  await api(`/api/members/${row.id}`, { method: "PATCH", body: json({ role: event.target.value }) });
                  await load();
                }}
              >
                <option value="owner">Owner</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : (
              <span>{row.role}</span>
            )}
            {member.role === "owner" && row.id !== member.user.id && (
              <button
                className="text-danger"
                onClick={async () => {
                  if (confirm(`Remove ${row.name}?`)) {
                    await api(`/api/members/${row.id}`, { method: "DELETE" });
                    await load();
                  }
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

function EmptyWorkspace({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  return (
    <main className="empty-workspace">
      <div className="empty-illustration">✦</div>
      <h1>A quiet workspace.</h1>
      <p>{canEdit ? "Create the first page and start writing." : "An editor has not created a page yet."}</p>
      {canEdit && (
        <button className="primary-button" onClick={onCreate}>
          Create a page
        </button>
      )}
    </main>
  );
}
