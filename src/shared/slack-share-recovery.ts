// Shared by the guarded migration runner and durable Worker recovery.
const shareRecoverySelectSql = `SELECT o.id,o.attempts,o.payload_json,o.enqueued_at,o.available_at,o.slack_redrive_due_at,o.slack_claim_recheck_at,
  receipt.id receipt_id,receipt.response_delivery_state,receipt.response_delivery_error,receipt.response_delivery_attempted_at,
  link.user_id userId,link.better_auth_account_id accountId,link.verified_at verifiedAt,link.slack_user_id slackUserId,
  json_object('userId',link.user_id,'accountId',link.better_auth_account_id,
    'verifiedAt',link.verified_at,'slackUserId',link.slack_user_id) identity_json
FROM outbox o JOIN slack_interaction_receipts receipt ON receipt.id=json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.receiptId')
JOIN slack_installations installation ON installation.id=receipt.installation_id
JOIN slack_authorized_user_links link ON link.installation_id=installation.id
WHERE o.topic='slack_share_response' AND json_valid(o.payload_json)
  AND o.slack_scope_paused_at IS NULL AND receipt.outcome='accepted' AND receipt.denial_sent_at IS NULL
  AND (receipt.response_delivery_state IS NULL OR receipt.response_delivery_state='pending'
    OR (receipt.response_delivery_state='blocked' AND receipt.response_delivery_error='request_identity_unavailable'
      AND receipt.response_delivery_attempted_at IS NULL))
  AND installation.id=json_extract(o.payload_json,'$.installationId')
  AND installation.generation=json_extract(o.payload_json,'$.generation') AND installation.auth_error IS NULL
  AND link.installation_generation=installation.generation AND link.slack_user_id=json_extract(o.payload_json,'$.userId')
  AND link.migration_state='verified' AND link.verification_method='slack_openid'
  AND link.verified_at<=receipt.received_at AND link.authorization_started_at<=receipt.received_at
  AND (SELECT count(*) FROM slack_authorized_user_links candidate WHERE candidate.installation_id=installation.id
    AND candidate.slack_user_id=link.slack_user_id)=1`;

export const legacyShareRecoverySelectSql = `${shareRecoverySelectSql}
  AND json_type(o.payload_json,'$.identity') IS NULL`;
// A previously persisted identity is recoverable only if it is the same proof.
export const blockedShareRecoverySelectSql = `${shareRecoverySelectSql}
  AND receipt.response_delivery_state='blocked' AND receipt.response_delivery_error='request_identity_unavailable'
  AND receipt.response_delivery_attempted_at IS NULL
  AND (json_type(o.payload_json,'$.identity') IS NULL OR (
    json_type(o.payload_json,'$.identity')='object'
    AND json_extract(o.payload_json,'$.identity.userId')=link.user_id
    AND json_extract(o.payload_json,'$.identity.accountId')=link.better_auth_account_id
    AND json_extract(o.payload_json,'$.identity.verifiedAt')=link.verified_at
    AND json_extract(o.payload_json,'$.identity.slackUserId')=link.slack_user_id))`;

export const legacyShareRecoveryPreflightSql = `
CREATE TABLE IF NOT EXISTS slack_share_recovery_preflight (
 id TEXT PRIMARY KEY,attempts INTEGER,payload_json TEXT,enqueued_at INTEGER,available_at INTEGER,
 slack_redrive_due_at INTEGER,slack_claim_recheck_at INTEGER,receipt_id TEXT,response_delivery_state TEXT,
 response_delivery_error TEXT,response_delivery_attempted_at INTEGER,userId TEXT,accountId TEXT,verifiedAt INTEGER,
 slackUserId TEXT,identity_json TEXT);
CREATE INDEX IF NOT EXISTS slack_share_recovery_preflight_receipt ON slack_share_recovery_preflight(receipt_id);
DELETE FROM slack_share_recovery_preflight;
INSERT INTO slack_share_recovery_preflight ${legacyShareRecoverySelectSql};
UPDATE outbox SET payload_json=json_set(payload_json,'$.identity',json((SELECT identity_json FROM slack_share_recovery_preflight WHERE id=outbox.id))),
 attempts=attempts+1,enqueued_at=NULL,available_at=unixepoch('subsec')*1000,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error=NULL
WHERE id IN (SELECT id FROM slack_share_recovery_preflight)
 AND slack_scope_paused_at IS NULL AND EXISTS(SELECT 1 FROM slack_share_recovery_preflight repair
 WHERE repair.id=outbox.id AND repair.attempts=outbox.attempts AND repair.payload_json=outbox.payload_json
 AND repair.enqueued_at IS outbox.enqueued_at AND repair.available_at=outbox.available_at
 AND repair.slack_redrive_due_at IS outbox.slack_redrive_due_at AND repair.slack_claim_recheck_at IS outbox.slack_claim_recheck_at
 AND EXISTS(SELECT 1 FROM slack_interaction_receipts receipt WHERE receipt.id=repair.receipt_id
 AND receipt.outcome='accepted' AND receipt.denial_sent_at IS NULL
 AND receipt.response_delivery_state IS repair.response_delivery_state
 AND receipt.response_delivery_error IS repair.response_delivery_error
 AND receipt.response_delivery_attempted_at IS repair.response_delivery_attempted_at))
 AND EXISTS(SELECT 1 FROM (${legacyShareRecoverySelectSql}) proof
 WHERE proof.id=outbox.id AND proof.identity_json=(SELECT identity_json FROM slack_share_recovery_preflight WHERE id=outbox.id));
UPDATE slack_interaction_receipts SET response_delivery_state='pending',response_delivery_error=NULL
WHERE id IN (SELECT receipt_id FROM slack_share_recovery_preflight)
 AND outcome='accepted' AND response_delivery_state='blocked' AND response_delivery_error='request_identity_unavailable'
 AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL
 AND EXISTS(SELECT 1 FROM slack_share_recovery_preflight repair JOIN outbox o ON o.id=repair.id
 WHERE repair.receipt_id=slack_interaction_receipts.id AND o.attempts=repair.attempts+1
 AND o.payload_json=json_set(repair.payload_json,'$.identity',json(repair.identity_json)) AND o.slack_scope_paused_at IS NULL);
DROP TABLE slack_share_recovery_preflight;
`;

// Match the authorization view and grant-start backfill that pending foundation
// migrations will install, so older upgrades also avoid 0074's unindexed ledger.
export function shareRecoveryPreflightSql(pending: readonly string[]) {
  let sql = legacyShareRecoveryPreflightSql;
  if (pending.includes("0072_slack_link_authorization_started_at.sql"))
    sql = sql.replaceAll("link.authorization_started_at", "coalesce(link.verified_at,link.linked_at)");
  if (pending.includes("0071_slack_authorization_cleanup.sql")) {
    const authorized = `(SELECT link.* FROM slack_user_links link
      JOIN account_security security ON security.user_id=link.user_id AND security.recovery_required=0 AND security.codes_saved=1
      JOIN slack_installations installation ON installation.id=link.installation_id
        AND installation.generation=link.installation_generation AND installation.disconnected_at IS NULL
      JOIN workspace_members member ON member.workspace_id=installation.workspace_id AND member.user_id=link.user_id
      WHERE (EXISTS(SELECT 1 FROM twoFactor factor WHERE factor.userId=security.user_id AND factor.verified=1)
        OR EXISTS(SELECT 1 FROM passkey factor WHERE factor.userId=security.user_id))
      AND ((link.migration_state='legacy' AND link.verification_method='legacy_command')
        OR EXISTS(SELECT 1 FROM account oauth WHERE oauth.id=link.better_auth_account_id AND oauth.userId=link.user_id
          AND oauth.providerId='slack' AND oauth.accountId=installation.team_id||':'||link.slack_user_id)))`;
    sql = sql.replaceAll("slack_authorized_user_links", authorized);
  }
  return sql;
}
