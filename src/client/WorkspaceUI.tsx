import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Page, SearchResponse } from "../shared/types";
import { api, apiErrorMessage } from "./api";

const paths = {
  search: "m21 21-5-5 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  home: "m3 10 9-7 9 7v11H3Z M9 21v-8h6v8",
  inbox: "M4 4h16l2 12v5H2v-5Z M2 16h6l2 3h4l2-3h6",
  tasks: "m3 6 2 2 4-4 M12 6h9 M3 13h5 M12 13h9 M3 20h5 M12 20h9",
  page: "M14 2H5v20h14V7Z M14 2v5h5 M8 12h8 M8 16h8",
  table: "M3 3h18v18H3Z M3 9h18 M9 3v18",
  diagram: "M9 2h6v6H9Z M2 16h6v6H2Z M16 16h6v6h-6Z M12 8v4H5v4 M12 12h7v4",
  star: "m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z",
  pin: "m8 3 8 0-1 7 4 4H5l4-4Z M12 14v8",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  plus: "M12 4v16 M4 12h16",
  chevron: "m9 5 7 7-7 7",
  sidebar: "M3 3h18v18H3Z M9 3v18",
  close: "m6 6 12 12 M18 6 6 18",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  trash: "M3 6h18 M5 6l1 15h12l1-15 M9 6V3h6v3 M10 10v7 M14 10v7",
  history: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2",
  comment: "M3 3h18v14H8l-5 4Z",
  download: "M12 3v12 m-5-5 5 5 5-5 M3 16v5h18v-5",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function ActionMenu({ label, children, icon = "more", className = "" }: { label: string; children: ReactNode; icon?: keyof typeof paths; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <details ref={ref} className={`action-menu ${className}`} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); if (ref.current) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); } }
  }}>
    <summary aria-label={label} title={label}><Icon name={icon} /><span className="menu-label">{label}</span></summary>
    <div className="action-menu-content" onClick={(event) => {
      if ((event.target as HTMLElement).closest("button[data-close-menu]") && ref.current) ref.current.open = false;
    }}>{children}</div>
  </details>;
}

/** Page editors own their controls; the shell supplies their shared toolbar location. */
export function PageTools({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { setTarget(document.getElementById("page-tools-slot")); }, []);
  return target ? createPortal(children, target) : <div className="page-tools">{children}</div>;
}

export function readPreference<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; } catch { return fallback; }
}

export function savePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences must not block editing. */ }
}

export function RecentPages({ pages, recentIds, onSelect }: { pages: Page[]; recentIds: string[]; onSelect: (id: string) => void }) {
  const recent = recentIds.flatMap((id) => { const page = pages.find((item) => item.id === id && !item.archivedAt); return page ? [page] : []; });
  return <main className="utility-view home-view"><p className="eyebrow">Your workspace</p><h1>Home</h1><p className="muted">Pick up where you left off.</p><h2>Recent pages</h2>
    <div className="recent-pages">{recent.map((page) => <button key={page.id} onClick={() => onSelect(page.id)}><span>{page.icon || <Icon name={page.kind === "document" ? "page" : page.kind} />}</span><strong>{page.title}</strong></button>)}</div>
    {!recent.length && <p className="empty-copy">Pages you visit will appear here. Choose a page in the sidebar or create your first one.</p>}
  </main>;
}

export function QuickSwitcher({ pages, recentIds, onSelect, onClose }: { pages: Page[]; recentIds: string[]; onSelect: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Array<{ id: string; title: string; icon: string | null }>>([]);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  useEffect(() => {
    setIndex(0); setRemote([]); setError("");
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void api<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}&limit=20`, { signal: controller.signal }).then((result) => setRemote(result.results.map((r) => ({ id: r.page.id, title: r.page.title, icon: r.page.icon })))).catch((cause) => { if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Search unavailable.")); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  const local = query.trim() ? pages.filter((p) => !p.archivedAt && p.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : recentIds.flatMap((id) => pages.find((p) => p.id === id) ?? []);
  const results = [...local, ...remote.filter((r) => !local.some((p) => p.id === r.id))].slice(0, 20);
  return <dialog ref={ref} className="quick-switcher" aria-label="Find a page" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="quick-switcher-heading"><Icon name="search" /><input autoFocus placeholder="Find a page…" aria-label="Find a page" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(0, Math.min(results.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))); }
      if (event.key === "Enter" && results[index]) { onSelect(results[index].id); onClose(); }
    }} /><button className="icon-button" aria-label="Close search" onClick={onClose}><Icon name="close" /></button></div>
    <p className="eyebrow">{query ? "Pages" : "Recently opened"}</p>
    <div className="quick-switcher-results">{results.map((page, i) => <button key={page.id} className={i === index ? "active" : ""} onMouseEnter={() => setIndex(i)} onClick={() => { onSelect(page.id); onClose(); }}><span>{page.icon || <Icon name="page" />}</span>{page.title}</button>)}</div>
    {error && <p role="alert">{error}</p>}{!results.length && <p className="empty-copy">{query ? "No matching pages." : "Search your workspace to get started."}</p>}
    <footer>↑ ↓ to choose · Enter to open · Esc to close</footer>
  </dialog>;
}
