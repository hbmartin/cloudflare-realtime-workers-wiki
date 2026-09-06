import type { Page, Space } from "../shared/types";

export function TemplateLibrary({
  templates,
  space,
  editable,
  busyId,
  onUse,
  onEdit,
}: {
  templates: Page[];
  space: Space | null;
  editable: boolean;
  busyId: string | null;
  onUse: (template: Page) => void;
  onEdit: (template: Page) => void;
}) {
  return (
    <main className="utility-view template-library">
      <p className="eyebrow">Reusable pages</p>
      <h1>Templates</h1>
      <p className="muted">
        {space ? `Templates in ${space.name} inherit this space’s access.` : "Choose a space to browse its templates."}
      </p>
      <div className="template-grid">
        {templates.map((template) => {
          const busy = busyId === template.id;
          return (
            <article key={template.id}>
              <span className="template-kind" aria-hidden="true">
                {template.kind === "table" ? "▦" : "□"}
              </span>
              <div>
                <h2>{template.title}</h2>
                <p>{template.kind === "table" ? "Structured table" : "Document"}</p>
              </div>
              <div className="template-actions">
                <button className="quiet-button" onClick={() => onEdit(template)}>
                  Edit
                </button>
                {editable && (
                  <button className="primary-small" disabled={busy} onClick={() => onUse(template)}>
                    {busy ? "Starting…" : "Use template"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!templates.length && (
        <div className="template-empty">
          <span aria-hidden="true">◇</span>
          <h2>No templates in this space</h2>
          <p>Open a page and choose “Save as template” to add one.</p>
        </div>
      )}
    </main>
  );
}
