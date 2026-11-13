# Email attachment ingestion and reading

Inbound email attachments remain linked to their original message. `read_email`
registers pinned document/version handles usable by `read_document`,
`fetch_documents` and `find_in_document`, including in later chat turns.
Unfiled attachments require access to their parent email; filed documents also
require current matter access. Read grants do not authorize editing or sending.
Filing an existing attachment later preserves its received version and original
email link. Recovery keeps its current matter and newer document versions intact;
archived matters and revoked memberships remain inaccessible.

## Supported input

All existing document-upload formats use the shared storage/conversion pipeline.
PNG/JPEG/WebP images and scanned PDF pages are transcribed on first analysis
through the chat's selected model and credentials, with no tools available to
that call. GIF reading covers the first frame and explicitly reports partial
coverage. Archives and attached .eml/.msg messages are retained but not expanded.
HTML-only email is converted to inert text without fetching remote resources.

Originals are limited to 100 MB, matching document intake. Visual reading is
limited to 30 MB and 90 pages and reports partial coverage explicitly. Native
text and visual transcription preserve page labels. Visual transcriptions must
be checked against originals before treating wording as a verified quotation.

## Persistence and recovery

Migration 044 adds a per-MIME-part manifest and a version/hash/extractor-keyed
extraction cache. Complete visual results are cached; transient and partial
failures can be retried by reading again. Cache rows cascade with document
versions during retention. File deletion tombstones the manifest so recovery
cannot resurrect deliberately removed documents.

The leased retry worker runs every 30 seconds, independently of PI automation.
`EMAIL_ATTACHMENT_WORKER_ENABLED=false` disables background retries. Intake
reuses upload validation and ClamAV configuration, including fail-closed scanning
when `BETA_MODE` or `UPLOAD_SCANNING_REQUIRED` is enabled. Downloads remain
private and attachment disposition is enforced. Retry attempts log IDs/codes,
not email bodies, extracted text or filenames.

## Deploy and repair

1. Run the existing transactional migration runner with `DATABASE_URL` configured:
   `npm run migrate` from `backend`. Apply migration 044 before deploying readers.
2. Deploy backend and frontend together using your usual
   deployment pipeline. Verify readiness and the attachment worker logs.
3. Inspect a targeted repair: `npm run repair:email-attachments -- --email-id=<id>`.
4. Apply it: `npm run repair:email-attachments -- --email-id=<id> --apply`.
5. For older inbox content, omit `--email-id` to sweep; `--after-id=<id>` resumes
   after the last logged completed message. The script never sends email.
6. Open the original email, read an attachment in chat, reload the chat and read
   it again. Confirm citation/version identity, original download, and retries.

Monitor manifest state counts, `error_code`, attempts and `next_attempt_at`.
An unavailable provider must not erase existing originals or attachment metadata.
The rollout is additive; the existing successful attachment-ref array is retained
for outbound and automation compatibility. Roll back application code rather than
removing the manifest/cache tables or their deletion tombstones.

## Verification

`npm run test:email-ingestion` exercises MIME bytes, duplicate filenames,
provider failures, idempotence, deletion/access restrictions, pinned real PDF
reading across turns, mixed native/scanned pages and model failure reporting.
Run `npm run test:email-attachments`, backend/frontend type checks and frontend
lint as additional release gates. Tests use synthetic documents and stubbed
provider calls, never private mailbox content.
