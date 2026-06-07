-- BUD blob descriptor `dim` attribute: pixel dimensions for images and videos
-- stored as "<width>x<height>" (e.g. "640x480"). NULL for non-visual blobs or
-- when dimensions could not be determined.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS form, so the migration runner tolerates
-- the "duplicate column name" error to keep this statement safe to re-run.
ALTER TABLE blobs ADD COLUMN dim TEXT;
