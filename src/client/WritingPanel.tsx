import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AI_ACTIONS,
  AI_GENERATION_DEADLINE_MS,
  aiGenerateSchema,
  type AiConversation,
  type AiConversationAccess,
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
import { targetSource, WritingTargetError, type WritingTarget, type WritingLaunchRequest } from "./writing-target";
import { WritingPreview, useWritingMarkdown } from "./WritingPreview";
import { WritingSources } from "./WritingSources";
import { WritingHistory } from "./WritingHistory";

type RestoredDraft = {
  conversationId: string;
  failedMessageId: string;
  messageId: string;
  output: string;
  complete: boolean;
  sources: AiMessage["sources"];
};
function matchesRestoredDraft(conversation: AiConversation, restored: RestoredDraft | null) {
  if (!restored || restored.conversationId !== conversation.id) return false;
  const latest = conversation.messages?.at(-1);
  const saved = conversation.messages?.find((message) => message.id === restored.messageId);
  return (
    latest?.id === restored.failedMessageId &&
    latest.status === "failed" &&
    !latest.output &&
    saved?.output === restored.output &&
    (saved.status === "complete") === restored.complete &&
    JSON.stringify(saved.sources) === JSON.stringify(restored.sources)
  );
}

const HistoryMessage = memo(
  function HistoryMessage({ message }: { message: AiMessage }) {
    return (
      <article>
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
    );
  },
  (previous, next) => {
    const a = previous.message,
      b = next.message;
    if (a === b) return true;
    return (
      a.output === b.output &&
      a.prompt === b.prompt &&
      a.action === b.action &&
      a.funding === b.funding &&
      a.quality === b.quality &&
      a.status === b.status &&
      JSON.stringify(a.sources) === JSON.stringify(b.sources)
    );
  },
);

export function WritingPanel({
  pageId,
  initialTarget,
  launchRequest,
  visible = true,
  onBusyChange,
  onCapture,
  onApply,
  onClose,
  editable,
  ready,
  subscribeReadiness,
}: {
  pageId: string;
  initialTarget: WritingTarget;
  launchRequest?: WritingLaunchRequest;
  visible?: boolean;
  onBusyChange?: (busy: boolean) => void;
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
  const [threadId, setThreadId] = useState<string | undefined>(),
    [messages, setMessages] = useState<AiMessage[]>([]),
    [result, setResult] = useState(""),
    [resultState, setResultState] = useState<"empty" | "running" | "complete" | "partial">("empty"),
    [messageId, setMessageId] = useState("");
  const [resultTarget, setResultTarget] = useState<WritingTarget | null>(null),
    [target, setTarget] = useState<WritingTarget | null>(initialTarget),
    [error, setError] = useState(""),
    [accessError, setAccessError] = useState(""),
    [modelError, setModelError] = useState(""),
    [notice, setNotice] = useState(""),
    [historyOpen, setHistoryOpen] = useState(false),
    [locked, setLocked] = useState(false),
    [unavailable, setUnavailable] = useState(false),
    [applying, setApplying] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [foreground, setForeground] = useState(!document.hidden),
    [checkingAccess, setCheckingAccess] = useState(false),
    [accessPending, setAccessPending] = useState(false),
    [modelPending, setModelPending] = useState(false),
    [remoteGeneration, setRemoteGeneration] = useState<AiConversationAccess["activeGeneration"]>(null);
  const controller = useRef<AbortController | null>(null),
    activeId = useRef<string | null>(null),
    mounted = useRef(true),
    operation = useRef<"generate" | "apply" | null>(null),
    remoteId = useRef<string | null>(null),
    outputBuffer = useRef(""),
    displayTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    visibleRef = useRef(visible),
    handledLaunch = useRef<string | undefined>(undefined),
    loadRevision = useRef(0),
    statusRequest = useRef<Promise<void> | null>(null),
    accessGate = useRef({ visible, foreground, refresh: false }),
    retryAccess = useRef<(() => void) | null>(null),
    restoredDraft = useRef<RestoredDraft | null>(null),
    historyHidden = useRef(false),
    latestMessageId = useRef("");
  const [availability, setAvailability] = useState<{
      funding: AiFunding;
      fast: boolean;
      best: boolean;
      attempt: number;
    } | null>(null),
    [modelCheck, setModelCheck] = useState(0),
    [synced, setSynced] = useState(() => ready()),
    [resultSources, setResultSources] = useState<AiMessage["sources"]>([]);
  const parsed = useWritingMarkdown(visible && !checkingAccess ? result : "");
  const formatError = resultState === "complete" && result ? parsed.error : "";
  const running = resultState === "running" || !!remoteGeneration;
  const busy = running || applying;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const flushResult = useCallback(() => {
    if (displayTimer.current !== null) clearTimeout(displayTimer.current);
    displayTimer.current = null;
    if (mounted.current) setResult(outputBuffer.current);
  }, []);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (visible) flushResult();
    else if (displayTimer.current !== null) {
      clearTimeout(displayTimer.current);
      displayTimer.current = null;
    }
    const previous = accessGate.current;
    const refresh = !!(visible && foreground && threadId && (!previous.visible || !previous.foreground));
    if (refresh) setCheckingAccess(true);
    accessGate.current = { visible, foreground, refresh: previous.refresh || refresh };
  }, [visible, foreground, threadId, flushResult]);
  useEffect(() => {
    if (!visible) return undefined;
    const update = () => setSynced(ready());
    update();
    return subscribeReadiness?.(update);
  }, [ready, subscribeReadiness, visible]);
  const configuredFast = funding ? status?.settings.models[funding].fast.id : "";
  const configuredBest = funding ? status?.settings.models[funding].best.id : "";
  useEffect(() => {
    if (!visible || !funding || (!configuredFast && !configuredBest)) return undefined;
    const abort = new AbortController();
    setModelPending(true);
    setAvailability(null);
    setModelError("");
    void api<{ fast: boolean; best: boolean }>(`/api/ai/models?funding=${funding}`, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) {
          setAvailability({ ...value, funding, attempt: modelCheck });
          setModelError("");
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setModelError(apiErrorMessage(cause, "Model access could not be checked."));
      })
      .finally(() => {
        if (!abort.signal.aborted) setModelPending(false);
      });
    return () => abort.abort();
  }, [visible, funding, configuredFast, configuredBest, modelCheck]);
  function chooseFunding(value: AiFunding) {
    if (operation.current || remoteId.current) return;
    setFunding(value);
    setError("");
    setModelCheck((attempt) => attempt + 1);
    void api("/api/ai/preference", { method: "POST", body: json({ funding: value }) }).catch((cause) =>
      setError(apiErrorMessage(cause, "Funding is selected for this request but could not be remembered.")),
    );
  }
  const refreshStatus = useCallback(() => {
    if (statusRequest.current) return statusRequest.current;
    const request = api<AiStatus>("/api/ai/status")
      .then((value) => {
        if (mounted.current) {
          setStatus(value);
          setFunding(
            (current) => current ?? value.preference ?? (value.connected && value.chatgptConfigured ? "chatgpt" : null),
          );
        }
      })
      .finally(() => {
        if (statusRequest.current === request) statusRequest.current = null;
      });
    statusRequest.current = request;
    return request;
  }, []);
  const quotaResetsAt = status?.quota.resetsAt;
  useEffect(() => {
    if (!visible || !foreground || !online || quotaResetsAt === undefined) return undefined;
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      const delay = quotaResetsAt - Date.now();
      if (delay > 0) {
        timer = setTimeout(() => void check(), delay);
        return;
      }
      inFlight = true;
      await refreshStatus().catch(() => undefined);
      inFlight = false;
      if (!disposed) timer = setTimeout(() => void check(), 5000);
    };
    void check();
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [visible, foreground, online, quotaResetsAt, refreshStatus]);
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate whichever conversation reads are pending at disposal.
      loadRevision.current++;
      if (displayTimer.current !== null) clearTimeout(displayTimer.current);
      controller.current?.abort();
      const disposedOperation = activeId.current;
      if (disposedOperation)
        void api(`/api/ai/generations/${disposedOperation}/cancel`, { method: "POST" }).catch(() => undefined);
    };
  }, [refreshStatus]);
  useEffect(() => {
    const update = () => {
        setOnline(navigator.onLine);
        if (visible) setSynced(ready());
      },
      visibility = () => setForeground(!document.hidden);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [ready, visible]);
  const clearPrivateContent = useCallback(() => {
    loadRevision.current++;
    controller.current?.abort();
    historyHidden.current = true;
    restoredDraft.current = null;
    outputBuffer.current = "";
    setResult("");
    setMessages([]);
    setHistoryOpen(false);
    setResultSources([]);
    setResultTarget(null);
    setMessageId("");
    latestMessageId.current = "";
    setResultState("empty");
    setCheckingAccess(false);
    setAccessPending(false);
    remoteId.current = null;
    setRemoteGeneration(null);
    if (displayTimer.current !== null) clearTimeout(displayTimer.current);
    displayTimer.current = null;
  }, []);
  const accessFailure = useCallback(
    (cause: unknown) => {
      if (!(cause instanceof ApiClientError)) return false;
      if (cause.status === 401) {
        clearPrivateContent();
        return true;
      }
      if (cause.code === "conversation_not_found") {
        setUnavailable(true);
        clearPrivateContent();
        return true;
      } else if (["conversation_locked", "page_not_found", "space_not_found"].includes(cause.code)) {
        setLocked(true);
        clearPrivateContent();
        return true;
      }
      return false;
    },
    [clearPrivateContent],
  );
  const open = useCallback(
    async (id: string, touch = true, preserveTarget = false) => {
      if (operation.current || (touch && remoteId.current)) {
        if (touch) setNotice("Finish or cancel the current operation before changing its source.");
        return;
      }
      const revision = ++loadRevision.current;
      if (touch) restoredDraft.current = null;
      setCheckingAccess(true);
      setAccessPending(true);
      setAccessError("");
      try {
        const { conversation } = await api<{ conversation: AiConversation }>(
          `/api/ai/conversations/${id}${touch ? "/open" : ""}`,
          touch ? { method: "POST" } : undefined,
        );
        if (!mounted.current || revision !== loadRevision.current) return;
        setLocked(conversation.locked);
        setUnavailable(false);
        setThreadId(conversation.id);
        if (touch) {
          setHistoryOpen(false);
          setError("");
        }
        if (!preserveTarget) {
          setTarget(null);
          setResultTarget(null);
          setSources(conversation.sources ?? [{ pageId, scope: { kind: "page" } }]);
        }
        if (conversation.locked) {
          clearPrivateContent();
          return;
        }
        if (!touch) setAccessError("");
        const latest = conversation.messages?.at(-1);
        const restored = restoredDraft.current;
        const keepDraft = preserveTarget && matchesRestoredDraft(conversation, restored);
        if (!keepDraft) restoredDraft.current = null;
        if (preserveTarget && (latest?.id !== latestMessageId.current || (restored && !keepDraft))) {
          setTarget(null);
          setResultTarget(null);
        }
        historyHidden.current = false;
        latestMessageId.current = latest?.id ?? "";
        setMessages(conversation.messages ?? []);
        if (!keepDraft) {
          outputBuffer.current = latest?.output ?? "";
          flushResult();
          setResultState(latest?.status === "complete" ? "complete" : latest?.output ? "partial" : "empty");
          setMessageId(latest?.id ?? "");
          setResultSources(latest?.sources ?? []);
        }
        const active =
          latest?.status === "running"
            ? {
                messageId: latest.id,
                createdAt: latest.createdAt,
                deadlineAt: latest.createdAt + AI_GENERATION_DEADLINE_MS,
              }
            : null;
        remoteId.current = active?.messageId ?? null;
        setRemoteGeneration(active);
        if (touch)
          setNotice(
            active
              ? "A saved generation is still running. Cancel it or wait for completion."
              : "Saved result opened. Choose a current insertion location to use it, or generate again from the latest sources.",
          );
      } catch (cause) {
        if (mounted.current && revision === loadRevision.current) {
          accessFailure(cause);
          if (touch) setError(apiErrorMessage(cause, "The conversation could not be opened."));
          else
            setAccessError(apiErrorMessage(cause, "Conversation access could not be checked. Retrying automatically."));
        }
      } finally {
        if (mounted.current && revision === loadRevision.current) {
          setCheckingAccess(false);
          setAccessPending(false);
        }
      }
    },
    [pageId, clearPrivateContent, flushResult, accessFailure],
  );
  useEffect(() => {
    const id = launchRequest?.id;
    if (!id || handledLaunch.current === id) return;
    handledLaunch.current = id;
    if (operation.current || remoteId.current) {
      setNotice("Finish or cancel the current operation before changing its source.");
      return;
    }
    const savedId = launchRequest?.conversationId;
    if (savedId) {
      void open(savedId);
      return;
    }
    if (launchRequest?.target) {
      const next = launchRequest.target;
      setTarget(next);
      setSources((items) => items.map((source) => (source.pageId === pageId ? targetSource(next, pageId) : source)));
    }
  }, [launchRequest, open, pageId]);
  useEffect(() => {
    if (!threadId || !visible || !foreground) return undefined;
    const abort = new AbortController();
    let inFlight = false,
      refreshRequested = false;
    const check = async (refresh = false) => {
      if (abort.signal.aborted) return;
      if (refresh) {
        refreshRequested = true;
        setCheckingAccess(true);
      }
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      const revision = loadRevision.current;
      setAccessPending(true);
      try {
        const value = await api<AiConversationAccess>(`/api/ai/conversations/${threadId}/access`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted || revision !== loadRevision.current) return;
        setAccessError("");
        const shouldRefresh = refreshRequested;
        refreshRequested = false;
        accessGate.current.refresh = false;
        if (value.locked) {
          setLocked(true);
          clearPrivateContent();
        } else {
          const wasRemote = !!remoteId.current;
          setLocked(false);
          setUnavailable(false);
          if (!controller.current) {
            remoteId.current = value.activeGeneration?.messageId ?? null;
            setRemoteGeneration(value.activeGeneration ?? null);
            if (
              !operation.current &&
              (shouldRefresh || historyHidden.current || (wasRemote && !value.activeGeneration))
            ) {
              await open(threadId, false, true);
              return;
            }
          }
        }
        if (!abort.signal.aborted && revision === loadRevision.current) setCheckingAccess(false);
      } catch (cause) {
        if (!abort.signal.aborted && revision === loadRevision.current) {
          if (accessFailure(cause)) setCheckingAccess(false);
          setAccessError(apiErrorMessage(cause, "Conversation access could not be checked. Retrying automatically."));
        }
      } finally {
        inFlight = false;
        if (!abort.signal.aborted && revision === loadRevision.current) setAccessPending(false);
      }
    };
    const retry = () => void check(true);
    retryAccess.current = retry;
    void check(accessGate.current.refresh);
    const timer = setInterval(() => void check(), 5000),
      focus = () => void check(true);
    window.addEventListener("focus", focus);
    return () => {
      abort.abort();
      if (retryAccess.current === retry) retryAccess.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [threadId, visible, foreground, open, clearPrivateContent, accessFailure]);
  function captureSelection() {
    if (operation.current || remoteId.current) return;
    const current = onCapture();
    if (current.kind !== "selection" || !current.text.trim()) {
      setError("Select text in the document first.");
      return;
    }
    setTarget(current);
    setSources((items) => items.map((source) => (source.pageId === pageId ? targetSource(current, pageId) : source)));
    setError("");
  }
  const modeAvailable =
    !!funding &&
    !!status?.settings.models[funding][quality].id &&
    availability?.funding === funding &&
    availability.attempt === modelCheck &&
    !!availability[quality];
  const modelLoading =
    !!funding &&
    !!(configuredFast || configuredBest) &&
    !modelError &&
    (modelPending || !availability || availability.funding !== funding || availability.attempt !== modelCheck);
  const validInstruction =
    !(["draft", "custom"].includes(action) && !prompt.trim()) &&
    !(action === "translate" && !targetLanguage.trim()) &&
    !(action === "change_tone" && !tone.trim());
  const canGenerate =
    online &&
    synced &&
    !!status?.settings.enabled &&
    modeAvailable &&
    validInstruction &&
    !busy &&
    !checkingAccess &&
    !locked &&
    !unavailable &&
    (funding === "api"
      ? !!status?.apiConfigured && status.settings.apiEnabled && status.quota.remaining > 0
      : !!status?.connected && status.chatgptConfigured);
  async function generate() {
    if (!canGenerate || operation.current || remoteId.current || !ready()) {
      setError("Check writing availability, funding, allowance and document sync before generating.");
      return;
    }
    const input = aiGenerateSchema.safeParse({
      operationId: crypto.randomUUID(),
      ...(threadId ? { conversationId: threadId } : {}),
      pageId,
      action,
      prompt,
      targetLanguage,
      tone,
      funding,
      quality,
      sources,
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? "Check the writing request.");
      return;
    }
    const previous = {
      result: outputBuffer.current,
      state: resultState,
      target: resultTarget,
      requestTarget: target,
      messageId,
      sources: resultSources,
    };
    restoredDraft.current = null;
    const nextTarget = target?.kind === "page" || !target ? onCapture("page") : target;
    const abort = new AbortController();
    const revision = ++loadRevision.current;
    operation.current = "generate";
    onBusyChange?.(true);
    controller.current = abort;
    activeId.current = input.data.operationId;
    setTarget(nextTarget);
    setResultTarget(nextTarget);
    setError("");
    setNotice("");
    outputBuffer.current = "";
    flushResult();
    setResultState("running");
    let terminal = false,
      terminalFailure = false,
      started = false,
      denied = false,
      savedThread = threadId;
    try {
      await streamWriting(input.data, abort.signal, (event) => {
        if (!mounted.current || revision !== loadRevision.current || abort.signal.aborted) return;
        if (event.type === "start") {
          started = true;
          savedThread = event.conversationId;
          setThreadId(event.conversationId);
          setMessageId(event.messageId);
          latestMessageId.current = event.messageId;
          setResultSources(event.sources);
          setStatus((current) => (current ? { ...current, quota: event.quota } : null));
          if (event.changedPageIds.length) setNotice("Some sources changed. This result uses their latest contents.");
        } else if (event.type === "delta") {
          outputBuffer.current += event.text;
          if (visibleRef.current && displayTimer.current === null) displayTimer.current = setTimeout(flushResult, 100);
        } else {
          terminal = true;
          flushResult();
          setResultState(event.type === "complete" ? "complete" : "partial");
          if (event.type === "error") {
            terminalFailure = true;
            setError(event.message);
            if (event.status === 401) {
              denied = true;
              clearPrivateContent();
            }
            if (event.code === "conversation_locked") {
              denied = true;
              setLocked(true);
              clearPrivateContent();
            }
          }
        }
      });
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current && !abort.signal.aborted) {
        denied = accessFailure(cause);
        setError(apiErrorMessage(cause, "Generation failed. Retry explicitly."));
      }
    } finally {
      activeId.current = null;
      controller.current = null;
      operation.current = null;
      onBusyChange?.(!!remoteId.current);
      if (mounted.current && revision === loadRevision.current) {
        if ((!started || (terminalFailure && !outputBuffer.current)) && !denied && !abort.signal.aborted) {
          outputBuffer.current = previous.result;
          setResultState(previous.state);
          setResultTarget(previous.target);
          setTarget(previous.requestTarget);
          setMessageId(previous.messageId);
          if (started && savedThread && previous.messageId && previous.result) {
            restoredDraft.current = {
              conversationId: savedThread,
              failedMessageId: latestMessageId.current,
              messageId: previous.messageId,
              output: previous.result,
              complete: previous.state === "complete",
              sources: previous.sources,
            };
          } else latestMessageId.current = previous.messageId;
          setResultSources(previous.sources);
        } else if (!terminal) {
          setResultState(outputBuffer.current ? "partial" : "empty");
          if (abort.signal.aborted) setNotice("Generation cancelled. Partial text can be copied.");
        }
        flushResult();
        void refreshStatus().catch(() => undefined);
        if (savedThread && !abort.signal.aborted)
          void api<{ conversation: AiConversation }>(`/api/ai/conversations/${savedThread}`)
            .then(({ conversation }) => {
              if (!mounted.current || revision !== loadRevision.current) return;
              if (conversation.locked) {
                setLocked(true);
                clearPrivateContent();
              } else {
                setMessages(conversation.messages ?? []);
                if (restoredDraft.current && !matchesRestoredDraft(conversation, restoredDraft.current)) {
                  restoredDraft.current = null;
                  const latest = conversation.messages?.at(-1);
                  latestMessageId.current = latest?.id ?? "";
                  outputBuffer.current = latest?.output ?? "";
                  flushResult();
                  setResultState(latest?.status === "complete" ? "complete" : latest?.output ? "partial" : "empty");
                  setMessageId(latest?.id ?? "");
                  setResultSources(latest?.sources ?? []);
                  setTarget(null);
                  setResultTarget(null);
                }
              }
            })
            .catch((cause) => {
              if (mounted.current && revision === loadRevision.current) accessFailure(cause);
            });
      }
    }
  }
  async function cancel() {
    if (operation.current === "apply") return;
    const id = activeId.current ?? remoteId.current;
    flushResult();
    controller.current?.abort();
    if (id) {
      try {
        await api(`/api/ai/generations/${id}/cancel`, { method: "POST" });
        if (remoteId.current && threadId) await open(threadId, false, true);
      } catch (cause) {
        setError(apiErrorMessage(cause, "Cancellation could not be confirmed. Retry explicitly."));
      }
    }
  }
  async function apply(mode: "replace" | "insert") {
    if (
      operation.current ||
      remoteId.current ||
      checkingAccess ||
      locked ||
      unavailable ||
      !target ||
      resultState !== "complete" ||
      formatError ||
      !editable ||
      (mode === "replace" && target !== resultTarget)
    )
      return;
    operation.current = "apply";
    const revision = loadRevision.current;
    setApplying(true);
    onBusyChange?.(true);
    setError("");
    try {
      const check = await api<{ contentEpoch: number; protectedBlockIds: string[] }>(
        `/api/ai/results/${messageId}/apply-check`,
        { method: "POST", body: json({}) },
      );
      if (!mounted.current || revision !== loadRevision.current) return;
      onApply(target, outputBuffer.current, mode, check.contentEpoch, new Set(check.protectedBlockIds));
      setNotice(`Result ${mode === "insert" ? "inserted" : "applied"}. Use the document's Undo to reverse it.`);
      setTarget(null);
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current) {
        accessFailure(cause);
        setError(
          cause instanceof WritingTargetError
            ? cause.message
            : apiErrorMessage(cause, "The result could not be applied."),
        );
      }
    } finally {
      operation.current = null;
      setApplying(false);
      onBusyChange?.(!!remoteId.current);
    }
  }
  const currentScope = sources.find((source) => source.pageId === pageId)?.scope;
  const replaceScopeMatches =
    (target?.kind === "page" && currentScope?.kind === "page") ||
    (target?.kind === "selection" && currentScope?.kind === "selection" && target.text === currentScope.text);
  if (!visible) return null;
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
      {(
        [
          ["operation", error],
          ["access", accessError],
          ["model", modelError],
        ] as const
      ).map(([kind, message]) =>
        message ? (
          <p key={kind} className="form-error" role="alert">
            {message}
          </p>
        ) : null,
      )}
      {notice && <output aria-live="polite">{notice}</output>}
      {accessError && threadId && !locked && !unavailable && (
        <button disabled={accessPending} onClick={() => retryAccess.current?.()}>
          Retry conversation access
        </button>
      )}
      {running && <button onClick={() => void cancel()}>Cancel generation</button>}
      {checkingAccess ? (
        <output aria-live="polite">
          {accessError && !accessPending ? "Conversation access is unverified." : "Checking conversation access…"}
        </output>
      ) : unavailable ? (
        <p>This conversation was deleted or expired. Start a new conversation.</p>
      ) : locked ? (
        <p>Access to a referenced page is unavailable. This conversation is locked until access returns.</p>
      ) : (
        <>
          <fieldset disabled={busy}>
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
            {modelLoading && <output aria-live="polite">Checking model access…</output>}
            {funding &&
              !modelLoading &&
              (modelError || (!!status?.settings.models[funding][quality].id && !modeAvailable)) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setAvailability(null);
                    setModelError("");
                    setModelCheck((value) => value + 1);
                  }}
                >
                  Retry model access
                </button>
              )}
            <p className="muted">Funding never switches automatically. Connect ChatGPT in Settings.</p>
          </fieldset>
          <label>
            Quality
            <select value={quality} disabled={busy} onChange={(event) => setQuality(event.target.value as AiQuality)}>
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
              disabled={busy}
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
                disabled={busy}
                onChange={(event) => setTargetLanguage(event.target.value)}
              />
            </label>
          )}
          {action === "change_tone" && (
            <label>
              Target tone
              <input value={tone} disabled={busy} onChange={(event) => setTone(event.target.value)} />
            </label>
          )}
          <label>
            {messages.length ? "Follow-up instruction" : "Writing instruction"}
            <textarea
              value={prompt}
              disabled={busy}
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
            disabled={busy}
          />
          <div className="writing-actions">
            {!running && (
              <button disabled={!canGenerate} onClick={() => void generate()}>
                {messages.length ? "Generate follow-up" : "Generate"}
              </button>
            )}
            {!running && result && (
              <button disabled={!canGenerate} onClick={() => void generate()}>
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
              <WritingPreview markdown={result} blocks={parsed.blocks} />
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
                    busy
                  }
                  onClick={() => void apply("replace")}
                >
                  Replace
                </button>
                <button
                  disabled={resultState !== "complete" || !!formatError || !editable || !target || busy}
                  onClick={() => void apply("insert")}
                >
                  Insert
                </button>
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(outputBuffer.current)
                      .then(() => setNotice("Result copied."))
                      .catch(() => setError("Copy failed. Select the result text and copy it manually."))
                  }
                >
                  Copy
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (operation.current || remoteId.current) return;
                    restoredDraft.current = null;
                    outputBuffer.current = "";
                    setResult("");
                    setResultState("empty");
                  }}
                >
                  Discard
                </button>
                {editable && resultState === "complete" && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (operation.current || remoteId.current) return;
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
                <HistoryMessage key={message.id} message={message} />
              ))}
            </details>
          )}
        </>
      )}
      <div className="writing-actions">
        <button
          disabled={busy || (checkingAccess && (!accessError || accessPending))}
          onClick={() => {
            if (operation.current || remoteId.current || (checkingAccess && (!accessError || accessPending))) return;
            loadRevision.current++;
            restoredDraft.current = null;
            accessGate.current.refresh = false;
            setCheckingAccess(false);
            setAccessPending(false);
            historyHidden.current = false;
            latestMessageId.current = "";
            remoteId.current = null;
            setRemoteGeneration(null);
            outputBuffer.current = "";
            setUnavailable(false);
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
            setAccessError("");
          }}
        >
          New conversation
        </button>
        <button disabled={busy || checkingAccess} onClick={() => setHistoryOpen((value) => !value)}>
          Document writing history
        </button>
      </div>
      {historyOpen && !checkingAccess && !locked && !unavailable && (
        <WritingHistory pageId={pageId} onOpen={(conversation) => void open(conversation.id)} />
      )}
    </aside>
  );
}
