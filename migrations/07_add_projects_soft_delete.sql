-- Soft-delete for projects: deleting a project now flags it instead of
-- removing the row, so estimates/quotes/geometry history isn't lost.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_projects_is_deleted ON projects(is_deleted);
