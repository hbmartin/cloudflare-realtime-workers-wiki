-- Public thumbnail authorization needs to distinguish embedded diagram cards
-- from generic page mentions stored in page_references.
CREATE TABLE linked_diagram_references (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  projection_seq INTEGER NOT NULL,
  PRIMARY KEY (source_page_id, target_page_id)
);

CREATE INDEX idx_linked_diagram_references_target
  ON linked_diagram_references(target_page_id, source_page_id);
