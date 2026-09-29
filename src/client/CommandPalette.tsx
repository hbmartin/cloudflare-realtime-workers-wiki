import { useEffect, useRef, useState } from "react";
import type { Page, SearchTitleSuggestion } from "../shared/types";
import { api, apiErrorMessage } from "./api";

export type PaletteMode = "all" | "pages" | "commands" | "help";
export type AppCommand = {
  id: string;
  label: string;
  shortcut: string;
  isAvailable: () => boolean;
  run: () => void;
};

type Result = { id: string; label: string; detail: string; run: () => void };

export function CommandPalette({
  mode,
  pages,
  recentIds,
  commands,
  onSelectPage,
  onClose,
}: {
  mode: PaletteMode;
  pages: Page[];
  recentIds: string[];
  commands: AppCommand[];
  onSelectPage: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef(true);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<SearchTitleSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const previous = previousFocus.current;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (restoreFocus.current && previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!query.trim() || mode === "commands" || mode === "help") {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ suggestions: SearchTitleSuggestion[] }>(`/api/search/titles?q=${encodeURIComponent(query)}&limit=20`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) {
            setRemote(result.suggestions);
            setError("");
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Page search unavailable."));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, query]);

  const normalized = query.trim().toLocaleLowerCase();
  const pageMatches = normalized
    ? [
        ...remote.map((result) => result.page),
        ...pages.filter((page) => page.title.toLocaleLowerCase().includes(normalized)),
      ]
    : recentIds.flatMap((id) => pages.find((page) => page.id === id) ?? []);
  const seen = new Set<string>();
  const pageResults: Result[] = pageMatches
    .filter((page) => {
      if (page.archivedAt || ("isTemplate" in page && page.isTemplate) || seen.has(page.id)) return false;
      seen.add(page.id);
      return true;
    })
    .slice(0, 20)
    .map((page) => ({ id: `page:${page.id}`, label: page.title, detail: "Page", run: () => onSelectPage(page.id) }));
  const commandResults: Result[] = commands
    .filter(
      (command) =>
        command.isAvailable() &&
        (!normalized || `${command.label} ${command.shortcut}`.toLocaleLowerCase().includes(normalized)),
    )
    .map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      detail: command.shortcut,
      run: command.run,
    }));
  const shortcutResults: Result[] = [
    { id: "shortcut:all", label: "Find a page or command", detail: "⌘/Ctrl K", run: () => {} },
    { id: "shortcut:pages", label: "Find a page", detail: "⌘/Ctrl P", run: () => {} },
    { id: "shortcut:commands", label: "Run a command", detail: "⌘/Ctrl Shift P", run: () => {} },
    { id: "shortcut:help", label: "Keyboard shortcuts", detail: "?", run: () => {} },
  ].filter(
    (shortcut) => !normalized || `${shortcut.label} ${shortcut.detail}`.toLocaleLowerCase().includes(normalized),
  );
  const results =
    mode === "pages"
      ? pageResults
      : mode === "help"
        ? shortcutResults
        : mode === "commands"
          ? commandResults
          : [...pageResults, ...commandResults];
  const selected = Math.max(0, Math.min(index, results.length - 1));
  const title =
    mode === "help"
      ? "Keyboard shortcuts"
      : mode === "pages"
        ? "Find a page"
        : mode === "commands"
          ? "Run a command"
          : "Find a page or command";
  return (
    <dialog
      ref={dialogRef}
      className="quick-switcher"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="quick-switcher-heading">
        <input
          autoFocus
          aria-label={title}
          placeholder={title}
          role="combobox"
          aria-expanded={true}
          aria-controls="command-palette-options"
          aria-activedescendant={results[selected] ? `palette-result-${selected}` : undefined}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
            setError("");
            setRemote([]);
            setLoading(Boolean(event.target.value.trim()) && mode !== "commands" && mode !== "help");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) =>
                Math.max(0, Math.min(results.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))),
              );
            }
            if (event.key === "Enter" && results[selected]) {
              event.preventDefault();
              restoreFocus.current = false;
              results[selected].run();
              onClose();
            }
          }}
        />
        <button className="icon-button" aria-label="Close palette" onClick={onClose}>
          ×
        </button>
      </div>
      {/* A mixed command/page combobox needs listbox and option semantics. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div className="quick-switcher-results" id="command-palette-options" role="listbox">
        {results.map((result, position) => (
          <button
            id={`palette-result-${position}`}
            key={result.id}
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="option"
            aria-selected={position === selected}
            className={position === selected ? "active" : ""}
            onMouseMove={() => setIndex(position)}
            onClick={() => {
              restoreFocus.current = false;
              result.run();
              onClose();
            }}
          >
            <span>{result.label}</span>
            <small>{result.detail}</small>
          </button>
        ))}
      </div>
      {loading && <output>Searching pages…</output>}
      {error && <p role="alert">{error}</p>}
      {!loading && !results.length && (
        <p className="empty-copy">{error ? "Try again in a moment." : "No matching results."}</p>
      )}
      <footer>↑ ↓ to choose · Enter to open · Esc to close</footer>
    </dialog>
  );
}
