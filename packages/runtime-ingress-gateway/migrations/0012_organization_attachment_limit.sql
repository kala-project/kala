ALTER TABLE organizations
  ADD COLUMN attachment_max_bytes integer NOT NULL DEFAULT 2097152
  CONSTRAINT organizations_attachment_max_bytes_check
  CHECK (attachment_max_bytes IN (2097152, 4194304, 8388608, 16777216));
