import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_ACTIONS,
  type AiConversation,
  type AiFunding,
  type AiGenerate,
  type AiMessage,
  type AiQuality,
  type AiSource,
  type AiStatus,
} from "../shared/ai";
import type { Page } from "../shared/types";
import { ApiClientError, api, apiErrorMessage, json } from "./api";
import { streamWriting } from "./writing-api";
import { targetSource, WritingTargetError, type WritingTarget } from "./writing-target";
import { WritingPreview } from "./WritingPreview";
import { WritingSources } from "./WritingSources";
import { WritingHistory } from "./WritingHistory";
import { parseAiMarkdown } from "../shared/ai-writing";

export function WritingPanel({
  pageId,
  initialTarget,
  conversationId,
  onCapture,
  onApply,
  onClose,
  editable,
  ready,
  subscribeReadiness,
}: {
  pageId: string;
  initialTarget: WritingTarget;
  conversationId?: string;
  onCapture: (kind?: WritingTarget["kind"]) => WritingTarget;
  onApply: (
    target: WritingTarget,
    markdown: string,
    mode: "replace" | "insert",
    epoch: number,
    protectedIds: ReadonlySet<string>,
  ) => void;
  onClose: () => void;
  editable: boolean;
  ready: () => boolean;
  subscribeReadiness?: (update: () => void) => () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null),
    [pages, setPages] = useState<Page[]>([]),
    [sources, setSources] = useState<AiSource[]>([targetSource(initialTarget, pageId)]);
  const [funding, setFunding] = useState<AiFunding | null>(null),
    [quality, setQuality] = useState<AiQuality>("fast"),
    [action, setAction] = useState<AiGenerate["action"]>("rewrite"),
    [prompt, setPrompt] = useState(""),
    [tone, setTone] = useState("Professional"),
    [targetLanguage, setTargetLanguage] = useState("");
  const [threadId, setThreadId] = useState<string | undefined>(undefined),
    [messages, setMessages] = useState<AiMessage[]>([]),
    [result, setResult] = useState(""),
    [resultState, setResultState] = useState<"empty" | "running" | "complete" | "partial">("empty"),
    [messageId, setMessageId] = useState("");
  const [resultTarget, setResultTarget] = useState<WritingTarget | null>(null);
  const [target, setTarget] = useState<WritingTarget | null>(initialTarget),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [historyOpen, setHistoryOpen] = useState(false),
    [locked, setLocked] = useState(false),
    [applying, setApplying] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const controller = useRef<AbortController | null>(null),
    activeId = useRef<string | null>(null),
    mounted = useRef(true);
  const [availability, setAvailability] = useState<{ funding: AiFunding; fast: boolean; best: boolean } | null>(null);
  const [synced, setSynced] = useState(() => ready());
  useEffect(() => {
    const update = () => setSynced(ready());
    const unsubscribe = subscribeReadiness?.(update);
    const timer = setInterval(update, 250);
    return () => {
      unsubscribe?.();
      clearInterval(timer);
    };
  }, [ready, subscribeReadiness]);
  const [resultSources, setResultSources] = useState<AiMessage["sources"]>([]);
  const formatError = useMemo(() => {
    if (resultState !== "complete" || !result) return "";
    try {
      parseAiMarkdown(result);
      return "";
    } catch (cause) {
      return apiErrorMessage(cause, "The result cannot be safely applied. Copy or refine it.");
    }
  }, [result, resultState]);
  const configuredFast = funding ? status?.settings?.models[funding].fast.id : "";
  const configuredBest = funding ? status?.settings?.models[funding].best.id : "";
  useEffect(() => {
    if (!funding || (!configuredFast && !configuredBest)) return undefined;
    const abort = new AbortController();
    void api<{ fast: boolean; best: boolean }>(`/api/ai/models?funding=${funding}`, { signal: abort.signal })
      .then((value) => {
        setAvailability({ ...value, funding });
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(apiErrorMessage(cause, "Model access could not be checked."));
      });
    return () => abort.abort();
  }, [funding, configuredFast, configuredBest]);
  useEffect(() => {
    if (!threadId) return undefined;
    const abort = new AbortController();
    const check = () => {
      void api<{ locked: boolean }>(`/api/ai/conversations/${threadId}/access`, { signal: abort.signal })
        .then((value) => {
          if (value.locked) {
            setLocked(true);
            setResult("");
            setMessages([]);
          }
        })
        .catch((cause) => {
          if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) {
            setLocked(true);
            setResult("");
            setMessages([]);
            setError("This conversation is unavailable or expired.");
          }
        });
    };
    const timer = setInterval(check, 5000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      abort.abort();
    };
  }, [threadId]);
  function chooseFunding(value: AiFunding) {
    setFunding(value);
    setError("");
    void api("/api/ai/preference", { method: "POST", body: json({ funding: value }) }).catch((cause) =>
      setError(apiErrorMessage(cause, "Funding is selected for this request but could not be remembered.")),
    );
  }
  const refreshStatus = useCallback(async () => {
    const value = await api<AiStatus>("/api/ai/status");
    if (mounted.current) {
      setStatus(value);
      setFunding(
        (current) => current ?? value.preference ?? (value.connected && value.chatgptConfigured ? "chatgpt" : null),
      );
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshStatus().catch((cause) => setError(apiErrorMessage(cause, "Writing is unavailable.")));
    void api<{ pages: Page[] }>("/api/pages/tree")
      .then((value) => {
        if (mounted.current) setPages(value.pages);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (activeId.current)
        void api(`/api/ai/generations/${activeId.current}/cancel`, { method: "POST" }).catch(() => undefined);
    };
  }, [refreshStatus]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const open = useCallback(
    async (id: string) => {
      try {
        const { conversation } = await api<{ conversation: AiConversation }>(`/api/ai/conversations/${id}/open`, {
          method: "POST",
        });
        setLocked(conversation.locked);
        setThreadId(conversation.id);
        setHistoryOpen(false);
        setError("");
        setTarget(null);
        setResultTarget(null);
        if (conversation.locked) {
          setMessages([]);
          setResult("");
          setResultState("empty");
          return;
        }
        setSources(conversation.sources ?? [{ pageId, scope: { kind: "page" } }]);
        setMessages(conversation.messages ?? []);
        const latest = conversation.messages?.at(-1);
        setResult(latest?.output ?? "");
        setResultState(latest?.status === "complete" ? "complete" : latest?.output ? "partial" : "empty");
        setMessageId(latest?.id ?? "");
        setResultSources(latest?.sources ?? []);
        setNotice(
          "Saved result opened. Choose a current insertion location to use it, or generate again from the latest sources.",
        );
      } catch (cause) {
        setError(apiErrorMessage(cause, "The conversation could not be opened."));
      }
    },
    [pageId],
  );
  useEffect(() => {
    if (conversationId) {
      void Promise.resolve().then(() => open(conversationId));
    }
  }, [conversationId, open]);
  function captureSelection() {
    const current = onCapture();
    if (current.kind !== "selection" || !current.text) {
      setError("Select text in the document first.");
      return;
    }
    setTarget(current);
    setSources((items) => items.map((source) => (source.pageId === pageId ? targetSource(current, pageId) : source)));
    setError("");
  }
  async function generate() {
    if (!funding) {
      setError("Choose ChatGPT plan or workspace API funding before generating.");
      return;
    }
    if (!online || !ready()) {
      setError("Wait for the document to finish syncing and a network connection before generating.");
      return;
    }
    const nextTarget = target?.kind === "page" || !target ? onCapture("page") : target;
    setTarget(nextTarget);
    setResultTarget(nextTarget);
    setError("");
    setNotice("");
    setLocked(false);
    setResult("");
    setResultState("running");
    const abort = new AbortController(),
      operationId = crypto.randomUUID();
    controller.current = abort;
    activeId.current = operationId;
    let output = "",
      terminal = false,
      savedThread = threadId;
    try {
      await streamWriting(
        {
          operationId,
          ...(threadId ? { conversationId: threadId } : {}),
          pageId,
          action,
          prompt,
          ...(action === "translate" ? { targetLanguage } : {}),
          ...(action === "change_tone" ? { tone } : {}),
          funding,
          quality,
          sources,
        },
        abort.signal,
        (event) => {
          if (!mounted.current) return;
          if (event.type === "start") {
            savedThread = event.conversationId;
            setThreadId(event.conversationId);
            setMessageId(event.messageId);
            setResultSources(event.sources);
            setStatus((current) => (current ? { ...current, quota: event.quota } : null));
            if (event.changedPageIds.length) setNotice("Some sources changed. This result uses their latest contents.");
          } else if (event.type === "delta") {
            output += event.text;
            setResult(output);
          } else if (event.type === "complete") {
            terminal = true;
            setResultState("complete");
          } else {
            terminal = true;
            setResultState("partial");
            setError(event.message);
            if (event.code === "conversation_locked" || event.code === "unauthorized") {
              setLocked(true);
              output = "";
              setResult("");
              setMessages([]);
            }
          }
        },
      );
    } catch (cause) {
      if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) {
        setLocked(true);
        output = "";
        setResult("");
        setMessages([]);
      }
      if (mounted.current && !abort.signal.aborted)
        setError(apiErrorMessage(cause, "Generation failed. Retry explicitly."));
    } finally {
      activeId.current = null;
      controller.current = null;
      if (mounted.current) {
        if (!terminal) {
          setResultState(output ? "partial" : "empty");
          if (abort.signal.aborted) setNotice("Generation cancelled. Partial text can be copied.");
        }
        void refreshStatus().catch(() => undefined);
        if (savedThread && !abort.signal.aborted)
          void api<{ conversation: AiConversation }>(`/api/ai/conversations/${savedThread}`)
            .then(({ conversation }) => {
              if (mounted.current) {
                if (conversation.locked) {
                  setLocked(true);
                  setResult("");
                  setMessages([]);
                } else setMessages(conversation.messages ?? []);
              }
            })
            .catch(() => undefined);
      }
    }
  }
  async function cancel() {
    const id = activeId.current;
    controller.current?.abort();
    if (id) await api(`/api/ai/generations/${id}/cancel`, { method: "POST" }).catch(() => undefined);
  }
  async function apply(mode: "replace" | "insert") {
    if (!target || resultState !== "complete" || !editable || (mode === "replace" && target !== resultTarget)) return;
    setApplying(true);
    setError("");
    try {
      const check = await api<{ contentEpoch: number; protectedBlockIds: string[] }>(
        `/api/ai/results/${messageId}/apply-check`,
        { method: "POST", body: json({}) },
      );
      onApply(target, result, mode, check.contentEpoch, new Set(check.protectedBlockIds));
      setNotice(`Result ${mode === "insert" ? "inserted" : "applied"}. Use the document's Undo to reverse it.`);
      setTarget(null);
    } catch (cause) {
      setError(
        cause instanceof WritingTargetError
          ? cause.message
          : apiErrorMessage(cause, "The result could not be applied."),
      );
    } finally {
      setApplying(false);
    }
  }
  const running = resultState === "running";
  const modeAvailable =
    funding &&
    !!status?.settings?.models[funding][quality].id &&
    availability?.funding === funding &&
    availability?.[quality];
  const currentScope = sources.find((source) => source.pageId === pageId)?.scope;
  const replaceScopeMatches =
    (target?.kind === "page" && currentScope?.kind === "page") ||
    (target?.kind === "selection" && currentScope?.kind === "selection" && target.text === currentScope.text);
  return (
    <aside className="writing-panel" aria-label="AI writing">
      <div className="writing-panel-heading">
        <h2>Writing</h2>
        <button aria-label="Close writing" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">Private writing workspace. Review results before applying them.</p>
      {!online && <output aria-live="polite">Writing and history need a network connection.</output>}
      {online && !synced && <output aria-live="polite">Waiting for the document to finish syncing…</output>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <output aria-live="polite">{notice}</output>}
      {locked ? (
        <p>Access to a referenced page is unavailable. This conversation is locked until access returns.</p>
      ) : (
        <>
          <fieldset disabled={running}>
            <legend>Funding</legend>
            <label>
              <input
                type="radio"
                name="writing-funding"
                checked={funding === "chatgpt"}
                disabled={!status?.connected || !status.chatgptConfigured}
                onChange={() => chooseFunding("chatgpt")}
              />
              ChatGPT plan
            </label>
            <label>
              <input
                type="radio"
                name="writing-funding"
                checked={funding === "api"}
                disabled={!status?.apiConfigured || !status.settings.apiEnabled}
                onChange={() => chooseFunding("api")}
              />
              Workspace API
            </label>
            {funding === "api" && status && (
              <p>
                {status.quota.remaining} of {status.quota.limit} API requests remaining. Resets{" "}
                {new Date(status.quota.resetsAt).toLocaleString()}.
              </p>
            )}
            <p className="muted">Funding never switches automatically. Connect ChatGPT in Settings.</p>
          </fieldset>
          <label>
            Quality
            <select
              value={quality}
              disabled={running}
              onChange={(event) => setQuality(event.target.value as AiQuality)}
            >
              {(["fast", "best"] as const).map((mode) => (
                <option
                  key={mode}
                  value={mode}
                  disabled={
                    !funding ||
                    !status?.settings?.models[funding][mode].id ||
                    availability?.funding !== funding ||
                    !availability?.[mode]
                  }
                >
                  {mode === "fast" ? "Fast" : "Best"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Writing action
            <select
              value={action}
              disabled={running}
              onChange={(event) => setAction(event.target.value as AiGenerate["action"])}
            >
              {Object.entries(AI_ACTIONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {action === "translate" && (
            <label>
              Target language
              <input
                value={targetLanguage}
                disabled={running}
                onChange={(event) => setTargetLanguage(event.target.value)}
              />
            </label>
          )}
          {action === "change_tone" && (
            <label>
              Target tone
              <input value={tone} disabled={running} onChange={(event) => setTone(event.target.value)} />
            </label>
          )}
          <label>
            {messages.length ? "Follow-up instruction" : "Writing instruction"}
            <textarea
              value={prompt}
              disabled={running}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what you want, or use a preset action"
            />
          </label>
          <WritingSources
            sources={sources}
            pages={pages}
            pageId={pageId}
            onChange={setSources}
            onSelection={captureSelection}
            disabled={running}
          />
          <div className="writing-actions">
            {running ? (
              <button onClick={() => void cancel()}>Cancel generation</button>
            ) : (
              <button
                disabled={
                  !online ||
                  !synced ||
                  !status?.settings?.enabled ||
                  !modeAvailable ||
                  applying ||
                  (funding === "api" && !status?.quota.remaining)
                }
                onClick={() => void generate()}
              >
                {messages.length ? "Generate follow-up" : "Generate"}
              </button>
            )}
            {!running && result && (
              <button disabled={!online || !synced || !modeAvailable} onClick={() => void generate()}>
                Regenerate
              </button>
            )}
          </div>
          {result && (
            <>
              <output aria-live="polite">
                {resultState === "running"
                  ? "Generating…"
                  : resultState === "partial"
                    ? "Partial result — copy only"
                    : "Complete result"}
              </output>
              <WritingPreview markdown={result} />
              {formatError && <p className="form-error">{formatError}</p>}
              {!!resultSources.length && (
                <div aria-label="Result sources">
                  <strong>Sources</strong>
                  <ul>
                    {resultSources.map((source) => (
                      <li key={source.pageId}>
                        <a href={source.url}>{source.title}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="writing-actions">
                <button
                  disabled={
                    resultState !== "complete" ||
                    !!formatError ||
                    !editable ||
                    !replaceScopeMatches ||
                    target !== resultTarget ||
                    !target ||
                    target.kind === "anchor" ||
                    applying
                  }
                  onClick={() => void apply("replace")}
                >
                  Replace
                </button>
                <button
                  disabled={resultState !== "complete" || !!formatError || !editable || !target || applying}
                  onClick={() => void apply("insert")}
                >
                  Insert
                </button>
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(result)
                      .then(() => setNotice("Result copied."))
                      .catch(() => setError("Copy failed. Select the result text and copy it manually."))
                  }
                >
                  Copy
                </button>
                <button
                  disabled={running}
                  onClick={() => {
                    setResult("");
                    setResultState("empty");
                  }}
                >
                  Discard
                </button>
                {editable && resultState === "complete" && (
                  <button
                    onClick={() => {
                      setTarget(onCapture("anchor"));
                      setNotice("Insertion location selected from the current document cursor.");
                    }}
                  >
                    Choose current cursor for insertion
                  </button>
                )}
              </div>
            </>
          )}
          {!!messages.length && (
            <details>
              <summary>Conversation ({messages.length} requests)</summary>
              {messages.map((message) => (
                <article key={message.id}>
                  <h3>
                    {AI_ACTIONS[message.action]} · {message.funding === "api" ? "Workspace API" : "ChatGPT plan"} ·{" "}
                    {message.quality === "fast" ? "Fast" : "Best"}
                  </h3>
                  <p>{message.prompt}</p>
                  <WritingPreview markdown={message.output} />
                  <small>{message.status === "complete" ? "Complete" : "Partial — copy only"}</small>
                  <ul>
                    {message.sources.map((source) => (
                      <li key={source.pageId}>
                        <a href={source.url}>{source.title}</a>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      <div className="writing-actions">
        <button
          disabled={running}
          onClick={() => {
            setThreadId(undefined);
            setResultTarget(null);
            setMessages([]);
            setResult("");
            setResultState("empty");
            setLocked(false);
            const current = onCapture("page");
            setTarget(current);
            setSources([targetSource(current, pageId)]);
            setNotice("");
            setError("");
          }}
        >
          New conversation
        </button>
        <button disabled={running} onClick={() => setHistoryOpen((value) => !value)}>
          Document writing history
        </button>
      </div>
      {historyOpen && <WritingHistory pageId={pageId} onOpen={(conversation) => void open(conversation.id)} />}
    </aside>
  );
}
