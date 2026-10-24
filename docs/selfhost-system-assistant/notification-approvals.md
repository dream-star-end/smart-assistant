# Exact notification read approvals

`notifications.mark-read` takes one decimal `messageId`; `notifications.read-all` takes `{}`. Both prepare a proposal for the ordinary native system-action approval sheet. Only the account's visible notifications are eligible: own messages or broadcasts created after account creation, excluding expired messages.

Prepare freezes exact IDs and PostgreSQL xmin versions; it stores no notification body. Read-all freezes the full current unread set and never expands it when the user confirms. New arrivals remain unread. Single-message title text is untrusted display data, with control characters removed for the preview. Both operations retain the messages and send no email or external message.

The receipt transaction locks the approved rows, rechecks visibility/expiry/version, inserts read markers for only those IDs, and records a positive action receipt on the same connection. A deleted/expired/revised message aborts the full batch. xmin also changes for unrelated email-worker updates, which can cause a conservative conflict and require a fresh proposal. Other devices having marked the same messages read is an idempotent noop, not proof of this action's receipt.

A lost COMMIT reply remains unknown. Exact positive receipt reconciliation may restore success without another write; current read-state equality alone cannot clear the unknown fence. Existing manual markRead/readAll behavior is retained. The original encrypted ledger payload size bound still applies to very large frozen sets; explicit IDs can be handled in batches rather than silently truncating the scope.

The seven new real-PG cases use new private synthetic schemas and the existing required receipt proof, whose exact complete plan grows from5 to12 with zero failures, cancellations, skips or todos. Six additional unit cases join the existing executor proof. No runtime activation or production DB operation is performed by this PR. Inherited migration `0327_system_action_receipts.sql` is additive and must be formally applied and registered before activation.
