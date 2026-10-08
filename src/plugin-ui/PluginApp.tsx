import { useEffect, useRef, useState } from "react";
import type { PluginDocument, PluginPages, PluginSearch, PluginSpaces } from "../shared/plugin-contracts";
import { PAGE_TITLE_MAX } from "../shared/validation";
import { PluginToolError, requestFits, type CreateInput, type PluginApi, type SaveInput } from "./api";
import { MarkdownPreview } from "./MarkdownPreview";

type Destination = { id: string; title: string };
type Navigation = { run: () => void | Promise<void> };

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
  const dirty = creating ? !!draft || !!title : editing && draft !== page?.markdown;
  const writable = spaces?.spaces.find((space) => space.id === spaceId)?.canEdit === true;
  const parentId = parents.at(-1)?.id;

  function report(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "NoteFlare is temporarily unavailable.");
    if (cause instanceof PluginToolError && cause.code === "page_changed" && editing) setConflict(true);
  }
  async function share(next: PluginDocument | null, selection = "") {
    try {
      await api.context(next, selection);
    } catch {
      setNotice("Chat context could not be updated. You can still use the document tools.");
    }
  }
  function acceptPage(next: PluginDocument) {
    setPage(next);
    setDraft(next.markdown);
    setCreating(false);
    setEditing(false);
    setConflict(false);
    setLatest(null);
    pending.current = null;
    void share(next);
  }
  async function task(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }
  function navigate(run: () => void | Promise<void>) {
    if (dirty) setNavigation({ run });
    else void run();
  }
  async function openPage(id: string) {
    await task(async () => {
      acceptPage(await api.document(id));
    });
  }
  async function browse(nextSpace: string, nextParents: Destination[] = []) {
    await task(async () => {
      const next = await api.pages(nextSpace, nextParents.at(-1)?.id);
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
      void share(null);
    });
  }

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const nextSpaces = await api.spaces();
        const nextPage = initialPageId ? await api.document(initialPageId) : null;
        const nextSpace = nextPage?.spaceId ?? nextSpaces.spaces[0]?.id ?? "";
        const nextPages = nextSpace ? await api.pages(nextSpace) : null;
        if (!active) return;
        setSpaces(nextSpaces);
        setSpaceId(nextSpace);
        setListing(nextPages);
        if (nextPage) {
          setPage(nextPage);
          setDraft(nextPage.markdown);
          void api.context(nextPage).catch(() => {});
        }
        initialHandled.current = initialPageId;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "NoteFlare could not be loaded.");
      } finally {
        if (active) setBusy(false);
      }
    }
    void initialize();
    return () => {
      active = false;
    };
    // Initial setup is separate from later host navigation, which must guard a dirty draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (!spaces || !initialPageId || initialHandled.current === initialPageId) return;
    initialHandled.current = initialPageId;
    const run = async () => {
      setBusy(true);
      setError("");
      try {
        const next = await api.document(initialPageId);
        setPage(next);
        setDraft(next.markdown);
        setCreating(false);
        setEditing(false);
        setConflict(false);
        setLatest(null);
        pending.current = null;
        await api.context(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The document could not be opened.");
      } finally {
        setBusy(false);
      }
    };
    if (dirty) setNavigation({ run });
    else void run();
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
      void api.context(page, selection.toString()).catch(() => {
        setNotice("Chat context could not be updated. You can still use the document tools.");
      });
    }
    document.addEventListener("mouseup", selected);
    document.addEventListener("keyup", selected);
    return () => {
      document.removeEventListener("mouseup", selected);
      document.removeEventListener("keyup", selected);
    };
  }, [api, page]);

  const openLink = (url: string) => {
    void api.link(url).catch(report);
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

  async function save(): Promise<boolean> {
    if (conflict || !fits) return false;
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
      const refreshed = await api.document(savedId);
      acceptPage(refreshed);
      setNotice("Document saved.");
      if (spaceId) {
        try {
          setListing(await api.pages(spaceId, parentId));
        } catch {
          setNotice("Document saved. Refresh navigation to see the updated list.");
        }
      }
      return true;
    } catch (cause) {
      report(cause);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function newDocument() {
    navigate(() => {
      setPage(null);
      setDraft("");
      setTitle("");
      setCreating(true);
      setEditing(true);
      setConflict(false);
      setLatest(null);
      setError("");
      pending.current = null;
      void share(null);
    });
  }
  async function runNavigation(discard: boolean) {
    const next = navigation;
    if (!next || (!discard && !(await save()))) return;
    setNavigation(null);
    await next.run();
  }
  async function find(more = false) {
    await task(async () => {
      const result = await api.search(query.trim(), more ? (search?.nextCursor ?? undefined) : undefined);
      setSearch(more && search ? { ...result, pages: [...search.pages, ...result.pages] } : result);
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
              navigate(() => browse(destination));
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
              <button type="button" disabled={busy} onClick={() => navigate(() => browse(spaceId))}>
                Space roots
              </button>
              {parents.map((parent, index) => (
                <button
                  key={parent.id}
                  type="button"
                  disabled={busy}
                  onClick={() => navigate(() => browse(spaceId, parents.slice(0, index + 1)))}
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
                  onClick={() => (item.kind === "document" ? navigate(() => openPage(item.id)) : openLink(item.url))}
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
                    onClick={() => navigate(() => browse(spaceId, [...parents, { id: item.id, title: item.title }]))}
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
                void task(async () => {
                  const more = await api.pages(spaceId, parentId, listing.nextCursor ?? undefined);
                  setListing({ ...more, pages: [...listing.pages, ...more.pages] });
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
                          setDraft(page?.markdown ?? "");
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
                          void task(async () => {
                            if (page) setLatest(await api.document(page.id));
                          })
                        }
                      >
                        Review current version
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (page) navigate(() => openPage(page.id));
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
                    onClick={() => setEditing(true)}
                  >
                    Edit Markdown
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (page) void openPage(page.id);
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
          <dialog
            ref={dialog}
            aria-labelledby="draft-dialog-title"
            className="dialog"
            onCancel={() => setNavigation(null)}
          >
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
              <button type="button" disabled={busy} onClick={() => setNavigation(null)}>
                Keep editing
              </button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}
