import { useState, type FormEvent } from "react";
import type { Tag, TagColor } from "../shared/types";

const TAG_COLORS: TagColor[] = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"];

export function PageTags({
  assigned,
  available,
  editable,
  busy,
  onAdd,
  onRemove,
  onCreate,
}: {
  assigned: Tag[];
  available: Tag[];
  editable: boolean;
  busy: boolean;
  onAdd: (tag: Tag) => Promise<boolean>;
  onRemove: (tag: Tag) => Promise<boolean>;
  onCreate: (name: string, color: TagColor) => Promise<boolean>;
}) {
  const [creating, setCreating] = useState(false);
  const unassigned = available.filter((tag) => !assigned.some((candidate) => candidate.id === tag.id));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const name = String(values.get("name") ?? "").trim();
    const color = String(values.get("color") ?? "gray") as TagColor;
    if (!name) return;
    void onCreate(name, color).then((created) => {
      if (!created) return;
      form.reset();
      setCreating(false);
    });
  }

  if (!editable && assigned.length === 0) return null;

  return (
    <section className="page-tags" aria-label="Page tags">
      <div className="page-tag-list">
        {assigned.map((tag) => (
          <span className="tag-chip" data-color={tag.color} key={tag.id}>
            {tag.name}
            {editable && (
              <button disabled={busy} onClick={() => void onRemove(tag)} aria-label={`Remove ${tag.name} tag`}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {editable && !creating && (
        <div className="page-tag-actions">
          {unassigned.length > 0 && (
            <select
              aria-label="Add tag"
              disabled={busy}
              value=""
              onChange={(event) => {
                const tag = unassigned.find((candidate) => candidate.id === event.target.value);
                if (tag) void onAdd(tag);
              }}
            >
              <option value="">Add tag…</option>
              {unassigned.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          )}
          <button className="tag-create-trigger" disabled={busy} onClick={() => setCreating(true)}>
            + New tag
          </button>
        </div>
      )}
      {editable && creating && (
        <form className="tag-create-form" onSubmit={submit}>
          <label>
            <span className="visually-hidden">Tag name</span>
            <input name="name" maxLength={50} placeholder="Tag name" required autoFocus />
          </label>
          <label>
            <span className="visually-hidden">Tag color</span>
            <select name="color" defaultValue="gray" aria-label="Tag color">
              {TAG_COLORS.map((color) => (
                <option key={color} value={color}>
                  {color[0]!.toUpperCase() + color.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-small" disabled={busy}>
            Create
          </button>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}
