-- Adviser-authored module catalogue work remains draft-only in D1.
-- docs/modules/*.md is the authored source and the generated JavaScript
-- manifest is the sole runtime catalogue.

CREATE TABLE IF NOT EXISTS module_catalogue_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'manifest_edit',
    'recognition_variant',
    'new_engine',
    'new_goal'
  )),
  module_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'invalid',
    'specification_valid',
    'ready_for_patch',
    'exported_for_review'
  )),
  base_manifest_version TEXT NOT NULL,
  base_manifest_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS module_catalogue_validation_runs (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
  status TEXT NOT NULL CHECK (status IN (
    'invalid',
    'specification_valid',
    'ready_for_patch'
  )),
  findings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES module_catalogue_drafts(id)
);

CREATE TABLE IF NOT EXISTS module_catalogue_audit (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  metadata_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES module_catalogue_drafts(id)
);

CREATE INDEX IF NOT EXISTS idx_module_catalogue_drafts_status_updated
  ON module_catalogue_drafts(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_module_catalogue_drafts_module_updated
  ON module_catalogue_drafts(module_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_module_catalogue_validation_draft_revision
  ON module_catalogue_validation_runs(draft_id, draft_revision, created_at);

CREATE INDEX IF NOT EXISTS idx_module_catalogue_audit_draft_created
  ON module_catalogue_audit(draft_id, created_at);
