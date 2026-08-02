/**
 * Browser-safe protocol limits.
 *
 * Keep these constants outside frames.ts: frames owns TypeBox schemas, while
 * browser controls only need the shared numeric contracts and must not pull
 * the schema runtime into the first-load bundle.
 */

/** Maximum durable attachments carried by one inbound message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8
