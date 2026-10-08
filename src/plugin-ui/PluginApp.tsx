import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginDocument, PluginPages, PluginSearch, PluginSpaces } from "../shared/plugin-contracts";
import { PAGE_TITLE_MAX } from "../shared/validation";
import { PluginToolError, requestFits, type CreateInput, type PluginApi, type SaveInput } from "./api";
import { MarkdownPreview } from "./MarkdownPreview";

type Destination = { id: string; title: string };
type Navigation = { token: number; run: () => void | Promise<void> };

export function PluginApp({ api, initialPageId }: { api: PluginApi; initialPageId?: string }) {
  const [spaces, setSpaces] = useState<PluginSpaces | null>(null);
  const [spaceId, setSpaceId] = useState("");
  const [parents, setParents] = useState<Destination[]>([]);
  const [listing, setListing] = useState<PluginPages | null>(null);
  const [search, setSearch] = useState<PluginSearch | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PluginDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<PluginDocument | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const preview = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const initialHandled = useRef<string | undefined>(undefined);
  const initializing = useRef(true);
  const loadedApi = useRef<PluginApi | null>(null);
  const mounted = useRef(false);
  const navigationToken = useRef(0);
  const dirty = creating ? !!draft || !!title : editing && draft !== page?.markdown;
  const writable = spaces?.spaces.find((space) => space.id === spaceId)?.canEdit === true;
  const parentId = parents.at(-1)?.id;

  function report(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "NoteFlare is temporarily unavailable.");
    if (cause instanceof PluginToolError && cause.code === "page_changed" && editing) setConflict(true);
  }
  const current = useCallback((token: number) => mounted.current && token === navigationToken.current, []);
  const nextToken = useCallback(() => ++navigationToken.current, []);
  const share = useCallback(
    async (next: PluginDocument | null, selection = "", token = navigationToken.current) => {
      if (!current(token)) return;
      try {
        await api.context(next, selection);
      } catch {
        if (current(token)) setNotice("Chat context could not be updated. You can still use the document tools.");
      }
    },
    [api, current],
  );
  function acceptPage(next: PluginDocument, token: number) {
    if (!current(token)) return;
    setPage(next);
    setDraft(next.markdown);
    setCreating(false);
    setEditing(false);
    setConflict(false);
    setLatest(null);
    pending.current = null;
    void share(next, "", token);
  }
  async function task(action: (token: number) => Promise<void>, token = navigationToken.current) {
    if (!current(token)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(token);
    } catch (cause) {
      if (current(token)) report(cause);
    } finally {
      if (current(token)) setBusy(false);
    }
  }
  function navigate(run: (token: number) => void | Promise<void>) {
    const token = nextToken();
    if (dirty) {
      setBusy(false);
      setNavigation({ token, run: () => run(token) });
    } else {
      setNavigation(null);
      void run(token);
    }
  }
  function keepEditing() {
    nextToken();
    setBusy(false);
    setNavigation(null);
  }
  async function openPage(id: string, token: number) {
    await task(async () => {
      const next = await api.document(id);
      if (!current(token)) return;
      if (!listing) {
        const nextPages = await api.pages(next.spaceId);
        if (!current(token)) return;
        setSpaceId(next.spaceId);
        setParents([]);
        setListing(nextPages);
      }
      acceptPage(next, token);
    }, token);
  }
  async function browse(nextSpace: string, nextParents: Destination[], token: number) {
    await task(async () => {
      const next = nextSpace ? await api.pages(nextSpace, nextParents.at(-1)?.id) : null;
      if (!current(token)) return;
      setSpaceId(nextSpace);
      setParents(nextParents);
      setListing(next);
      setSearch(null);
      setPage(null);
      setCreating(false);
      setEditing(false);
      setDraft("");
      setTitle("");
      setConflict(false);
      setLatest(null);
      pending.current = null;
      void share(null, "", token);
    }, token);
  }

  useEffect(() => {
    mounted.current = true;
    initializing.current = true;
    loadedApi.current = null;
    initialHandled.current = undefined;
    const token = nextToken();
    setSpaces(null);
    setListing(null);
    setBusy(true);
    async function initialize() {
      try {
        const nextSpaces = await api.spaces();
        if (!current(token)) return;
        loadedApi.current = api;
        setSpaces(nextSpaces);
      } catch (cause) {
        if (current(token)) {
          setError(cause instanceof Error ? cause.message : "NoteFlare could not be loaded.");
          setBusy(false);
        }
      }
    }
    void initialize();
    return () => {
      mounted.current = false;
      nextToken();
    };
    // Load spaces once; the navigation effect uses the latest host page after bootstrap.
  }, [api, current, nextToken]);

  useEffect(() => {
    if (!spaces || loadedApi.current !== api) return;
    if (initializing.current) {
      initializing.current = false;
      initialHandled.current = initialPageId;
      navigate((token) =>
        initialPageId ? openPage(initialPageId, token) : browse(spaces.spaces[0]?.id ?? "", [], token),
      );
      return;
    }
    if (!initialPageId || initialHandled.current === initialPageId) return;
    initialHandled.current = initialPageId;
    navigate((token) => openPage(initialPageId, token));
    // Host intent and the draft guard trigger navigation; helpers use this render's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, initialPageId, spaces, dirty]);

  useEffect(() => {
    if (!navigation || !dialog.current) return;
    if (typeof dialog.current.showModal === "function") dialog.current.showModal();
    else dialog.current.setAttribute("open", "");
  }, [navigation]);

  useEffect(() => {
    function selected(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && !event.shiftKey) return;
      const selection = window.getSelection();
      if (
        !page ||
        !selection?.anchorNode ||
        !selection.focusNode ||
        !preview.current?.contains(selection.anchorNode) ||
        !preview.current.contains(selection.focusNode)
      )
        return;
      void share(page, selection.toString());
    }
    document.addEventListener("mouseup", selected);
    document.addEventListener("keyup", selected);
    return () => {
      document.removeEventListener("mouseup", selected);
      document.removeEventListener("keyup", selected);
    };
  }, [share, page]);

  const openLink = (url: string) => {
    const token = navigationToken.current;
    void api.link(url).catch((cause) => {
      if (current(token)) report(cause);
    });
  };
  const operationId = (key: string) => {
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  };
  function saveInput(operation_id: string): SaveInput | null {
    return page
      ? {
          page_id: page.id,
          expected_revision: page.revision,
          expected_content_epoch: page.contentEpoch,
          operation_id,
          command: { type: "replace_content", replace_content: { new_str: draft } },
        }
      : null;
  }
  const previewInput = creating
    ? {
        space_id: spaceId,
        parent_id: parentId,
        title,
        markdown: draft,
        operation_id: "00000000-0000-0000-0000-000000000000",
      }
    : saveInput("00000000-0000-0000-0000-000000000000");
  const fits = !previewInput || requestFits(creating ? "create_page" : "update_page", previewInput);

  async function save(token = navigationToken.current): Promise<boolean> {
    if (!current(token) || conflict || !fits) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const key = JSON.stringify(previewInput);
      const id = operationId(key);
      const input = saveInput(id);
      let savedId: string;
      if (creating) {
        const create: CreateInput = {
          space_id: spaceId,
          ...(parentId ? { parent_id: parentId } : {}),
          title: title.trim(),
          markdown: draft,
          operation_id: id,
        };
        savedId = (await api.create(create)).id;
      } else if (input) {
        savedId = (await api.save(input)).id;
      } else return false;
      // Fetch failures retain the operation ID: retrying a committed write returns its receipt.
      if (!current(token)) return false;
      const refreshed = await api.document(savedId);
      if (!current(token)) return false;
      acceptPage(refreshed, token);
      setNotice("Document saved.");
      if (spaceId) {
        try {
          const next = await api.pages(spaceId, parentId);
          if (current(token)) setListing(next);
        } catch {
          if (current(token)) setNotice("Document saved. Refresh navigation to see the updated list.");
        }
      }
      return true;
    } catch (cause) {
      if (current(token)) report(cause);
      return false;
    } finally {
      if (current(token)) setBusy(false);
    }
  }
  function newDocument() {
    navigate((token) => {
      setPage(null);
      setDraft("");
      setTitle("");
      setCreating(true);
      setEditing(true);
      setConflict(false);
      setLatest(null);
      setError("");
      pending.current = null;
      void share(null, "", token);
    });
  }
  async function runNavigation(discard: boolean) {
    const next = navigation;
    if (!next || !current(next.token) || (!discard && !(await save(next.token))) || !current(next.token)) return;
    setNavigation(null);
    await next.run();
  }
  async function find(more = false) {
    await task(async (token) => {
      const result = await api.search(query.trim(), more ? (search?.nextCursor ?? undefined) : undefined);
      if (current(token)) setSearch(more && search ? { ...result, pages: [...search.pages, ...result.pages] } : result);
    });
  }
  const shareSelection = (selection: string) => {
    if (page) void share(page, selection);
  };

  return (
    <div className="plugin-shell">
      <header>
        <div className="brand">
          <span aria-hidden="true">✦</span>
          <strong>NoteFlare</strong>
          <span>{spaces?.workspace.name ?? "Your wiki"}</span>
        </div>
        <button type="button" disabled={busy || !writable} onClick={newDocument}>
          New document
        </button>
      </header>
      {error ? (
        <div role="alert" className="message error">
          {error}
        </div>
      ) : null}
      {notice ? <output className="message">{notice}</output> : null}
      {busy ? <output className="loading">Loading NoteFlare…</output> : null}
      <div className="workspace">
        <aside aria-label="Wiki navigation">
          <label htmlFor="space">Space</label>
          <select
            id="space"
            value={spaceId}
            disabled={busy || creating}
            onChange={(event) => {
              const destination = event.target.value;
              navigate((token) => browse(destination, [], token));
            }}
          >
            {spaces?.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
                {space.canEdit ? "" : " (read only)"}
              </option>
            ))}
          </select>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim()) void find();
            }}
          >
            <label htmlFor="search">Search wiki</label>
            <div className="search">
              <input
                id="search"
                type="search"
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="submit" disabled={busy || !query.trim()}>
                Search
              </button>
            </div>
          </form>
          {search ? (
            <button type="button" disabled={busy} onClick={() => setSearch(null)}>
              Back to pages
            </button>
          ) : (
            <nav aria-label="Page location">
              <button type="button" disabled={busy} onClick={() => navigate((token) => browse(spaceId, [], token))}>
                Space roots
              </button>
              {parents.map((parent, index) => (
                <button
                  key={parent.id}
                  type="button"
                  disabled={busy}
                  onClick={() => navigate((token) => browse(spaceId, parents.slice(0, index + 1), token))}
                >
                  {parent.title}
                </button>
              ))}
            </nav>
          )}
          <ul className="page-list">
            {(search?.pages ?? listing?.pages ?? []).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-current={page?.id === item.id ? "page" : undefined}
                  onClick={() =>
                    item.kind === "document" ? navigate((token) => openPage(item.id, token)) : openLink(item.url)
                  }
                >
                  {item.title || "Untitled"}
                  <small>{item.kind === "document" ? "" : `Open ${item.kind} in NoteFlare`}</small>
                </button>
                {!search ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="children"
                    aria-label={`Browse children of ${item.title}`}
                    onClick={() =>
                      navigate((token) => browse(spaceId, [...parents, { id: item.id, title: item.title }], token))
                    }
                  >
                    ›
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {search?.nextCursor ? (
            <button type="button" disabled={busy} onClick={() => void find(true)}>
              More search results
            </button>
          ) : null}
          {!search && listing?.nextCursor ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void task(async (token) => {
                  const more = await api.pages(spaceId, parentId, listing.nextCursor ?? undefined);
                  if (current(token)) setListing({ ...more, pages: [...listing.pages, ...more.pages] });
                })
              }
            >
              More pages
            </button>
          ) : null}
          {spaces && spaces.spaces.length === 0 ? <p>You have no accessible spaces.</p> : null}
        </aside>
        <main>
          {page || creating ? (
            <>
              <div className="document-heading">
                <h1>{creating ? "New document" : page?.title}</h1>
                {page ? (
                  <button type="button" onClick={() => openLink(page.url)}>
                    Open in NoteFlare ↗
                  </button>
                ) : null}
              </div>
              {page?.truncated ? (
                <p className="message">This preview is incomplete. Open the document in NoteFlare to edit it.</p>
              ) : null}
              {page?.unknownBlockIds.length ? (
                <p className="message">
                  Some blocks appear as placeholders. NoteFlare protects those blocks when saving.
                </p>
              ) : null}
              {!fits ? (
                <p className="message">This document is too large to save here. Open it in NoteFlare to edit it.</p>
              ) : null}
              {creating ? (
                <div className="new-document">
                  <label htmlFor="title">Title</label>
                  <input
                    id="title"
                    maxLength={PAGE_TITLE_MAX}
                    value={title}
                    disabled={busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <p>
                    Saving in {spaces?.spaces.find((space) => space.id === spaceId)?.name}
                    {parents.length ? ` / ${parents.at(-1)?.title}` : ""}.
                  </p>
                </div>
              ) : null}
              {editing ? (
                <>
                  <label htmlFor="draft">Markdown draft</label>
                  <textarea
                    id="draft"
                    value={draft}
                    disabled={busy}
                    spellCheck
                    onChange={(event) => setDraft(event.target.value)}
                    onSelect={(event) =>
                      shareSelection(draft.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd))
                    }
                  />
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        busy || conflict || !fits || (creating ? !title.trim() || !writable : !page?.canEdit || !dirty)
                      }
                      onClick={() => void save()}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        navigate(() => {
                          setCreating(false);
                          setEditing(false);
                          setTitle("");
                          setConflict(false);
                          setLatest(null);
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                  {conflict ? (
                    <div className="conflict">
                      <p>
                        The document changed. Your draft is preserved. Compare the current version and reconcile your
                        edits before saving.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void task(async (token) => {
                            if (page) {
                              const next = await api.document(page.id);
                              if (current(token)) setLatest(next);
                            }
                          })
                        }
                      >
                        Review current version
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (page) navigate((token) => openPage(page.id, token));
                        }}
                      >
                        Reload document
                      </button>
                      {latest ? (
                        <>
                          <details open>
                            <summary>Current document</summary>
                            <MarkdownPreview markdown={latest.markdown} openLink={openLink} />
                          </details>
                          <button
                            type="button"
                            disabled={busy || !latest.canEdit}
                            onClick={() => {
                              setPage(latest);
                              setLatest(null);
                              setConflict(false);
                              setError("");
                              pending.current = null;
                            }}
                          >
                            I’ve reconciled my draft
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <h2>Draft preview</h2>
                </>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy || !page?.canEdit || page.truncated || !fits}
                    onClick={() => {
                      setDraft(page?.markdown ?? "");
                      setEditing(true);
                    }}
                  >
                    Edit Markdown
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (page) navigate((token) => openPage(page.id, token));
                    }}
                  >
                    Refresh
                  </button>
                </div>
              )}
              <section ref={preview} aria-label="Document preview">
                <MarkdownPreview markdown={editing ? draft : (page?.markdown ?? "")} openLink={openLink} />
              </section>
            </>
          ) : (
            <div className="empty">
              <h1>Your wiki, beside your chat</h1>
              <p>Choose a document or search your workspace. Select text to share it with ChatGPT.</p>
            </div>
          )}
        </main>
      </div>
      {navigation ? (
        <div className="dialog-backdrop">
          <dialog ref={dialog} aria-labelledby="draft-dialog-title" className="dialog" onCancel={keepEditing}>
            <h2 id="draft-dialog-title">Keep your draft?</h2>
            <p>You have unsaved changes.</p>
            <div className="actions">
              <button
                type="button"
                disabled={busy || conflict || !fits || (creating && !title.trim())}
                onClick={() => void runNavigation(false)}
              >
                Save and continue
              </button>
              <button type="button" disabled={busy} onClick={() => void runNavigation(true)}>
                Discard and continue
              </button>
              <button type="button" disabled={busy} onClick={keepEditing}>
                Keep editing
              </button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}
