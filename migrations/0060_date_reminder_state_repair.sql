-- Replay the legacy absence-state repair on databases that already applied 0059.
UPDATE date_reminders
SET state='canceled', generation=generation+1, claim_id=NULL, claimed_at=NULL,
    delivery_receipt_id=NULL, updated_at=strftime('%s','now')*1000
WHERE state='missing';
