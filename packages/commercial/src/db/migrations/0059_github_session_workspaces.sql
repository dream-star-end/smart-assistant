-- 用户每个 session 选定的 GitHub 项目(repo + branch);加 selection_version + status 状态机
-- 容器拉到 selection 后在 /workspace/<sid>/repo-v<version>/ 做 atomic clone + rename
CREATE TABLE github_session_workspaces (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  selection_version BIGINT NOT NULL DEFAULT 1,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  default_branch TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  head_sha TEXT,
  error_code TEXT,
  error_message TEXT,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id),
  CONSTRAINT gsw_session_id_chk CHECK (length(session_id) BETWEEN 8 AND 80),
  CONSTRAINT gsw_owner_chk CHECK (owner ~ '^[A-Za-z0-9._-]+$' AND length(owner) BETWEEN 1 AND 39),
  CONSTRAINT gsw_repo_chk CHECK (repo ~ '^[A-Za-z0-9._-]+$' AND length(repo) BETWEEN 1 AND 100),
  CONSTRAINT gsw_branch_chk CHECK (length(branch) BETWEEN 1 AND 250),
  CONSTRAINT gsw_status_chk CHECK (status IN ('pending','cloning','ready','failed','cleared'))
);
CREATE INDEX github_session_workspaces_user_idx ON github_session_workspaces(user_id);
COMMENT ON TABLE github_session_workspaces IS 'Per-session selected GitHub repo+branch. clone_url 不存,按 owner/repo 现场拼。';
