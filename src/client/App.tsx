import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ClientMemberContext } from "../shared/types";
import { buildTree } from "../shared/tree-model";
import type { MentionInboxItem, Page, PageKind, PageNode, Role, WorkspaceEvent } from "../shared/types";
import { ApiClientError, api, authClient, json, onApiUnauthorized } from "./api";
import { createWorkspaceEvents } from "./collaboration";
import { EditorPage } from "./EditorPage";
import { invalidatePagePreview, PAGE_NAVIGATE_EVENT } from "./mentions";
import { authoritativePageSnapshot, mergePages, mergePageSnapshot, PageLoadEventBuffer } from "./page-state";
import { TablePage } from "./TablePage";

type AppState =
  | { screen: "loading" }
  | { screen: "bootstrap" }
  | { screen: "signin"; message?: string }
  | { screen: "invite"; token: string }
  | { screen: "workspace"; member: ClientMemberContext };

export function App() {
  const [state, setState] = useState<AppState>({ screen: "loading" });
  const signOut = useCallback(() => setState({ screen: "signin" }), []);
  const sessionExpired = useCallback((error: ApiClientError) => {
    setState((current) => (current.screen === "workspace" ? { screen: "signin", message: error.message } : current));
  }, []);

  const load = useCallback(async () => {
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (invite) {
      setState({ screen: "invite", token: invite });
      return;
    }
    const install = await api<{ initialized: boolean }>("/api/install");
    if (!install.initialized) {
      setState({ screen: "bootstrap" });
      return;
    }
    try {
      const member = await api<ClientMemberContext>("/api/me");
      setState({ screen: "workspace", member });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) setState({ screen: "signin" });
      else throw error;
    }
  }, []);

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
  return <Workspace member={state.member} onSignOut={signOut} onSessionExpired={sessionExpired} />;
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
      setError(cause instanceof Error ? cause.message : "Setup failed.");
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
      setError(cause instanceof Error ? cause.message : "Invite could not be accepted.");
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
        setError(result.error.message ?? "Sign in failed.");
        return;
      }
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
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

function Workspace({
  member,
  onSignOut,
  onSessionExpired,
}: {
  member: ClientMemberContext;
  onSignOut: () => void;
  onSessionExpired: (error: ApiClientError) => void;
}) {
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
  const [workspaceError, setWorkspaceError] = useState("");
  const pendingPageEvents = useRef(new PageLoadEventBuffer());
  const pageLoadPromise = useRef<Promise<void> | null>(null);

  const recordPageUpserts = useCallback((incoming: Page[]) => {
    pendingPageEvents.current.recordUpserts(incoming);
  }, []);
  const recordPageRemovals = useCallback((pageIds: string[]) => {
    pendingPageEvents.current.recordRemovals(pageIds);
  }, []);

  const loadPages = useCallback(() => {
    if (pageLoadPromise.current) return pageLoadPromise.current;
    pendingPageEvents.current.start();
    const loading = api<{ pages: Page[] }>("/api/pages/tree")
      .then((data) => {
        const { upserts, removals } = pendingPageEvents.current.consume();
        const authoritative = authoritativePageSnapshot(data.pages, upserts, removals);
        setPages((current) => mergePageSnapshot(current, authoritative.pages));
        setPagesLoaded(true);
        setSelectedId((current) =>
          current && authoritative.ids.has(current) ? current : ([...authoritative.ids][0] ?? null),
        );
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
  }, []);
  const loadTrash = useCallback(async () => {
    const data = await api<{ pages: Page[] }>("/api/pages/tree?archived=true");
    setTrash(data.pages);
  }, []);
  const loadUnreadMentions = useCallback(async () => {
    const data = await api<{ unreadCount: number }>("/api/mentions/unread-count");
    setUnreadMentions(data.unreadCount);
  }, []);
  const handleMentionsRead = useCallback((unreadCount: number) => setUnreadMentions(unreadCount), []);
  useEffect(() => {
    void loadPages().catch((error) => {
      setWorkspaceError(error instanceof Error ? error.message : "The page tree could not be loaded.");
    });
  }, [loadPages]);
  useEffect(() => {
    void loadUnreadMentions();
  }, [loadUnreadMentions]);
  useEffect(() => {
    if (selectedId) localStorage.setItem("notes:last-page", selectedId);
  }, [selectedId]);

  const handleWorkspaceEvent = useCallback(
    (event: WorkspaceEvent) => {
      if (event.type === "pages-upserted") {
        recordPageUpserts(event.pages);
        for (const page of event.pages) invalidatePagePreview(page.id);
        setPages((current) => mergePages(current, event.pages));
        setTrash((current) => current.filter((page) => !event.pages.some((updated) => updated.id === page.id)));
        return;
      }
      if (event.type === "pages-removed") {
        recordPageRemovals(event.pageIds);
        for (const pageId of event.pageIds) invalidatePagePreview(pageId);
        setPages((current) => current.filter((page) => !event.pageIds.includes(page.id)));
        if (event.permanently) {
          setTrash((current) => current.filter((page) => !event.pageIds.includes(page.id)));
        } else {
          void loadTrash();
        }
        return;
      }
      invalidatePagePreview(event.pageId);
      setBacklinksRevision((current) => current + 1);
      if (event.mentionTargetUserIds.includes(member.user.id)) void loadUnreadMentions();
    },
    [loadTrash, loadUnreadMentions, member.user.id, recordPageRemovals, recordPageUpserts],
  );

  useEffect(() => {
    const bundle = createWorkspaceEvents(member.workspace.id, handleWorkspaceEvent, () => {
      void loadPages().catch((error) => {
        setWorkspaceError(error instanceof Error ? error.message : "The page tree could not be refreshed.");
      });
      void loadUnreadMentions();
    });
    return () => bundle.destroy();
  }, [handleWorkspaceEvent, loadPages, loadUnreadMentions, member.workspace.id]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const pageId = (event as CustomEvent<string>).detail;
      if (!pageId) return;
      setSelectedId(pageId);
      setView("pages");
      setSidebarOpen(false);
    };
    window.addEventListener(PAGE_NAVIGATE_EVENT, navigate);
    return () => window.removeEventListener(PAGE_NAVIGATE_EVENT, navigate);
  }, []);

  useEffect(() => {
    if (pagesLoaded && selectedId && !pages.some((page) => page.id === selectedId)) {
      setSelectedId(pages[0]?.id ?? null);
    }
  }, [pages, pagesLoaded, selectedId]);

  const selected = pages.find((page) => page.id === selectedId) ?? null;
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
    setSelectedId(result.page.id);
    setView("pages");
    setSidebarOpen(false);
  }
  async function archive(page: Page) {
    if (!confirm(`Move “${page.title}” and its children to trash?`)) return;
    setWorkspaceError("");
    try {
      await api(`/api/pages/${page.id}`, { method: "DELETE" });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "The page could not be archived.");
    } finally {
      await loadPages().catch((error) => {
        setWorkspaceError(error instanceof Error ? error.message : "The page tree could not be refreshed.");
      });
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
  async function showTrash() {
    await loadTrash();
    setView("trash");
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
      recordPageRemovals([pageId]);
      setPages((current) => current.filter((page) => page.id !== pageId));
      void loadPages().catch((error) => {
        setWorkspaceError(error instanceof Error ? error.message : "The page tree could not be refreshed.");
      });
    },
    [loadPages, recordPageRemovals],
  );
  const documentAccessDenied = useCallback(
    (pageId: string, error: ApiClientError) => {
      setWorkspaceError(error.message);
      pageUnavailable(pageId);
    },
    [pageUnavailable],
  );

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
          <button className={view === "search" ? "active" : ""} onClick={() => setView("search")}>
            <span>⌕</span> Search
          </button>
          <button className={view === "mentions" ? "active" : ""} onClick={() => setView("mentions")}>
            <span>@</span> Mentions {unreadMentions > 0 && <b className="mention-badge">{unreadMentions}</b>}
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
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
            selectedId={selectedId}
            editable={member.role !== "viewer"}
            onSelect={(id) => {
              setSelectedId(id);
              setView("pages");
              setSidebarOpen(false);
            }}
            onCreate={(parentId) => void createPage("document", parentId)}
            onArchive={(page) => void archive(page)}
            onDropPage={(id, parentId) => void move(id, parentId)}
            onMove={(id, parentId, beforeId, afterId) => void move(id, parentId, beforeId, afterId)}
          />
        </div>
        <button className="trash-link" onClick={() => void showTrash()}>
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
        {workspaceError && <p className="form-error workspace-error">{workspaceError}</p>}
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
          <SearchView
            value={search}
            results={searchResults}
            onChange={runSearch}
            onSelect={(id) => {
              setSelectedId(id);
              setView("pages");
            }}
          />
        ) : view === "mentions" ? (
          <MentionsView
            onSelect={(id) => {
              setSelectedId(id);
              setView("pages");
            }}
            onRead={handleMentionsRead}
          />
        ) : view === "trash" ? (
          <TrashView
            pages={trash}
            owner={member.role === "owner"}
            onRestore={async (page) => {
              await api(`/api/pages/${page.id}/restore`, { method: "POST" });
              await loadPages();
              await showTrash();
            }}
            onDelete={async (page) => {
              if (!confirm(`Permanently delete “${page.title}”? This cannot be undone.`)) return;
              await api(`/api/pages/${page.id}/permanent-delete`, { method: "POST" });
              await showTrash();
            }}
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
              onSessionExpired={onSessionExpired}
              onSelectPage={(id) => {
                setSelectedId(id);
                setView("pages");
              }}
              backlinksRevision={backlinksRevision}
            />
          ) : (
            <TablePage
              key={selected.id}
              page={selected}
              member={member}
              onPageChanged={updatePage}
              onSelectPage={(id) => {
                setSelectedId(id);
                setView("pages");
              }}
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

function MentionsView({ onSelect, onRead }: { onSelect: (id: string) => void; onRead: (unreadCount: number) => void }) {
  const [mentions, setMentions] = useState<MentionInboxItem[]>([]);
  const [error, setError] = useState("");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<{ firstSeenAt: number; pageId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const active = useRef(true);

  const loadMentionPage = useCallback(
    async (cursor: { firstSeenAt: number; pageId: string } | null = null, traversalAsOf: number | null = null) => {
      setLoading(true);
      setError("");
      const query = new URLSearchParams();
      if (traversalAsOf !== null) query.set("asOf", String(traversalAsOf));
      if (cursor) {
        query.set("beforeAt", String(cursor.firstSeenAt));
        query.set("beforeId", cursor.pageId);
      }
      try {
        const data = await api<{
          mentions: MentionInboxItem[];
          asOf: number;
          nextCursor: { firstSeenAt: number; pageId: string } | null;
        }>(`/api/mentions${query.size ? `?${query}` : ""}`);
        if (!active.current) return;
        setMentions((current) => (cursor ? [...current, ...data.mentions] : data.mentions));
        setAsOf(data.asOf);
        setNextCursor(data.nextCursor);
        if (!data.nextCursor) {
          const read = await api<{ unreadCount: number }>("/api/mentions/read", {
            method: "POST",
            body: json({ through: data.asOf }),
          });
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
    void loadMentionPage();
    return () => {
      active.current = false;
    };
  }, [loadMentionPage]);
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
  onRestore,
  onDelete,
}: {
  pages: Page[];
  owner: boolean;
  onRestore: (page: Page) => void;
  onDelete: (page: Page) => void;
}) {
  return (
    <main className="utility-view">
      <p className="eyebrow">Archive</p>
      <h1>Trash</h1>
      <p className="muted">Restoring a parent restores its entire archived subtree.</p>
      <div className="trash-list">
        {pages.map((page) => (
          <div key={page.id}>
            <span>{page.kind === "table" ? "▦" : "□"}</span>
            <strong>{page.title}</strong>
            <button onClick={() => onRestore(page)}>Restore</button>
            {owner && (
              <button className="text-danger" onClick={() => onDelete(page)}>
                Delete forever
              </button>
            )}
          </div>
        ))}
      </div>
      {!pages.length && <p className="empty-copy">Trash is empty.</p>}
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
