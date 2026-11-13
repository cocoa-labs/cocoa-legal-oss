# Recordings & Transcription — onboarding runbook

Feature: record (MacBook mic) or upload (mp3/wav/m4a/webm/ogg/flac) → AssemblyAI transcription with speaker labels → Quill summary + action items → on-demand voice briefing (OpenAI TTS), timeline image (`gpt-image-2`), and draft-then-approve email with the transcript PDF attached.

## 1. One-time setup (required before anything works end-to-end)

1. **Migration 025** creates the recordings tables. `npm run migrate` applies it with every other migration (see the README).
2. **Create an AssemblyAI account** (free tier is fine to start) at assemblyai.com → copy the API key → add to `backend/.env`:
   ```
   ASSEMBLYAI_API_KEY=<your key>
   ```
3. Restart the backend once (`npm run dev` in `backend/`). Boot log should show `[recordings] scheduler started`. Until steps 1–2 are done, the feature degrades silently by design: the worker declines to start without the key, and every route/tick no-ops without the tables.

Optional env knobs (defaults are sensible): `OPENAI_TTS_MODEL` (gpt-4o-mini-tts), `OPENAI_TTS_VOICE` (alloy), `OPENAI_IMAGE_MODEL` (gpt-image-2), `RECORDINGS_POLL_INTERVAL_MS` (15000), `RECORDINGS_MAX_RETRIES` (3), `RECORDINGS_WORKER_ENABLED` (unset = on when key present). Voice briefing + timeline image use your existing `OPENAI_API_KEY`.

## 2. First-run smoke checklist (logged in, ~10 minutes)

Chat surface:
1. Open any chat → mic button beside Attach → consent confirm → record ~30s of dictation → Stop. A recording card appears in the conversation immediately and advances `Queued → Transcribing → Summarizing → Ready`; on Ready, a durable summary message posts (survives reload, renders once — no duplicated text).
2. From a brand-new empty chat, record → it should materialize the conversation, navigate to it, and show the card; the chat appears in Assistant History.
3. Drag an .mp3 into the composer → consent confirm gates the upload; Cancel discards without uploading.
4. Ask Quill: "What did we agree in that recording?" → it should use `get_recording` and answer with speaker attributions. Also try "make me a voice briefing of it" and "draft the email" (email shows the approval card — nothing sends until you approve).

Library surface:
5. Sidebar → Recordings → record and upload from the page; rows advance status on ~5s refresh.
6. Open a ready recording: play audio, check speaker-labeled transcript, edit title, link a matter, toggle an action item (persists on reload).
7. Generate voice briefing (~10–30s) → plays inline. Generate timeline image → renders inline (this is `gpt-image-2`; if OpenAI returns an org-verification error it appears verbatim here).
8. Draft email → pending block → Approve & send → arrives from the agent mailbox (`GMAIL_AGENT_ADDRESS`) with the transcript PDF attached.
9. Glance at both pages in dark mode (transcript/summary render as light content cards by design — confirm acceptable).
10. Deposition-scale check when convenient: a 1h+ file transcribes fine; mic recordings never hit the 250 MB upload cap (~28 MB/hour).

## 3. Known limitations (v1, by design)

- Virtual calls: the browser can't capture Mac system/speaker audio — use speakerphone so the mic hears both sides.
- No live transcription; processing starts when you stop.
- Safari records mp4/aac via a fallback; Chrome is the primary target.
- Raw audio is kept in R2 indefinitely (explicit Delete removes it); consent confirm is stored per recording (`consent_ack_at`).
- Regenerating a voice briefing/timeline (force) leaves the previous artifact document in place (housekeeping follow-up).
