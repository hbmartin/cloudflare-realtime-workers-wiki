-- Normalize the temporary bare-page receipt format so runtime decoding can
-- require an explicitly versioned envelope after the compatibility window.
UPDATE page_move_receipts
   SET response_json = json_object(
     'pageMoveReceiptVersion', 1,
     'page', json(response_json)
   )
 WHERE CASE
         WHEN json_valid(response_json) THEN
           CASE
             WHEN json_type(response_json) = 'object' THEN
               json_type(response_json, '$.pageMoveReceiptVersion') IS NULL
             ELSE 0
           END
         ELSE 0
       END;

PRAGMA optimize;
