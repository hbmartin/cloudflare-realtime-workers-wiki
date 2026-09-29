CREATE INDEX IF NOT EXISTS idx_oauth_staged_receipt_page
  ON oauth_operation_receipts(json_extract(result_json,'$.pageId'))
  WHERE tool_name='create_page' AND json_extract(result_json,'$.status')='staged';
