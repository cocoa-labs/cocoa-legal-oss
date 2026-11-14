# How Cocoa Legal works

This guide explains the moving parts behind the [README](../README.md) tour: what runs where, what happens when you ask Quill something, how changes are recorded and document edits undone, how e-signature works, and what controlled-beta mode protects. The diagrams are written in [Mermaid](https://mermaid.js.org/), so GitHub draws them and you can edit them as text.

## The pieces

```mermaid
flowchart LR
    browser["Browser"] --> frontend["Frontend<br/>Next.js"]
    frontend -->|"API calls, streamed replies"| backend["Backend<br/>Express + TypeScript"]
    frontend -->|"sign-in"| auth["Supabase Auth"]
    backend --> db[("Supabase Postgres<br/>matters, documents, chats,<br/>operations, audit trail")]
    backend --> storage[("S3-compatible storage<br/>R2, S3 or RustFS")]
    backend --> office["LibreOffice<br/>DOCX → PDF"]
    backend --> clamav["ClamAV<br/>upload scanning"]
    backend --> models["Model providers<br/>Anthropic, Google,<br/>OpenAI, OpenRouter"]
    backend -.->|"optional"| extras["Search APIs, Gmail and<br/>Calendar, AssemblyAI"]
```

- The **frontend** is a Next.js app. It signs people in through Supabase Auth and talks to the backend over HTTPS with the user's session token.
- The **backend** does the real work. It reads and edits documents, calls models, converts files with LibreOffice, scans uploads with ClamAV and keeps an audit trail in Postgres. Background workers handle document generation, inbound email, calendar reminders and transcription.
- **Storage** holds the files: originals, every version, converted PDFs, signed copies. Files reach the browser through short-lived presigned storage links, or through signed download links that the backend checks before serving the file.
- **Models** are pluggable. Each instance or each user can bring keys for Anthropic, Google, OpenAI or OpenRouter. If a model call fails, the backend can retry it on another model that has a key and is marked verified and healthy; set `MODEL_RUNTIME_FAILOVER_ENABLED=false` to turn that off.

## One question to Quill

```mermaid
sequenceDiagram
    actor You
    participant App as Frontend
    participant API as Backend
    participant Model as Model provider
    participant Store as Postgres + storage
    You->>App: Ask about a matter
    App->>API: POST /projects/{id}/chat (streamed reply)
    API->>Store: Load the matter's documents and history
    loop Up to 10 rounds, until the answer is ready
        API->>Model: Conversation + available tools
        Model-->>API: Text, or a tool call
        API->>Store: Run the tool (find, read, edit, draft…)
        Store-->>API: Result
    end
    API-->>App: Streamed text, citations, tool cards
    App-->>You: Rendered answer, edits and approval cards
```

Quill answers in a loop of up to 10 rounds. The model can call tools: list the matter's documents, find and read passages, highlight, edit, draft, or prepare an email, calendar invite or signature request. The backend runs each tool and feeds the result back until the model produces an answer, and the text streams to the browser as the model writes it. Citations point to the exact passages it read. Outside a matter, the same loop runs behind `POST /chat`.

## Every change is recorded; document edits can be undone

```mermaid
stateDiagram-v2
    direction LR
    [*] --> running: document edit<br/>(no approval needed)
    [*] --> pending_approval: email, signature, calendar<br/>and a few other actions
    pending_approval --> approved: you approve
    pending_approval --> cancelled: you cancel
    approved --> running
    running --> succeeded
    running --> failed
    succeeded --> undone: document edits only,<br/>undo restores the earlier version
    succeeded --> [*]
    failed --> [*]
    undone --> [*]
    cancelled --> [*]
```

Each change Quill makes, and each message it prepares, is an **operation** in a ledger, with who asked, what changed and when.

- **Document edits** apply immediately as tracked changes in a new version, so you review them like a colleague's redline. Undo restores the version the edit started from. Only changes to documents can be undone.
- **Anything Quill sends to other people** waits in an approval card until a person approves it: an email, a signature request or a calendar invitation. A few other actions also wait for approval.
- **Versions are never overwritten.** The History view shows every version, which conversation produced it, and any forks.

## E-signature

```mermaid
sequenceDiagram
    actor Owner
    participant API as Backend
    actor Signer
    Owner->>API: "Send this for signature to …"
    API-->>Owner: Approval card (pending approval)
    Owner->>API: Approve & send
    API->>API: Convert to PDF, stamp beta notice in beta mode
    API->>Signer: Email with a personal signing link
    Signer->>API: Open link, consent, type or draw a signature
    API->>API: All signed: apply the cryptographic PDF signature,<br/>build the Certificate of Completion
    API-->>Owner: Executed PDF + certificate
    API-->>Signer: Link to download their copy
```

A signature request moves from `pending_approval` to `sent`, `partially_signed` and `completed`. Cancelling it sets it to `cancelled`. Signing links expire after 14 days by default.

- **The signed PDF** carries a PKCS#7 signature from the deployment's certificate (see [DEPLOY.md](../DEPLOY.md#signing-identity)).
- **The Certificate of Completion** records document hashes, signers, times and consent.
- **Sending needs the Gmail integration.** Without it, Quill can prepare a request, but approving it returns an error and nothing is sent.
- **Not legally reviewed.** The engine has not been reviewed for ESIGN, UETA or eIDAS compliance. See [Responsible use](../README.md#responsible-use).

## Controlled-beta mode

```mermaid
flowchart TD
    upload["Upload a document"] --> p1{"Data policy accepted?"}
    p1 -->|"no"| wait["Blocked until an owner<br/>or admin accepts the policy"]
    p1 -->|"yes"| scan{"ClamAV scan clean?"}
    scan -->|"no, or scanner down"| refuse["Refused"]
    scan -->|"yes"| stored["Stored"]
    send["Email, signature request<br/>or calendar invite"] --> p2{"Data policy accepted?"}
    p2 -->|"no"| wait
    p2 -->|"yes"| invite{"Signature or calendar<br/>invitation?"}
    invite -->|"yes"| list{"Recipient on the<br/>approved list?"}
    list -->|"no"| block["Blocked"]
    list -->|"yes"| go["Allowed (signatures labelled<br/>nonbinding test signatures)"]
    invite -->|"no"| go
```

`backend/.env.example` sets `BETA_MODE=true`; if the variable is missing, the safeguards are off. In beta mode:

- Uploads must pass a virus scan.
- An organization owner or admin accepts a data-handling policy before uploads and outbound email.
- Signature and calendar invitations go only to listed addresses or domains.
- Signatures are labelled as nonbinding test signatures.

Set `BETA_MODE=false` to turn these off. Upload scanning stays on while `UPLOAD_SCANNING_REQUIRED=true`.

## What runs where

```mermaid
flowchart LR
    subgraph prod["A real deployment"]
        direction TB
        fe2["Frontend<br/>Vercel or a container"] --> be2["Backend with LibreOffice<br/>container or Railway"]
        be2 --> sb2["Supabase Cloud"]
        be2 --> s3b["R2 or S3"]
        be2 --> av2["ClamAV service"]
    end
    subgraph local["Your computer"]
        direction TB
        fe1["Frontend :3003"] --> be1["Backend :3001<br/>with LibreOffice"]
        be1 --> sb1["Supabase CLI<br/>API :54321, Postgres :54322"]
        be1 --> s3a["RustFS :9000"]
        be1 --> av1["ClamAV :3310"]
    end
```

Locally, Docker Compose runs the frontend, backend, RustFS and ClamAV on `127.0.0.1`, next to the Supabase CLI stack (which listens on every interface with well-known demo keys), so keep it to one machine and test data. A real deployment swaps in managed pieces; [DEPLOY.md](../DEPLOY.md) walks through each one.
