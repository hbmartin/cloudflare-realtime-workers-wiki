import type { Page } from "../shared/types";
import { ApiClientError, api } from "./api";

export type ProviderControl = {
  connect: () => Promise<void> | void;
  disconnect: () => void;
};

export type DocumentCloseReconcilerOptions = {
  page: Pick<Page, "id" | "contentEpoch">;
  provider: ProviderControl;
  canQuarantine: boolean;
  hasUnsyncedChanges: () => boolean;
  quarantine: () => void;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
};

const TRANSITION_CLOSE_CODES = new Set([4410, 4412]);
const RECONCILED_CLOSE_CODES = new Set([4410, 4412, 1006]);

function retryDelay(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

export function createDocumentCloseReconciler({
  page,
  provider,
  canQuarantine,
  hasUnsyncedChanges,
  quarantine,
  onPageChanged,
  onPageUnavailable,
}: DocumentCloseReconcilerOptions) {
  let active = true;
  let closeCheck = 0;
  let reconnectAttempt = 0;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const invalidate = () => {
    clearTimer();
    return ++closeCheck;
  };
  const unavailable = () => {
    invalidate();
    provider.disconnect();
    onPageUnavailable(page.id);
  };
  const schedule = (callback: () => void, delay: number) => {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = undefined;
      callback();
    }, delay);
  };
  const connect = async () => {
    try {
      await provider.connect();
    } catch (error) {
      if (active) console.error("Failed to reconnect document collaboration", error);
    }
  };

  const reconcileClose = async (code: number, check: number, attempt = 0): Promise<void> => {
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}`);
      if (!active || check !== closeCheck) return;
      if (result.page.contentEpoch !== page.contentEpoch && canQuarantine && hasUnsyncedChanges()) {
        quarantine();
      }
      if (result.page.archivedAt !== null) {
        unavailable();
      } else if (result.page.contentEpoch !== page.contentEpoch) {
        invalidate();
        provider.disconnect();
        onPageChanged(result.page);
      } else if (TRANSITION_CLOSE_CODES.has(code)) {
        const delay = retryDelay(reconnectAttempt++);
        schedule(() => {
          if (active && check === closeCheck) void connect();
        }, delay);
      }
    } catch (error) {
      if (!active || check !== closeCheck) return;
      if (error instanceof ApiClientError) {
        if (error.status === 404) {
          unavailable();
          return;
        }
        if (error.status === 401 || error.status === 403) return;
      }
      const retryable = !(error instanceof ApiClientError) || error.status === 429 || error.status >= 500;
      if (!TRANSITION_CLOSE_CODES.has(code)) return;
      if (!retryable) {
        unavailable();
        return;
      }
      schedule(() => void reconcileClose(code, check, attempt + 1), retryDelay(attempt));
    }
  };

  return {
    handleClose(event: CloseEvent) {
      if (!active) return;
      if (TRANSITION_CLOSE_CODES.has(event.code)) provider.disconnect();
      if (event.code === 4411) {
        unavailable();
        return;
      }
      if (!RECONCILED_CLOSE_CODES.has(event.code)) return;
      const check = invalidate();
      if (event.code === 4410 && canQuarantine && hasUnsyncedChanges()) quarantine();
      void reconcileClose(event.code, check);
    },
    handleSync(synced: boolean) {
      if (synced) reconnectAttempt = 0;
    },
    destroy() {
      active = false;
      invalidate();
    },
  };
}
