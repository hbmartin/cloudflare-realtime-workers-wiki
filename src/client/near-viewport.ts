import { useCallback, useEffect, useState } from "react";

/** Defer previews outside the viewport while retaining the actual editor tree.
 * Focus, selection, and IME composition keep the active renderer alive. */
export function useNearViewport() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [interacting, setInteracting] = useState(false);
  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);
  useEffect(() => {
    if (!element) return undefined;
    let measuredHeight = 0;
    const originalMinHeight = element.style.minHeight;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target !== element) continue;
              const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
              if (height > 0) measuredHeight = height;
            }
          });
    resize?.observe(element);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.target !== element) continue;
                // Retain measured space when a disposable preview is paused.
                // Hidden tabs report zero height and keep their last visible size.
                // Use the observer's batched geometry. Reading layout here for
                // every offscreen block would force repeated layout on 10k pages.
                const height = entry.boundingClientRect?.height ?? 0;
                if (height > 0) measuredHeight = height;
                element.style.minHeight =
                  entry.isIntersecting || !measuredHeight ? originalMinHeight : `${measuredHeight}px`;
                setNear(entry.isIntersecting);
              }
            },
            { rootMargin: "600px" },
          );
    observer?.observe(element);
    let composing = false;
    const update = () => {
      const selection = document.getSelection();
      setInteracting(
        composing ||
          element.contains(document.activeElement) ||
          Boolean(selection?.anchorNode && element.contains(selection.anchorNode)),
      );
    };
    const compose = () => {
      composing = true;
      update();
    };
    const finish = () => {
      composing = false;
      update();
    };
    element.addEventListener("focusin", update);
    element.addEventListener("focusout", update);
    element.addEventListener("compositionstart", compose);
    element.addEventListener("compositionend", finish);
    document.addEventListener("selectionchange", update);
    return () => {
      observer?.disconnect();
      resize?.disconnect();
      element.style.minHeight = originalMinHeight;
      element.removeEventListener("focusin", update);
      element.removeEventListener("focusout", update);
      element.removeEventListener("compositionstart", compose);
      element.removeEventListener("compositionend", finish);
      document.removeEventListener("selectionchange", update);
    };
  }, [element]);
  return { ref, ready: near || interacting };
}
