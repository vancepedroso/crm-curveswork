-- Links a project to the job it was created from, so the project detail page
-- can show that job's photo library instead of a separate upload widget.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_job ON projects(job_id);
