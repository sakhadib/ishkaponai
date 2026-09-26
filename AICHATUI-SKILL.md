---
name: ai-chat-ui
description: How to design, organize, and present information in an AI chat interface. Use when building or reworking a chat surface for an LLM — message list, streaming output, composer, tool/thinking display, history — especially in a TypeScript + Electron desktop app.
license: MIT
author: ISHKAPON
---

> **Provenance and licence.** Written by ISHKAPON for this project, and released
> under the [MIT License](LICENSE) like the rest of the repository. It is a design
> reference, not a dependency: no code imports it, and `docs/ui-direction.md`
> records which of its recommendations this project deliberately did *not* follow.
> It is kept here because a decision is only auditable if the alternative that was
> rejected is still readable.

# Designing an AI Chat Interface

A chat UI is not a messaging app with a robot in it. It is a **reading surface for
generated text, wrapped in controls that give the user agency over generation.**
Almost every mistake comes from forgetting one of those two halves: interfaces that
are pretty but give no control, or interfaces full of buttons where the answer is
unreadable.

Three questions the interface must answer at all times, without the user asking:

1. **Is anything happening?** (streaming, spinner, stage label)
2. **What is the system doing right now?** (thinking / searching / calling a tool / writing)
3. **Can I stop, steer, or undo it?** (stop, edit, regenerate, branch)

If the answer to any of these is "the user has to guess," the model will feel
unreliable even when it is not.

---

## 1. Anatomy — the five regions

Build in this order. Each region has one job; do not let jobs leak between them.

| Region | Job | Never |
| --- | --- | --- |
| **Sidebar** | Navigate between conversations | Hold per-message actions |
| **Header** | Identify *this* conversation + its capabilities (model, tools, context) | Be a second toolbar of unrelated buttons |
| **Message list** | Readable transcript | Move under the user while they read |
| **Composer** | Compose, attach, send, **stop** | Float over the last message |
| **Inspector** (optional) | Sources, tool calls, raw output, token cost | Be the only place a critical status lives |

Desktop-specific: a resizable sidebar is expected (persist its width). The composer is
**docked** to the bottom of the message column, not floating. Give the message column a
max width of ~`680–760px` and center it — full-window-width lines are unreadable on a
27" monitor. The window may be 2000px wide; the *text* must not be.

### Empty state
Never show a bare input with "Ask anything…". Show: a one-line statement of what this
assistant can do, 3–4 suggestion chips drawn from real capabilities, and any active
constraint (model name, offline/local mode, attached folder). The empty state is the
only onboarding most users will read.

---

## 2. Model the data before the pixels

Everything downstream — streaming, editing, branching, virtualization — is easy or
impossible depending on this shape. A message is **not a string**. It is an ordered
list of typed parts, because a single assistant turn interleaves prose, reasoning,
tool calls, and errors.

```ts
export type MessageId = string & { readonly __brand: 'MessageId' };

export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; collapsed: boolean }
  | { kind: 'tool_call'; toolName: string; args: unknown; callId: string }
  | { kind: 'tool_result'; callId: string; ok: boolean; result: unknown }
  | { kind: 'attachment'; fileId: string; mime: string; name: string; bytes: number }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export type MessageStatus =
  | { phase: 'pending' }                       // queued, not sent
  | { phase: 'streaming'; startedAt: number }
  | { phase: 'complete'; finishReason: 'stop' | 'length' | 'tool' }
  | { phase: 'stopped' }                       // user pressed stop
  | { phase: 'failed'; error: string; retryable: boolean };

export interface Message {
  id: MessageId;
  role: 'user' | 'assistant' | 'system';
  parts: ContentPart[];
  status: MessageStatus;
  createdAt: number;
  parentId: MessageId | null;   // enables edit + regenerate as a tree
  model?: string;               // which model produced it — pin it, do not infer later
  usage?: { inputTokens: number; outputTokens: number };
}
```

**Rules that follow from this shape:**

- `parentId` makes the conversation a **tree**, not an array. Editing a user message or
  regenerating a reply creates a sibling, never destroys history. Render the active
  path; show `‹ 2/3 ›` pagers where siblings exist. Retrofitting this later is a rewrite.
- Persist the `model` on each message. A conversation that spans a model switch must
  show which turn came from where.
- `status` is a discriminated union, not booleans. `isLoading && !isError && hasText`
  is how impossible states get rendered.
- Keep IDs stable from the moment the user hits send (generate client-side), so the
  optimistic user bubble and the persisted row are the same node.

---

## 3. Streaming is the core interaction, not an animation

Streaming exists to make latency legible and to let the user bail early. Design it as
a state machine and render every state explicitly.

```
idle → submitted → (waiting first token) → streaming → complete
                              ↓                 ↓
                           failed            stopped
```

**Requirements, in priority order:**

1. **A stop control, always, from the moment of submit.** Not after the first token.
   The button in the composer swaps send → stop; it does not appear elsewhere. Stopping
   keeps the partial text and marks it `stopped` — never discard what was generated.
2. **Fill the pre-first-token gap with meaning.** A bare spinner is the weakest option.
   If the backend emits stages, show them ("Searching the web", "Reading 3 files"). If
   not, a shimmer placeholder in the assistant bubble beats a centered spinner.
3. **No layout thrash.** Reserve the bubble's horizontal space before text arrives.
   Never animate height per token. Avoid re-highlighting an entire code block on each
   chunk.
4. **Throttle renders, not the stream.** Buffer incoming tokens and flush on
   `requestAnimationFrame` (or every ~30–50ms). A token-per-setState chat UI will pin a
   CPU core and stutter — very visible in Electron where the renderer also owns the
   window chrome.
5. **Make capability changes visible.** If the model searched the web this turn but not
   last turn, say so in the turn. Silent capability drift is the fastest way to lose trust.

```ts
// Renderer: coalesce chunks, flush once per frame.
let buffer = '';
let scheduled = false;

function onChunk(delta: string) {
  buffer += delta;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const text = buffer;
    buffer = '';
    appendToActiveMessage(text);   // single state update per frame
  });
}
```

---

## 4. Rendering generated markdown

An assistant response spends most of its life as an **invalid** markdown document:
an open code fence, a table with only a header row, a half-written `**bold`, a link
missing its closing paren. Standard renderers flicker between raw syntax and formatted
output as those close.

- Use a **streaming-aware renderer** that heals incomplete syntax (Streamdown / Markstream
  are purpose-built for this), or implement the same idea: before parsing, close unterminated
  emphasis, inline code, links, and fences in a copy of the buffer.
- **Parse into blocks and memoize per block.** Re-parsing a 4,000-word answer on every
  chunk is the single biggest perf sink in chat UIs. Only the last block is live.
- **Sanitize.** Model output is untrusted input. Strip raw HTML by default; allow-list if
  you must. Restrict link and image protocols to `https:` and `mailto:` — block
  `javascript:`, `file:`, and in Electron especially any scheme that can reach local resources.
- **Code blocks** get: language label, copy button, horizontal scroll (never wrap code),
  and optionally save-to-file. Highlight with Shiki/Prism *after* the fence closes; render
  plain monospace while it is still open.
- **Tables** need horizontal scroll containers, not squeezed columns.
- **Links open externally.** In Electron, intercept and hand to `shell.openExternal` —
  never let a model-generated link navigate the renderer window away from your app.

### Progressive disclosure of machine detail
Reasoning traces, tool calls, and raw payloads are *secondary*. Default them collapsed
to a one-line summary ("Searched the web · 4 results", "Ran `read_file` · ok"), expandable
in place. The prose answer is the primary reading surface; anything that competes with it
for attention should be collapsed, dimmed, or moved to the inspector.

### Citations
When the answer draws on retrieved sources, attach inline numbered markers and a
compact source list under the message. Users cannot verify what they cannot locate.

---

## 5. Scroll behavior (gets more bug reports than anything else)

- **Stick to bottom only while already at bottom.** Track "is the user within ~80px of
  the bottom." If yes, follow the stream. If no, stop following and show a
  "Jump to latest ↓" pill.
- Never force-scroll on every chunk regardless of position. A user scrolled up to read is
  reading; yanking them down loses the app's trust in one gesture.
- Use `overflow-anchor: none` on the list and do the anchoring yourself — browser scroll
  anchoring fights streaming growth.
- **Virtualize long transcripts** (thousands of turns), but only the *completed* messages;
  keep the streaming one mounted. Variable-height virtualization plus streaming is
  genuinely hard — do not reach for it before you have a measured problem.
- On conversation switch, restore the previous scroll position; do not always jump to bottom.

---

## 6. The composer

- **Auto-resizing textarea**, min ~1 line, max ~40% of window height, then internal scroll.
- `Enter` sends, `Shift+Enter` newlines — and make this configurable, because a large
  minority wants the inverse. Persist the choice.
- Do **not** hard-disable input during streaming. Let the user type the next message while
  the current one streams; queue or warn on send. Disabling the field is the lazy fix and
  it feels like a freeze.
- Attachments: drop zone over the whole window, paste-to-attach images, per-file chips with
  size and a remove affordance. Show the rejection reason inline when a file is too big or
  unsupported — never a silent drop.
- Keep the token/context indicator here if you have one, but only surface it when it
  matters (approaching the limit), not as permanent decoration.
- Preserve drafts per conversation across app restarts. Desktop users close the window mid-thought.

---

## 7. Electron specifics (TypeScript)

### Process split
Put **all model access in the main process**, never the renderer.

```
Renderer (React/TS)  ──preload contextBridge──▶  Main (Node)  ──▶  Provider API / local model
   UI + transcript state             typed, data-only IPC          keys, retries, persistence
```

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Non-negotiable:
  your renderer displays untrusted generated content.
- The preload exposes a **narrow, data-only surface**. Electron IPC uses structured clone —
  you cannot send an `AbortSignal`, a `File`, an SDK client, or a callback across it.
  Define a small protocol of plain objects instead.
- Never run long CPU work in main; it blocks the window and the app looks hung. Use a
  utility process for local inference, embeddings, or indexing.

### Streaming across IPC

Two workable patterns:

- **Event channel:** `ipcRenderer.on('chat:delta', …)` with a `requestId` on every event.
  Simple, fine for one window.
- **MessagePort per request:** renderer creates a `MessageChannel`, sends `port2` to main
  with the request, receives deltas on `port1`. Cleaner teardown, no channel-name
  bookkeeping, no cross-talk between windows. Prefer this.

```ts
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';

export interface ChatBridge {
  send(req: ChatRequest, onEvent: (e: ChatEvent) => void): () => void; // returns cancel
}

contextBridge.exposeInMainWorld('chat', {
  send(req, onEvent) {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (ev) => onEvent(ev.data as ChatEvent);
    port1.start();
    ipcRenderer.postMessage('chat:stream', req, [port2]);
    return () => { port1.postMessage({ type: 'cancel' }); port1.close(); };
  },
} satisfies ChatBridge);
```

Define the event union once in a `shared/` module imported by both sides, so main and
renderer cannot drift:

```ts
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; callId: string; name: string; phase: 'start' | 'end'; payload?: unknown }
  | { type: 'done'; finishReason: string; usage?: Usage }
  | { type: 'error'; message: string; retryable: boolean };
```

In main, validate and bound the incoming payload (message count, total chars) before it
reaches the provider, and check the sending `WebContents` — treat renderer input as untrusted.

### Secrets
API keys live in the main process, encrypted with `safeStorage` (OS keychain), read from
disk at startup. Never in a `VITE_*`/`process.env` value bundled into the renderer, never
in a preload constant, never logged. Anything shipped in the renderer bundle is readable
by anyone who unzips the app.

### Cancellation
The stop button must abort the real request, not just stop painting. Map `requestId` →
`AbortController` in main; `cancel` over IPC aborts it. Also abort on window close and on
conversation switch, or you will leak streams and burn tokens invisibly.

### Persistence
Use SQLite (better-sqlite3 / libsql) in main, not `localStorage`. Write messages as they
complete, and checkpoint partial streams so a crash mid-answer does not lose the text.
Expose queries over IPC; the renderer should never touch the DB directly.

### Feeling native
- Respect the OS theme (`nativeTheme.shouldUseDarkColors`) and offer a manual override.
- Real menu bar with real accelerators: `Cmd/Ctrl+N` new chat, `Cmd/Ctrl+K` search,
  `Cmd/Ctrl+F` find in conversation, `Esc` to stop generation.
- Global keyboard focus rule: typing anywhere that is not an input focuses the composer.
- Window state (size, position, sidebar width, maximized) persists across launches.
- On macOS, `titleBarStyle: 'hiddenInset'` with a draggable header reads as a real app;
  remember `-webkit-app-region: no-drag` on every control inside the drag region.
- Offline is a first-class state for a desktop app — show it in the header and fail the
  send with a retry, not a stack trace.

---

## 8. Visual and typographic decisions

- **Asymmetric turns.** The convention that has won: user turns in a contained bubble or
  tinted block, assistant turns as full-width prose with no bubble. Assistant output is
  long-form and structured; bubbles fight headings, lists, tables, and code.
- **Body text 15–16px, line-height 1.6–1.7, measure 65–80 characters.** Chat is reading.
- **Vertical rhythm carries the structure.** Gap between turns must be clearly larger than
  gap between paragraphs inside a turn, or the transcript reads as one wall.
- **Two tones of text at most** in the primary column: content and metadata. Timestamps,
  model names, token counts are metadata — smaller, dimmed, and ideally revealed on hover.
- **Per-message actions on hover** (copy, regenerate, edit, branch, feedback), pinned to a
  consistent corner. Visible-always action rows triple the visual noise of a transcript.
- **Color means state, not decoration.** Reserve your accent for interactive affordances,
  a single warning hue for errors, and keep everything else neutral. A chat UI with five
  accent colors reads as a dashboard.
- Dark mode is table stakes for a developer-facing desktop app; design both, don't invert one.

---

## 9. Accessibility

- The message list is a `log` / `aria-live="polite"` region — but **do not announce every
  token.** Announce start ("Assistant is responding") and completion, and let the user
  navigate the finished text. Token-level live regions flood screen readers into uselessness.
- Everything reachable by keyboard: send, stop, each message's actions, sibling pagers,
  conversation list. Logical focus order; visible focus rings you did not delete.
- After send, focus returns to the composer. After stop, focus stays put.
- Meet WCAG AA contrast including dimmed metadata and code-block syntax colors.
- Respect `prefers-reduced-motion`: kill the typing caret animation and any bubble transitions.

---

## 10. Anti-patterns — check the build against this list

- Streaming with no stop control.
- Force-scrolling the view while the user is reading earlier messages.
- A floating composer that covers the last line of the response.
- Re-parsing and re-highlighting the whole response on every token.
- Raw flickering markdown while fences and emphasis are still open.
- Destroying the previous answer on regenerate, or the previous message on edit.
- Storing a message as a plain string, then bolting on tool calls later.
- API keys anywhere in the renderer bundle.
- Full-window-width text lines on a wide desktop display.
- Silent failure — an empty bubble, a spinner that never ends, an attachment that vanishes.
- Errors as raw JSON or stack traces. Say what failed, whether it is retryable, and offer
  the retry button.
- Fake progress — a stage label that claims work the backend is not doing.

---

## 11. Build order

Ship in this sequence; each step is usable on its own.

1. Typed message model with `parts`, `status`, `parentId`, persisted to SQLite in main.
2. Preload bridge + main-process streaming with a real abort path.
3. Message list + composer, plain text only, with stop and correct scroll behavior.
4. Streaming-safe markdown + code blocks with copy.
5. Per-message actions: copy, regenerate, edit-and-resend (as siblings), delete.
6. Conversation sidebar, search, rename, persisted drafts and scroll positions.
7. Tool-call and reasoning display, collapsed by default.
8. Attachments, citations, token/context indicator.
9. Native polish: menus, accelerators, window state, theme, offline state.

---

## 12. Self-check before calling a chat UI done

- Can the user stop generation within 100ms of deciding to, at any point?
- Scroll up mid-stream, read, and come back — is the position preserved and the pill shown?
- Does a 5,000-word response with ten code blocks stream at a steady frame rate?
- Kill the process mid-answer and relaunch — is the partial text still there?
- Unplug the network mid-stream — is the error legible and retryable?
- Edit a message three turns back — is the original branch still reachable?
- Grep the renderer bundle for the API key. Is it absent?
- Tab through an entire turn without a mouse. Does it work and stay visible?
