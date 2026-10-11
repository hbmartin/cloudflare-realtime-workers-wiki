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
  terminalMessageId: string;
  messageId: string;
  output: string;
  complete: boolean;
  sources: AiMessage["sources"];
};
type HistoryRefresh = {
  conversationId: string;
  token: symbol;
  mode: "passive" | "local";
};
type DiscardedResult = { conversationId: string; latestMessageId: string };
function matchesRestoredDraft(conversation: AiConversation, restored: RestoredDraft | null) {
  if (!restored || restored.conversationId !== conversation.id) return false;
  const latest = conversation.messages?.at(-1);
  const saved = conversation.messages?.find((message) => message.id === restored.messageId);
  return (
    latest?.id === restored.terminalMessageId &&
    (latest.status === "failed" || latest.status === "cancelled") &&
    !latest.output &&
    saved?.output === restored.output &&
    (saved.status === "complete") === restored.complete &&
    JSON.stringify(saved.sources) === JSON.stringify(restored.sources)
  );
}
function matchesDiscardedResult(conversation: AiConversation, discarded: DiscardedResult | null) {
  return (
    discarded?.conversationId === conversation.id && discarded.latestMessageId === conversation.messages?.at(-1)?.id
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
    [historyRefreshVersion, setHistoryRefreshVersion] = useState(0),
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
    statusRequest = useRef<{ epoch: number; promise: Promise<AiStatus> } | null>(null),
    quotaEpoch = useRef(0),
    quotaSample = useRef<{ quota: AiStatus["quota"]; receivedAt: number } | null>(null),
    quotaWasActive = useRef<boolean | null>(null),
    quotaSchedule = useRef({ retry: 0, retryAt: 0, request: null as Promise<void> | null }),
    accessContext = useRef<{ id?: string }>({}),
    opening = useRef<{ owner: symbol; touch: boolean } | null>(null),
    accessOwner = useRef<symbol | null>(null),
    accessGate = useRef({ visible, foreground, verify: false }),
    pendingHistory = useRef<HistoryRefresh | null>(null),
    historyRead = useRef<{ revision: number } | null>(null),
    retryAccess = useRef<(() => void) | null>(null),
    restoredDraft = useRef<RestoredDraft | null>(null),
    discardedResult = useRef<DiscardedResult | null>(null),
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
  const showLatest = useCallback(
    (latest: AiMessage | undefined) => {
      latestMessageId.current = latest?.id ?? "";
      outputBuffer.current = latest?.output ?? "";
      flushResult();
      setResultState(latest?.status === "complete" ? "complete" : latest?.output ? "partial" : "empty");
      setMessageId(latest?.id ?? "");
      setResultSources(latest?.sources ?? []);
    },
    [flushResult],
  );
  const finishAccess = useCallback((owner: symbol) => {
    if (accessOwner.current !== owner) return;
    accessOwner.current = null;
    if (mounted.current) setAccessPending(false);
  }, []);
  const recordQuota = useCallback((quota: AiStatus["quota"]) => {
    const current = quotaSample.current?.quota;
    if (current?.checkedAt !== undefined && quota.checkedAt !== undefined && quota.checkedAt < current.checkedAt)
      return current;
    quotaSample.current = { quota, receivedAt: performance.now() };
    if (quota.resetsAt > (quota.checkedAt ?? Date.now())) {
      quotaSchedule.current.retry = 0;
      quotaSchedule.current.retryAt = 0;
    }
    return quota;
  }, []);
  const quotaDelay = useCallback(() => {
    const sample = quotaSample.current;
    if (!sample) return 0;
    return sample.quota.checkedAt === undefined
      ? sample.quota.resetsAt - Date.now()
      : sample.quota.resetsAt - sample.quota.checkedAt - (performance.now() - sample.receivedAt);
  }, []);
  const requestHistoryRefresh = useCallback((conversationId: string, mode: HistoryRefresh["mode"], fresh = false) => {
    const pending = pendingHistory.current;
    if (!fresh && pending?.conversationId === conversationId) return pending;
    const refresh = { conversationId, token: Symbol("history refresh"), mode };
    pendingHistory.current = refresh;
    return refresh;
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
    accessGate.current = { visible, foreground, verify: previous.verify || refresh };
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
  const refreshStatus = useCallback(
    function requestStatus(): Promise<AiStatus> {
      const pending = statusRequest.current;
      if (pending) {
        if (pending.epoch === quotaEpoch.current) return pending.promise;
        // A terminal refresh must observe any reservation/refund that the older request predates.
        return pending.promise.then(
          (value) => (mounted.current ? requestStatus() : value),
          (cause: unknown) => {
            if (!mounted.current) throw cause;
            return requestStatus();
          },
        );
      }
      const epoch = quotaEpoch.current;
      const request = api<AiStatus>("/api/ai/status")
        .then((value) => {
          if (mounted.current) {
            const quota =
              epoch === quotaEpoch.current ? recordQuota(value.quota) : (quotaSample.current?.quota ?? value.quota);
            setStatus({ ...value, quota });
            setFunding(
              (current) =>
                current ?? value.preference ?? (value.connected && value.chatgptConfigured ? "chatgpt" : null),
            );
          }
          return value;
        })
        .finally(() => {
          if (statusRequest.current?.promise === request) statusRequest.current = null;
        });
      statusRequest.current = { epoch, promise: request };
      return request;
    },
    [recordQuota],
  );
  const quotaResetsAt = status?.quota.resetsAt;
  useEffect(() => {
    if (quotaResetsAt === undefined) return undefined;
    const active = visible && foreground && online && funding === "api";
    const resumed = quotaWasActive.current === false && active;
    quotaWasActive.current = active;
    if (!active) return undefined;
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async (force = false) => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      const delay = quotaSchedule.current.retryAt ? quotaSchedule.current.retryAt - performance.now() : quotaDelay();
      if (!force && delay > 0) {
        timer = setTimeout(() => void check(), delay);
        return;
      }
      inFlight = true;
      const schedule = quotaSchedule.current;
      if (!schedule.request) {
        schedule.request = refreshStatus()
          .catch(() => undefined)
          .then((value) => {
            if (value && quotaDelay() > 0) {
              schedule.retry = 0;
              schedule.retryAt = 0;
            } else {
              const retries = [5000, 15_000, 60_000, 300_000];
              schedule.retryAt = performance.now() + retries[Math.min(schedule.retry++, retries.length - 1)]!;
            }
          })
          .finally(() => {
            schedule.request = null;
          });
      }
      await schedule.request;
      inFlight = false;
      if (!disposed) {
        timer = setTimeout(
          () => void check(),
          Math.max(0, schedule.retryAt ? schedule.retryAt - performance.now() : quotaDelay()),
        );
      }
    };
    void check(resumed);
    const focus = () => void check(true);
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [visible, foreground, online, funding, quotaResetsAt, refreshStatus, quotaDelay]);
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
      accessContext.current = {};
      opening.current = null;
      accessOwner.current = null;
      pendingHistory.current = null;
      historyRead.current = null;
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
    accessContext.current = { id: accessContext.current.id };
    opening.current = null;
    accessOwner.current = null;
    pendingHistory.current = null;
    historyRead.current = null;
    accessGate.current.verify = false;
    setAccessError("");
    controller.current?.abort();
    historyHidden.current = true;
    restoredDraft.current = null;
    discardedResult.current = null;
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
        setAccessError(apiErrorMessage(cause, "Sign in again to check conversation access."));
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
  const syncLocalHistory = useCallback(
    async (refresh: HistoryRefresh) => {
      if (
        operation.current ||
        opening.current ||
        accessContext.current.id !== refresh.conversationId ||
        pendingHistory.current?.token !== refresh.token ||
        historyRead.current?.revision === loadRevision.current
      )
        return;
      const read = { revision: loadRevision.current };
      historyRead.current = read;
      const current = () =>
        mounted.current && read.revision === loadRevision.current && pendingHistory.current?.token === refresh.token;
      try {
        const { conversation } = await api<{ conversation: AiConversation }>(
          `/api/ai/conversations/${refresh.conversationId}`,
        );
        if (!current()) return;
        if (conversation.locked) {
          setLocked(true);
          clearPrivateContent();
          return;
        }
        if (operation.current) return;
        setMessages(conversation.messages ?? []);
        setHistoryRefreshVersion((version) => version + 1);
        const latest = conversation.messages?.at(-1);
        const discarded = discardedResult.current;
        if (
          (restoredDraft.current && !matchesRestoredDraft(conversation, restoredDraft.current)) ||
          (discarded && !matchesDiscardedResult(conversation, discarded))
        ) {
          restoredDraft.current = null;
          discardedResult.current = null;
          showLatest(latest);
          setTarget(null);
          setResultTarget(null);
        }
        pendingHistory.current = null;
      } catch (cause) {
        if (current()) accessFailure(cause);
      } finally {
        if (historyRead.current === read) historyRead.current = null;
      }
    },
    [accessFailure, clearPrivateContent, showLatest],
  );
  const open = useCallback(
    async (id: string, touch = true, preserveTarget = false, refresh?: HistoryRefresh) => {
      if (operation.current || (touch && remoteId.current)) {
        if (touch) setNotice("Finish or cancel the current operation before changing its source.");
        return false;
      }
      const pending = touch ? null : (refresh ?? requestHistoryRefresh(id, "passive", true));
      const revision = ++loadRevision.current;
      const owner = Symbol("open");
      historyRead.current = null;
      accessContext.current = { id: accessContext.current.id };
      opening.current = { owner, touch };
      accessOwner.current = owner;
      setCheckingAccess(true);
      setAccessPending(true);
      setAccessError("");
      try {
        const { conversation } = await api<{ conversation: AiConversation }>(
          `/api/ai/conversations/${id}${touch ? "/open" : ""}`,
          touch ? { method: "POST" } : undefined,
        );
        if (
          !mounted.current ||
          revision !== loadRevision.current ||
          (pending && pendingHistory.current?.token !== pending.token)
        )
          return false;
        setLocked(conversation.locked);
        setUnavailable(false);
        accessContext.current = { id: conversation.id };
        setThreadId(conversation.id);
        if (touch) {
          restoredDraft.current = null;
          discardedResult.current = null;
          pendingHistory.current = null;
          accessGate.current.verify = false;
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
          return false;
        }
        if (!touch) setAccessError("");
        const latest = conversation.messages?.at(-1);
        const restored = restoredDraft.current;
        const keepDraft = preserveTarget && matchesRestoredDraft(conversation, restored);
        const discarded = discardedResult.current;
        const keepDiscard = preserveTarget && matchesDiscardedResult(conversation, discarded);
        if (!keepDraft) restoredDraft.current = null;
        if (!keepDiscard) discardedResult.current = null;
        if (preserveTarget && (latest?.id !== latestMessageId.current || (restored && !keepDraft))) {
          setTarget(null);
          setResultTarget(null);
        }
        historyHidden.current = false;
        setMessages(conversation.messages ?? []);
        if (keepDraft || keepDiscard) latestMessageId.current = latest?.id ?? "";
        else showLatest(latest);
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
        setCheckingAccess(false);
        if (pending && pendingHistory.current?.token === pending.token) pendingHistory.current = null;
        if (!touch) setHistoryRefreshVersion((version) => version + 1);
        return true;
      } catch (cause) {
        if (
          mounted.current &&
          revision === loadRevision.current &&
          (!pending || pendingHistory.current?.token === pending.token)
        ) {
          const denied = accessFailure(cause);
          if (touch && !denied) setError(apiErrorMessage(cause, "The conversation could not be opened."));
          else if (!touch && !denied)
            setAccessError(apiErrorMessage(cause, "Conversation access could not be checked. Retrying automatically."));
          if (touch) setCheckingAccess(false);
        }
        return false;
      } finally {
        if (opening.current?.owner === owner) opening.current = null;
        finishAccess(owner);
      }
    },
    [pageId, clearPrivateContent, showLatest, accessFailure, finishAccess, requestHistoryRefresh],
  );
  const drainHistory = useCallback(async () => {
    const refresh = pendingHistory.current;
    if (
      !mounted.current ||
      !refresh ||
      refresh.conversationId !== accessContext.current.id ||
      operation.current ||
      opening.current
    )
      return;
    if (refresh.mode === "local") await syncLocalHistory(refresh);
    else await open(refresh.conversationId, false, true, refresh);
  }, [open, syncLocalHistory]);
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
    let inFlight = false;
    let requestOwner: symbol | null = null;
    const check = async (refresh = false) => {
      if (abort.signal.aborted || opening.current || accessContext.current.id !== threadId) return;
      if (refresh) {
        accessGate.current.verify = true;
        setCheckingAccess(true);
        if (operation.current === "generate") requestHistoryRefresh(threadId, "local");
        else if (!operation.current || operation.current === "apply")
          requestHistoryRefresh(threadId, "passive", operation.current === "apply");
      }
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      const context = accessContext.current;
      const owner = Symbol("monitor");
      requestOwner = owner;
      accessOwner.current = owner;
      setAccessPending(true);
      try {
        const value = await api<AiConversationAccess>(`/api/ai/conversations/${threadId}/access`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted || context !== accessContext.current || opening.current) return;
        setAccessError("");
        const shouldRefresh = accessGate.current.verify;
        accessGate.current.verify = false;
        if (value.locked) {
          setLocked(true);
          clearPrivateContent();
        } else {
          const wasRemote = !!remoteId.current;
          setLocked(false);
          setUnavailable(false);
          if (shouldRefresh && (controller.current || operation.current)) {
            setHistoryRefreshVersion((version) => version + 1);
          }
          if (!controller.current) {
            const completedRemote = wasRemote && !value.activeGeneration;
            if (completedRemote || historyHidden.current) requestHistoryRefresh(threadId, "passive", completedRemote);
            remoteId.current = value.activeGeneration?.messageId ?? null;
            setRemoteGeneration(value.activeGeneration ?? null);
          }
          if (!operation.current && pendingHistory.current?.conversationId === threadId) {
            if (pendingHistory.current.mode === "passive") {
              await drainHistory();
              return;
            }
            // Keep access polling independent of a slow, non-gating saved-history read.
            void drainHistory();
          }
        }
        if (!abort.signal.aborted && context === accessContext.current) setCheckingAccess(false);
      } catch (cause) {
        if (!abort.signal.aborted && context === accessContext.current) {
          if (!accessFailure(cause))
            setAccessError(apiErrorMessage(cause, "Conversation access could not be checked. Retrying automatically."));
        }
      } finally {
        inFlight = false;
        finishAccess(owner);
        if (requestOwner === owner) requestOwner = null;
      }
    };
    const retry = () => void check(true);
    retryAccess.current = retry;
    void check(accessGate.current.verify);
    const timer = setInterval(() => void check(), 5000),
      focus = () => void check(true);
    window.addEventListener("focus", focus);
    return () => {
      abort.abort();
      if (retryAccess.current === retry) retryAccess.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      if (requestOwner) finishAccess(requestOwner);
      // A hidden reload must not release content after a newer reveal check.
      if (opening.current && !opening.current.touch && accessContext.current.id === threadId) {
        const owner = opening.current.owner;
        opening.current = null;
        accessContext.current = { id: threadId };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Retire the current reload when its monitor is disposed.
        loadRevision.current++;
        finishAccess(owner);
      }
    };
  }, [
    threadId,
    visible,
    foreground,
    drainHistory,
    requestHistoryRefresh,
    clearPrivateContent,
    accessFailure,
    finishAccess,
  ]);
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
      restored: restoredDraft.current,
      latestMessageId: latestMessageId.current,
    };
    restoredDraft.current = null;
    const nextTarget = target?.kind === "page" || !target ? onCapture("page") : target;
    const abort = new AbortController();
    const revision = ++loadRevision.current;
    historyRead.current = null;
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
          quotaEpoch.current++;
          discardedResult.current = null;
          savedThread = event.conversationId;
          if (accessContext.current.id !== event.conversationId) accessContext.current = { id: event.conversationId };
          setThreadId(event.conversationId);
          setMessageId(event.messageId);
          latestMessageId.current = event.messageId;
          setResultSources(event.sources);
          const quota = recordQuota(event.quota);
          setStatus((current) => (current ? { ...current, quota } : null));
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
            denied = accessFailure(new ApiClientError(event.status ?? 500, event.code, event.message));
            if (!denied) setError(event.message);
          }
        }
      });
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current && !abort.signal.aborted) {
        denied = accessFailure(cause);
        if (!denied) setError(apiErrorMessage(cause, "Generation failed. Retry explicitly."));
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
              terminalMessageId: latestMessageId.current,
              messageId: previous.messageId,
              output: previous.result,
              complete: previous.state === "complete",
              sources: previous.sources,
            };
          } else if (!started) {
            restoredDraft.current = previous.restored;
            latestMessageId.current = previous.latestMessageId;
          }
          setResultSources(previous.sources);
        } else if (!terminal) {
          setResultState(outputBuffer.current ? "partial" : "empty");
          if (abort.signal.aborted) setNotice("Generation cancelled. Partial text can be copied.");
        }
        flushResult();
        quotaEpoch.current++;
        void refreshStatus().catch(() => undefined);
        if (savedThread && !abort.signal.aborted)
          void syncLocalHistory(requestHistoryRefresh(savedThread, "local", true));
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
        if (!accessFailure(cause))
          setError(
            cause instanceof WritingTargetError
              ? cause.message
              : apiErrorMessage(cause, "The result could not be applied."),
          );
      }
    } finally {
      operation.current = null;
      if (mounted.current) {
        setApplying(false);
        onBusyChange?.(!!remoteId.current);
        if (revision === loadRevision.current && accessGate.current.visible && accessGate.current.foreground)
          void drainHistory();
      }
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
                    discardedResult.current = threadId
                      ? { conversationId: threadId, latestMessageId: latestMessageId.current }
                      : null;
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
            accessContext.current = {};
            opening.current = null;
            accessOwner.current = null;
            restoredDraft.current = null;
            discardedResult.current = null;
            accessGate.current.verify = false;
            pendingHistory.current = null;
            historyRead.current = null;
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
      {historyOpen && !locked && !unavailable && (
        <div hidden={checkingAccess}>
          <WritingHistory
            pageId={pageId}
            refreshVersion={historyRefreshVersion}
            onOpen={(conversation) => void open(conversation.id)}
          />
        </div>
      )}
    </aside>
  );
}
