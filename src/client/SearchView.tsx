import { useEffect, useState } from "react";
import type {
  PageKind,
  SearchArchiveState,
  SearchResponse,
  SearchResult,
  Space,
  Tag,
} from "../shared/types";
import { api, apiErrorMessage } from "./api";

type SearchMember = { id: string; name: string; email: string };

type UiFilters = {
  spaceId: string;
  tagIds: string[];
  creatorId: string;
  kind: "" | PageKind;
  updatedFrom: string;
  updatedTo: string;
  hasComments: "" | "true" | "false";
  archive: SearchArchiveState;
};

function dateFromTimestamp(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return "";
  return new Date(Number(value)).toISOString().slice(0, 10);
}

function initialSearchState() {
  const parameters = new URLSearchParams(window.location.search);
  return {
    query: parameters.get("q") ?? "",
    filters: {
      spaceId: parameters.get("space") ?? "",
      tagIds: parameters.getAll("tag"),
      creatorId: parameters.get("creator") ?? "",
      kind: (parameters.get("kind") ?? "") as UiFilters["kind"],
      updatedFrom: dateFromTimestamp(parameters.get("updatedFrom")),
      updatedTo: dateFromTimestamp(parameters.get("updatedTo")),
      hasComments: (parameters.get("hasComments") ?? "") as UiFilters["hasComments"],
      archive: (parameters.get("archive") ?? "active") as SearchArchiveState,
    } satisfies UiFilters,
  };
}

function timestampForDate(value: string, endOfDay = false) {
  if (!value) return "";
  return String(new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`).getTime());
}

function requestParameters(query: string, filters: UiFilters, offset: number) {
  const parameters = new URLSearchParams({ q: query, limit: "20", offset: String(offset) });
  if (filters.spaceId) parameters.set("space", filters.spaceId);
  for (const tagId of filters.tagIds) parameters.append("tag", tagId);
  if (filters.creatorId) parameters.set("creator", filters.creatorId);
  if (filters.kind) parameters.set("kind", filters.kind);
  if (filters.updatedFrom) parameters.set("updatedFrom", timestampForDate(filters.updatedFrom));
  if (filters.updatedTo) parameters.set("updatedTo", timestampForDate(filters.updatedTo, true));
  if (filters.hasComments) parameters.set("hasComments", filters.hasComments);
  if (filters.archive !== "active") parameters.set("archive", filters.archive);
  return parameters;
}

function persistSearch(query: string, filters: UiFilters) {
  const parameters = requestParameters(query, filters, 0);
  parameters.delete("limit");
  parameters.delete("offset");
  parameters.set("view", "search");
  window.history.replaceState(null, "", `${window.location.pathname}?${parameters}`);
}

function sourceLabel(source: SearchResult["snippet"]["source"]) {
  return {
    title: "Title",
    tag: "Tag",
    body: "Page",
    comment: "Comment",
    attachment: "Attachment",
  }[source];
}

export function SearchView({
  spaces,
  tags,
  onSelect,
}: {
  spaces: Space[];
  tags: Tag[];
  onSelect: (id: string) => void;
}) {
  const [initial] = useState(initialSearchState);
  const [query, setQuery] = useState(initial.query);
  const [filters, setFilters] = useState(initial.filters);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(Boolean(initial.query.trim()));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [members, setMembers] = useState<SearchMember[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ members: SearchMember[] }>("/api/members", { signal: controller.signal })
      .then((response) => setMembers(response.members))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    persistSearch(query, filters);
  }, [filters, query]);

  useEffect(() => {
    const controller = new AbortController();
    if (!query.trim()) return () => controller.abort();
    const timer = window.setTimeout(() => {
      const parameters = requestParameters(query, filters, offset);
      parameters.set("retry", String(revision));
      void api<SearchResponse>(`/api/search?${parameters}`, { signal: controller.signal })
        .then((response) => {
          setResults((current) => (offset ? [...current, ...response.results] : response.results));
          setHasMore(response.hasMore);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Search could not be completed."));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, offset, query, revision]);

  function updateFilters(update: (current: UiFilters) => UiFilters) {
    setFilters(update);
    setOffset(0);
    setResults([]);
    setLoading(Boolean(query.trim()));
    setError("");
  }

  const selectedTags = filters.tagIds.flatMap((id) => {
    const tag = tags.find((candidate) => candidate.id === id);
    return tag ? [tag] : [];
  });
  const chips = [
    ...(filters.spaceId
      ? [
          {
            key: "space",
            label: `Space: ${spaces.find((space) => space.id === filters.spaceId)?.name ?? "Unavailable"}`,
            remove: () => updateFilters((current) => ({ ...current, spaceId: "" })),
          },
        ]
      : []),
    ...selectedTags.map((tag) => ({
      key: `tag:${tag.id}`,
      label: `Tag: ${tag.name}`,
      remove: () =>
        updateFilters((current) => ({ ...current, tagIds: current.tagIds.filter((id) => id !== tag.id) })),
    })),
    ...(filters.creatorId
      ? [
          {
            key: "creator",
            label: `Creator: ${members.find((member) => member.id === filters.creatorId)?.name ?? "Member"}`,
            remove: () => updateFilters((current) => ({ ...current, creatorId: "" })),
          },
        ]
      : []),
    ...(filters.kind
      ? [
          {
            key: "kind",
            label: filters.kind === "document" ? "Documents" : "Tables",
            remove: () => updateFilters((current) => ({ ...current, kind: "" })),
          },
        ]
      : []),
    ...(filters.hasComments
      ? [
          {
            key: "comments",
            label: filters.hasComments === "true" ? "Has comments" : "No comments",
            remove: () => updateFilters((current) => ({ ...current, hasComments: "" })),
          },
        ]
      : []),
    ...(filters.archive !== "active"
      ? [
          {
            key: "archive",
            label: filters.archive === "archived" ? "Archived only" : "Active + archived",
            remove: () => updateFilters((current) => ({ ...current, archive: "active" })),
          },
        ]
      : []),
  ];

  return (
    <main className="utility-view search-view">
      <p className="eyebrow">Workspace search</p>
      <h1>Find anything</h1>
      <input
        className="search-input"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setOffset(0);
          setResults([]);
          setHasMore(false);
          setLoading(Boolean(value.trim()));
          setError("");
        }}
        placeholder="Search titles, pages, comments, tags, and attachments…"
        aria-label="Search workspace"
        autoFocus
      />
      <details className="search-filters">
        <summary>Filters{chips.length ? ` · ${chips.length}` : ""}</summary>
        <div className="search-filter-grid">
          <label>
            Space
            <select
              value={filters.spaceId}
              onChange={(event) => updateFilters((current) => ({ ...current, spaceId: event.target.value }))}
            >
              <option value="">All accessible spaces</option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tag
            <select
              value=""
              onChange={(event) => {
                const id = event.target.value;
                if (id && !filters.tagIds.includes(id)) {
                  updateFilters((current) => ({ ...current, tagIds: [...current.tagIds, id] }));
                }
              }}
            >
              <option value="">Add a tag…</option>
              {tags
                .filter((tag) => !filters.tagIds.includes(tag.id))
                .map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Creator
            <select
              value={filters.creatorId}
              onChange={(event) => updateFilters((current) => ({ ...current, creatorId: event.target.value }))}
            >
              <option value="">Anyone</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Page type
            <select
              value={filters.kind}
              onChange={(event) =>
                updateFilters((current) => ({ ...current, kind: event.target.value as UiFilters["kind"] }))
              }
            >
              <option value="">Documents and tables</option>
              <option value="document">Documents</option>
              <option value="table">Tables</option>
            </select>
          </label>
          <label>
            Updated after
            <input
              type="date"
              value={filters.updatedFrom}
              onChange={(event) => updateFilters((current) => ({ ...current, updatedFrom: event.target.value }))}
            />
          </label>
          <label>
            Updated before
            <input
              type="date"
              value={filters.updatedTo}
              onChange={(event) => updateFilters((current) => ({ ...current, updatedTo: event.target.value }))}
            />
          </label>
          <label>
            Comments
            <select
              value={filters.hasComments}
              onChange={(event) =>
                updateFilters((current) => ({
                  ...current,
                  hasComments: event.target.value as UiFilters["hasComments"],
                }))
              }
            >
              <option value="">Any</option>
              <option value="true">Has comments</option>
              <option value="false">No comments</option>
            </select>
          </label>
          <label>
            Archive
            <select
              value={filters.archive}
              onChange={(event) =>
                updateFilters((current) => ({ ...current, archive: event.target.value as SearchArchiveState }))
              }
            >
              <option value="active">Active only</option>
              <option value="archived">Archived only</option>
              <option value="all">Active and archived</option>
            </select>
          </label>
        </div>
      </details>
      {chips.length > 0 && (
        <div className="search-filter-chips" aria-label="Active search filters">
          {chips.map((chip) => (
            <button key={chip.key} onClick={chip.remove} aria-label={`Remove ${chip.label}`}>
              {chip.label} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      <div className="search-results" aria-live="polite" aria-busy={loading}>
        {results.map((result) => (
          <button key={result.page.id} onClick={() => onSelect(result.page.id)}>
            <span className="search-result-breadcrumb">
              {result.space.icon ?? "◫"} {result.space.name} / {result.page.kind === "table" ? "Table" : "Page"}
              {result.page.archivedAt ? " / Archived" : ""}
            </span>
            <strong>
              {result.page.icon ? `${result.page.icon} ` : ""}
              {result.page.title}
            </strong>
            <span>
              <b>{sourceLabel(result.snippet.source)}</b> · {result.snippet.text}
            </span>
          </button>
        ))}
        {loading && <p className="empty-copy">Searching…</p>}
        {error && (
          <div className="search-error" role="alert">
            <span>{error}</span>
            <button
              className="quiet-button"
              onClick={() => {
                setLoading(true);
                setError("");
                setRevision((current) => current + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !error && query.trim() && !results.length && <p className="empty-copy">No matching pages.</p>}
        {!loading && hasMore && (
          <button
            className="search-load-more"
            onClick={() => {
              setLoading(true);
              setOffset(results.length);
            }}
          >
            Load more
          </button>
        )}
      </div>
    </main>
  );
}
