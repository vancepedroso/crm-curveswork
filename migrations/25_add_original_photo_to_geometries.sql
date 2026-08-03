-- Previously the only image ever persisted for a traced roof was the
-- flattened canvas snapshot (photo + drawing rendered together into one
-- PNG, used to embed the roof plan in generated quotes). Reopening a
-- project to edit its measurement fell back to that same flattened image
-- as the tracing background, silently baking the *previous* session's
-- drawing into the pixels — deleting the traced shapes on top of it never
-- removed those old lines, since they were part of the image, not data.
-- original_photo_url stores the clean, undrawn-on photo separately so
-- re-editing has something real to trace on top of again.
ALTER TABLE project_geometries ADD COLUMN original_photo_url TEXT;
