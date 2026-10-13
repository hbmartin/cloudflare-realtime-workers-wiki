import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { notesSchema } from "./mentions";
import { tabsExtension, footnotesExtension } from "./editor-feature-blocks";
import { RenderBoundary } from "./RenderBoundary";
import { deckKeyAction, paginateBlocks, type SlideLayout } from "./presentation-layout";

export function Presentation({
  title,
  content,
  onClose,
}: {
  title: string;
  content: readonly unknown[];
  onClose: () => void;
}) {
  const editor = useCreateBlockNote(
    { schema: notesSchema, initialContent: content as never, extensions: [tabsExtension, footnotesExtension] },
    [],
  );
  const [slides, setSlides] = useState<SlideLayout[]>([]);
  const [index, setIndex] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const currentLayout = useRef({ slides, index });
  useLayoutEffect(() => {
    currentLayout.current = { slides, index };
  }, [slides, index]);
  const applyVisibility = useCallback(
    (layout: SlideLayout[], slideIndex: number) => {
      const indexes = new Set(layout[slideIndex - 1]?.nodeIndexes ?? []);
      editor.domElement
        ?.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer")
        .forEach((block, nodeIndex) => {
          block.hidden = slideIndex === 0 || !indexes.has(nodeIndex);
        });
    },
    [editor],
  );
  const measure = useCallback(() => {
    const element = editor.domElement;
    if (!element || !stage.current) return;
    const { slides: previousSlides, index: previousIndex } = currentLayout.current;
    const activeNodes = new Set(previousIndex > 0 ? previousSlides[previousIndex - 1]?.nodeIndexes : []);
    const anchor = activeNodes.values().next().value as number | undefined;
    element.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer").forEach((block) => {
      block.hidden = false;
    });
    const nodes = [...element.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer")];
    const measured = editor.document.map((block, nodeIndex) => {
      const dom = nodes[nodeIndex];
      const styles = dom ? window.getComputedStyle(dom) : null;
      return {
        index: nodeIndex,
        type: block.type,
        headingLevel: Number((block.props as { level?: number }).level),
        blank:
          block.type === "paragraph" &&
          !block.children.length &&
          Array.isArray(block.content) &&
          block.content.length === 0,
        top: dom?.offsetTop ?? 0,
        bottom: (dom?.offsetTop ?? 0) + (dom?.offsetHeight ?? 0),
        marginTop: parseFloat(styles?.marginTop ?? "0") || 0,
        marginBottom: parseFloat(styles?.marginBottom ?? "0") || 0,
      };
    });
    const next = paginateBlocks(measured, Math.max(100, stage.current.clientHeight - 48));
    setSlides((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    const nextIndex =
      anchor === undefined
        ? Math.min(previousIndex, next.length)
        : Math.max(1, next.findIndex((slide) => slide.nodeIndexes.includes(anchor)) + 1);
    setIndex(nextIndex);
    // Resize/image measurements temporarily reveal every block. Restore even when
    // the measured layout did not change and React has no state update to render.
    applyVisibility(next, nextIndex);
  }, [editor, applyVisibility]);
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    const previousInert = root?.inert ?? false;
    const previousFocus = document.activeElement;
    if (root) root.inert = true;
    close.current?.focus();
    const fullscreenDialog = dialog.current;
    let frame: number | undefined;
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const resize = new ResizeObserver(scheduleMeasure);
    if (stage.current) resize.observe(stage.current);
    const element = editor.domElement;
    element?.addEventListener("load", scheduleMeasure, true);
    const fonts = scheduleMeasure;
    document.fonts?.addEventListener("loadingdone", fonts);
    scheduleMeasure();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      element?.removeEventListener("load", scheduleMeasure, true);
      document.fonts?.removeEventListener("loadingdone", fonts);
      if (root) root.inert = previousInert;
      if (document.fullscreenElement === fullscreenDialog) void document.exitFullscreen().catch(() => undefined);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [editor, measure]);
  useLayoutEffect(() => {
    applyVisibility(slides, index);
    if (stage.current) stage.current.scrollTop = 0;
  }, [applyVisibility, slides, index]);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  return createPortal(
    <dialog
      open
      className="notes-presentation"
      aria-modal="true"
      aria-label="Presentation mode"
      ref={dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key === "Tab") {
          const focusable = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]',
            ) ?? []),
          ].filter((element) => element.offsetParent !== null);
          const first = focusable[0],
            last = focusable.at(-1);
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first?.focus();
          }
          return;
        }
        const action = deckKeyAction(event.nativeEvent);
        if (!action) return;
        event.preventDefault();
        if (action === "next") setIndex((value) => Math.min(slides.length, value + 1));
        if (action === "previous") setIndex((value) => Math.max(0, value - 1));
        if (action === "first") setIndex(0);
        if (action === "last") setIndex(slides.length);
        if (action === "lineDown" || action === "lineUp")
          stage.current?.scrollBy({ top: action === "lineDown" ? 40 : -40 });
        if (action === "pageDown" || action === "pageUp") {
          const area = stage.current;
          const canScroll =
            area &&
            (action === "pageDown" ? area.scrollTop + area.clientHeight < area.scrollHeight - 1 : area.scrollTop > 0);
          if (canScroll) area.scrollBy({ top: (action === "pageDown" ? 1 : -1) * area.clientHeight * 0.9 });
          else setIndex((value) => Math.max(0, Math.min(slides.length, value + (action === "pageDown" ? 1 : -1))));
        }
      }}
    >
      <header>
        <button type="button" ref={close} onClick={onClose}>
          Close presentation
        </button>
        {document.fullscreenEnabled && (
          <button
            type="button"
            onClick={() => {
              void (fullscreen ? document.exitFullscreen() : dialog.current!.requestFullscreen()).catch(
                () => undefined,
              );
            }}
          >
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        )}
        <output aria-live="polite">
          Slide {index + 1} of {slides.length + 1}
        </output>
      </header>
      <div className="notes-presentation-stage" ref={stage}>
        {index === 0 && <h1>{title}</h1>}
        <RenderBoundary label="The presentation could not be displayed">
          <BlockNoteView
            editor={editor}
            editable={false}
            slashMenu={false}
            formattingToolbar={false}
            sideMenu={false}
          />
        </RenderBoundary>
      </div>
      <footer>
        <button type="button" disabled={index === 0} onClick={() => setIndex((value) => value - 1)}>
          Previous slide
        </button>
        <button type="button" disabled={index === slides.length} onClick={() => setIndex((value) => value + 1)}>
          Next slide
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
