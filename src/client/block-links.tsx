import { useEffect, useRef, useState, type RefObject } from "react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { AddBlockButton, DragHandleButton, SideMenu, useBlockNoteEditor, useExtensionState } from "@blocknote/react";
import type { CollaborationBundle } from "./collaboration";

const COPY_EVENT = "notes:copy-block-link";
const BLOCK_SELECTOR = ".bn-block-outer[data-id]";
const cssValue = (value: string) => value.replace(/[^\w-]/gu, (char) => `\\${char.codePointAt(0)!.toString(16)} `);
function blockOptions(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].map((element, index) => ({
    id: element.dataset.id!,
    label: `${index + 1}. ${element.querySelector(":scope > .bn-block > .bn-block-content, :scope > .bn-block > .react-renderer > .bn-block-content")?.textContent?.trim().slice(0, 60) || "Block"}`,
  }));
}

export function blockLink(pageId: string, blockId: string, href = window.location.href) {
  const url = new URL(href);
  url.search = new URLSearchParams({ page: pageId }).toString();
  url.hash = `block=${encodeURIComponent(blockId)}`;
  return url.href;
}

export function blockTarget(hash: string) {
  if (!hash.startsWith("#block=")) return null;
  try {
    const id = decodeURIComponent(hash.slice(7));
    return id && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}

export function revealBlock(root: HTMLElement, id: string) {
  const block = [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].find((element) => element.dataset.id === id);
  if (!block) return false;
  for (let ancestor = block.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    if (!ancestor.matches(".bn-block")) continue;
    const wrapper = ancestor.querySelector<HTMLElement>(
      ":scope > .bn-block-content .bn-toggle-wrapper[data-show-children='false'], :scope > .react-renderer > .bn-block-content .bn-toggle-wrapper[data-show-children='false']",
    );
    wrapper?.querySelector<HTMLButtonElement>(".bn-toggle-button")?.click();
  }
  window.requestAnimationFrame(() => {
    if (!block.isConnected) return;
    block.scrollIntoView?.({
      block: "center",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
  return true;
}

export function BlockLinkSideMenu() {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  return (
    <SideMenu>
      <AddBlockButton />
      <DragHandleButton />
      <button
        type="button"
        aria-label="Copy link to block"
        title="Copy link to block"
        onClick={() => {
          if (block) window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: block.id }));
        }}
      >
        ↗
      </button>
    </SideMenu>
  );
}

export function BlockLinkControls({
  root,
  pageId,
  bundle,
  offline,
}: {
  root: RefObject<HTMLDivElement | null>;
  pageId: string;
  bundle: CollaborationBundle;
  offline: boolean;
}) {
  const [message, setMessage] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [fallback, setFallback] = useState("");
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    blocks: ReturnType<typeof blockOptions>;
  } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuSelect = useRef<HTMLSelectElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<string | null>(null);
  useEffect(() => {
    const shell = root.current;
    if (!shell) return undefined;
    let active = true;
    let timer: number | undefined;
    let target: string | null = null;
    const attempt = () => {
      if (!target) return;
      if (revealBlock(shell, target)) {
        setHighlight(target);
        timer = window.setTimeout(() => {
          if (active) setHighlight(null);
        }, 2500);
        target = null;
        setMessage("");
      } else if (bundle.provider.synced || offline || !navigator.onLine) {
        setMessage(
          offline || !navigator.onLine
            ? "This block is not in the cached copy. Reconnect to locate it."
            : "This block is no longer available.",
        );
      }
    };
    const navigate = () => {
      setHighlight(null);
      if (timer !== undefined) window.clearTimeout(timer);
      const page = new URL(window.location.href).searchParams.get("page");
      target = page === pageId ? blockTarget(window.location.hash) : null;
      setMessage("");
      attempt();
    };
    const identify = (event: Event) => {
      if (event.target instanceof Element)
        selected.current = event.target.closest<HTMLElement>(BLOCK_SELECTOR)?.dataset.id ?? selected.current;
    };
    const context = (event: MouseEvent) => {
      identify(event);
      if (!selected.current) return;
      event.preventDefault();
      setMenu({
        id: selected.current,
        blocks: blockOptions(shell),
        x: Math.min(event.clientX, window.innerWidth - 220),
        y: Math.max(0, Math.min(event.clientY, window.innerHeight - 140)),
      });
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
        identify(event);
        const id = selected.current ?? shell.querySelector<HTMLElement>(BLOCK_SELECTOR)?.dataset.id;
        if (!id) return;
        event.preventDefault();
        const bounds = shell.getBoundingClientRect();
        setMenu({ id, x: Math.max(0, bounds.left), y: Math.max(0, bounds.top), blocks: blockOptions(shell) });
      }
    };
    const copyLink = async (event: Event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (typeof id !== "string") return;
      const url = blockLink(pageId, id);
      setMenu(null);
      try {
        await navigator.clipboard.writeText(url);
        if (!active) return;
        setFallback("");
        setMessage("Block link copied.");
      } catch {
        if (!active) return;
        setFallback(url);
        setMessage("Copy this block link:");
      }
    };
    const copy = (event: Event) => {
      void copyLink(event);
    };
    const observer = new MutationObserver(attempt);
    observer.observe(shell, { childList: true, subtree: true });
    shell.addEventListener("pointerdown", identify);
    shell.addEventListener("focusin", identify);
    shell.addEventListener("contextmenu", context);
    shell.addEventListener("keydown", keyboard);
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    window.addEventListener(COPY_EVENT, copy);
    bundle.provider.on("sync", attempt);
    navigate();
    return () => {
      active = false;
      observer.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      shell.removeEventListener("pointerdown", identify);
      shell.removeEventListener("focusin", identify);
      shell.removeEventListener("contextmenu", context);
      shell.removeEventListener("keydown", keyboard);
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
      window.removeEventListener(COPY_EVENT, copy);
      bundle.provider.off("sync", attempt);
    };
  }, [bundle, offline, pageId, root]);
  const menuOpen = Boolean(menu);
  useEffect(() => {
    if (menuOpen) menuButton.current?.focus();
  }, [menuOpen]);
  return (
    <>
      {highlight && (
        <style>{`[data-block-link-document="${cssValue(pageId)}"] .bn-editor .bn-block-outer[data-id="${cssValue(highlight)}"] { outline: 2px solid var(--accent); outline-offset: 2px; }`}</style>
      )}
      <button
        type="button"
        ref={menuTrigger}
        aria-haspopup="dialog"
        onClick={(event) => {
          const id = selected.current ?? root.current?.querySelector<HTMLElement>(BLOCK_SELECTOR)?.dataset.id;
          if (id) {
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({
              id,
              blocks: blockOptions(root.current!),
              x: Math.min(bounds.left, window.innerWidth - 220),
              y: Math.max(0, Math.min(bounds.bottom, window.innerHeight - 140)),
            });
          }
        }}
      >
        Block actions
      </button>
      <output aria-live="polite" aria-label="Block link status">
        {message}
      </output>
      {fallback && (
        <input aria-label="Block link" readOnly value={fallback} onFocus={(event) => event.currentTarget.select()} />
      )}
      {menu && (
        <dialog
          open
          tabIndex={-1}
          aria-label="Block actions"
          className="block-link-menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setMenu(null);
              menuTrigger.current?.focus();
            } else if (
              event.key === "Tab" &&
              ((!event.shiftKey && event.target === menuSelect.current) ||
                (event.shiftKey && event.target === menuButton.current))
            ) {
              event.preventDefault();
              (event.shiftKey ? menuSelect.current : menuButton.current)?.focus();
            }
          }}
        >
          <label>
            Block to link
            <select
              ref={menuSelect}
              aria-label="Block to link"
              value={menu.id}
              onChange={(event) => {
                const id = event.currentTarget.value;
                selected.current = id;
                setMenu((current) => (current ? { ...current, id } : null));
              }}
            >
              {menu.blocks.map((block) => (
                <option key={block.id} value={block.id}>
                  {block.label}
                </option>
              ))}
            </select>
          </label>
          <div role="menu" aria-label="Block actions">
            <button
              ref={menuButton}
              role="menuitem"
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: menu.id }))}
            >
              Copy link to block
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
