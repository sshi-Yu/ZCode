# image-generation

Local Desktop Host owns image settings, accepted jobs and original PNG assets. Credentials are a dedicated injected get/set/delete port; reads reveal only configured/modelId. No chat/provider default, session, workspace, guest filesystem or remote Host state participates.

```text
confirmed immutable input → SQLite BEGIN IMMEDIATE → request-ID receipt + single running row
                                              ↓
tracked Host dispatch → durable one-way dispatch fence → exactly one bounded Images POST
                                              ↓
original PNG write + fsync + rename → SQLite success + opaque asset ID + bounded preview
read/replay ← persisted projection (never re-dispatch)
```

- Factory receives explicit appConfigDir, main-process appRunId shared across Window Hosts, host-network fetch, narrow credential port and a PNG preview codec. Production endpoint is fixed. Only an explicitly injected development/test fixture can target literal loopback HTTP/HTTPS; credentials/URL fragments/queries are prohibited.
- The codec must fully decode PNG using the host's existing image dependency and return a PNG at most 384 pixels per edge and 128 KiB. Original input is prevalidated (PNG container/CRC, at most 16 MiB, 2048 pixels per edge and 4,194,304 pixels). It must never replace original bytes. Preview is revalidated.
- start returns running after durable admission; a tracked task handles every rejection. Request IDs are 1..128 URL-safe identifier characters, prompts are trimmed 1..4000 characters, modelId is exactly gpt-image-1. Identical replay returns the stored job, conflicting replay rejects. Admission is protected by an immediate transaction and a unique partial running index, across instances/processes/windows.
- Before network IO the dispatch bit is committed and never cleared. No retry, redirect, resume-on-read, or replay dispatch exists. A 120-second deadline covers fetch/body/codec/write work. Confirmed HTTP 4xx failures other than timeout/disconnect 408/499 are failed; ambiguous transport/server/response/persistence outcomes after dispatch are outcome_unknown. Errors are constant safe messages, never raw exceptions, bodies or credentials.
- Running rows record appRunId, PID and a process-lifetime token. Another instance in the same live process cannot steal a tracked task. A dead owner (including a dead Window Host in the same app run) is reconciled without re-sending: pre-dispatch rows fail, fenced rows become unknown. Another live PID is never stolen merely because appRunId differs. If a PID was reused and identity cannot be established, admission conservatively stays blocked; no timer/lease guesses at safety.
- SQLite is the only job/asset authority. Files precede the success transaction; a crash may leave an unreferenced opaque PNG, never a success pointing to a partially written file. Schema v1 only creates new tables/indexes; no destructive migrations or existing database changes. Rollback is removal of this isolated module/database after retaining assets as needed.
- Initialization is lazy on the first read/start/readImage: directory creation, canonical path, schema creation and startup recovery. A failed initialization is never cached. Only its rejected promise is dropped, so the next call retries initialization from the start (for example after a transient directory or database failure is resolved). This path never retries an accepted job, a dispatch or a result write; startup recovery runs inside its transaction, so a failed attempt rolls back and leaves no partial mutation.
- Lifecycle logging uses the service logger with constant event names plus server-generated job IDs, statuses and sanitized error codes. Prompts, request IDs, credentials, upstream bodies, raw exception messages and local paths are never logged.
- read returns the latest 24 jobs plus the active job if needed; previews are at most 128 KiB each and aggregate projection is bounded near 4 MiB. Older receipts/assets remain durable for idempotency/export. readImage accepts only a succeeded opaque asset ID and returns at most 16 MiB original bytes to trusted Renderer; no arbitrary path API exists. Renderer owns the platform save dialog and gives the extension only its save result.
- Acceptance is PLM-GENIMAGE-WORKSPACE with an isolated directory and injected loopback fixture. App business unit/contract tests are intentionally not added.
