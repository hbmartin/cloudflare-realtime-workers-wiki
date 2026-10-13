/** Matching and reverse-order replacement adapted from Docmost
 * c1305f002e47ece4d40f0aebba75d8d0f762d8ea, search-and-replace.ts.
 * MIT License, Copyright (c) 2023-2024 Jeet Mandaliya.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createExtension, type BlockNoteEditor } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";
import { yUndoPluginKey } from "y-prosemirror";

export type SearchOptions = { query: string; caseSensitive: boolean; wholeWord: boolean; index: number };
export type SearchRange = { from: number; to: number };
const emptySearch: SearchOptions = { query: "", caseSensitive: false, wholeWord: false, index: 0 };
const SEARCH_MAX_MATCHES = 10_000;
export function findTextMatches(doc: PMNode, options: Pick<SearchOptions, "query" | "caseSensitive" | "wholeWord">) {
  if (!options.query) return [];
  const pattern = options.query.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])` : pattern,
    options.caseSensitive ? "gu" : "giu",
  );
  const results: SearchRange[] = [];
  doc.descendants((node, pos) => {
    if (results.length >= SEARCH_MAX_MATCHES) return false;
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, "", (leaf) =>
      leaf.type.name === "hardBreak" ? "\n" : "\uFFFC",
    );
    for (const match of text.matchAll(regex)) {
      if (results.length >= SEARCH_MAX_MATCHES) break;
      if (match[0] && !match[0].includes("\uFFFC"))
        results.push({ from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length });
    }
    return false;
  });
  return results;
}
export function replaceSearchRanges(tr: Transaction, ranges: readonly SearchRange[], replacement: string) {
  for (const { from, to } of ranges.toReversed()) {
    const resolved = tr.doc.resolve(from);
    const marks = resolved.nodeAfter?.isText ? resolved.nodeAfter.marks : resolved.marks();
    tr.delete(from, to);
    if (replacement) tr.insert(from, tr.doc.type.schema.text(replacement, marks));
  }
  return tr;
}
const searchPluginKey = new PluginKey<{ options: SearchOptions; ranges: SearchRange[] }>("notesFindReplace");
export const findReplaceExtension = createExtension({
  key: "notesFindReplace",
  prosemirrorPlugins: [
    new Plugin<{ options: SearchOptions; ranges: SearchRange[] }>({
      key: searchPluginKey,
      state: {
        init: () => ({ options: emptySearch, ranges: [] }),
        apply: (tr, previous) => {
          const options = tr.getMeta(searchPluginKey) as SearchOptions | undefined;
          if (!options && !tr.docChanged) return previous;
          const next = options ?? previous.options;
          const ranges = findTextMatches(tr.doc, next);
          return {
            options: { ...next, index: Math.min(Math.max(0, next.index), Math.max(0, ranges.length - 1)) },
            ranges,
          };
        },
      },
      props: {
        decorations: (state) => {
          const search = searchPluginKey.getState(state);
          if (!search) return DecorationSet.empty;
          return DecorationSet.create(
            state.doc,
            search.ranges.map((range, index) =>
              Decoration.inline(range.from, range.to, {
                class:
                  index === search.options.index ? "notes-search-result notes-search-current" : "notes-search-result",
              }),
            ),
          );
        },
      },
    }),
  ],
});

export function FindReplace({ editor, editable }: { editor: BlockNoteEditor<any, any, any>; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(emptySearch);
  const [replacement, setReplacement] = useState("");
  const [, refresh] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => editor.onChange(() => refresh((value) => value + 1)), [editor]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !["f", "h"].includes(event.key.toLowerCase())) return;
      const active = document.activeElement;
      if (!editor.domElement?.contains(active) && !panel.current?.contains(active)) return;
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [editor]);
  const search = searchPluginKey.getState(editor.prosemirrorState);
  const change = (next: SearchOptions, select = false) => {
    setOptions(next);
    editor.transact((tr) => {
      tr.setMeta(searchPluginKey, next).setMeta("addToHistory", false);
      if (select) {
        const ranges = findTextMatches(tr.doc, next);
        const range = ranges[(next.index + ranges.length) % ranges.length];
        if (range) tr.setSelection(TextSelection.create(tr.doc, range.from, range.to)).scrollIntoView();
      }
    });
  };
  const close = () => {
    change(emptySearch);
    setOpen(false);
    editor.focus();
  };
  const replace = (all: boolean) => {
    if (!editable || !editor.isEditable) return;
    const current = searchPluginKey.getState(editor.prosemirrorState);
    if (!current?.ranges.length) return;
    const undo = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
    undo?.stopCapturing();
    editor.transact((tr) =>
      replaceSearchRanges(tr, all ? current.ranges : [current.ranges[current.options.index]!], replacement),
    );
    undo?.stopCapturing();
    refresh((value) => value + 1);
  };
  return (
    <div ref={panel} className="notes-find-replace" contentEditable={false}>
      <button
        type="button"
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            requestAnimationFrame(() => input.current?.focus());
          }
        }}
      >
        Find and replace
      </button>
      {open && (
        <search
          onKeyDownCapture={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
            if (event.key === "Enter" && event.target === input.current) {
              event.preventDefault();
              const length = search?.ranges.length ?? 0;
              change(
                {
                  ...options,
                  index: length ? ((search?.options.index ?? 0) + (event.shiftKey ? length - 1 : 1)) % length : 0,
                },
                true,
              );
            }
          }}
        >
          <input
            ref={input}
            aria-label="Find text"
            maxLength={200}
            value={options.query}
            onChange={(event) => change({ ...options, query: event.target.value, index: 0 })}
          />
          <label>
            <input
              type="checkbox"
              checked={options.caseSensitive}
              onChange={(event) => change({ ...options, caseSensitive: event.target.checked, index: 0 })}
            />
            Match case
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.wholeWord}
              onChange={(event) => change({ ...options, wholeWord: event.target.checked, index: 0 })}
            />
            Whole words
          </label>
          <output aria-live="polite">
            {search?.ranges.length ? `${(search.options.index ?? 0) + 1} of ${search.ranges.length}` : "No matches"}
          </output>
          {search?.ranges.length === SEARCH_MAX_MATCHES && (
            <small>
              First 10,000 matches shown. Replace all affects these matches; search again for any remaining matches.
            </small>
          )}
          <button
            type="button"
            disabled={!search?.ranges.length}
            onClick={() =>
              change(
                {
                  ...options,
                  index:
                    ((search?.options.index ?? 0) + (search?.ranges.length ?? 1) - 1) % (search?.ranges.length ?? 1),
                },
                true,
              )
            }
          >
            Previous match
          </button>
          <button
            type="button"
            disabled={!search?.ranges.length}
            onClick={() =>
              change({ ...options, index: ((search?.options.index ?? 0) + 1) % (search?.ranges.length ?? 1) }, true)
            }
          >
            Next match
          </button>
          {editable && (
            <>
              <input
                aria-label="Replace with"
                maxLength={10_000}
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
              />
              <button type="button" disabled={!search?.ranges.length} onClick={() => replace(false)}>
                Replace
              </button>
              <button type="button" disabled={!search?.ranges.length} onClick={() => replace(true)}>
                Replace all
              </button>
            </>
          )}
          <button type="button" onClick={close}>
            Close find
          </button>
        </search>
      )}
    </div>
  );
}
