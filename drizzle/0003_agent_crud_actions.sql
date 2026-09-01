DROP TABLE IF EXISTS agent_action_proposals_next;

CREATE TABLE agent_action_proposals_next (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_call_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN (
      'add_company', 'add_job', 'add_company_job',
      'update_company', 'update_job', 'delete_company', 'delete_job'
    )
  ),
  base_state_version TEXT NOT NULL,
  target_company_id TEXT NOT NULL DEFAULT '',
  target_job_id TEXT NOT NULL DEFAULT '',
  target_fingerprint TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  confirmation_nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'awaiting_confirmation', 'executing', 'executed', 'cancelled',
      'expired', 'conflict', 'failed'
    )
  ),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  confirmed_at_ms INTEGER,
  completed_at_ms INTEGER,
  execution_lease_expires_at_ms INTEGER,
  execution_idempotency_key TEXT NOT NULL DEFAULT '',
  result_state_version TEXT NOT NULL DEFAULT '',
  failure_code TEXT NOT NULL DEFAULT '',
  feedback TEXT CHECK (feedback IN ('correct', 'incorrect')),
  feedback_at_ms INTEGER,
  UNIQUE(account_key, idempotency_key)
) WITHOUT ROWID;

INSERT OR IGNORE INTO agent_action_proposals_next (
  id, account_key, session_id, source_call_id, idempotency_key, action_kind,
  base_state_version, target_company_id, target_job_id, target_fingerprint,
  payload_json, confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
  confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
  execution_idempotency_key, result_state_version, failure_code, feedback, feedback_at_ms
)
SELECT
  id, account_key, session_id, source_call_id, idempotency_key, action_kind,
  base_state_version, target_company_id, target_job_id, target_fingerprint,
  payload_json, confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
  confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
  execution_idempotency_key, result_state_version, failure_code, feedback, feedback_at_ms
FROM agent_action_proposals;

DROP TABLE agent_action_proposals;
ALTER TABLE agent_action_proposals_next RENAME TO agent_action_proposals;

CREATE INDEX IF NOT EXISTS agent_action_proposals_account_idx
  ON agent_action_proposals(account_key, status, expires_at_ms);
