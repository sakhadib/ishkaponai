# ISHKAPON AI — Architecture Decisions

**Status:** All decisions below are **LOCKED**.
**Date locked:** 2026-09-26
**Scope:** Cross-platform Electron desktop AI agent with sandboxed shell execution.

Locked decisions are binding for implementation. Changing one requires an
**Amendment** entry at the bottom of this file (append-only, never rewrite
history) so the reasoning stays auditable.

---

## 0. Decision index

| # | Decision | Status |
|---|----------|--------|
| D1 | Product shape: local-first AI agent, user-supplied OpenRouter key | LOCKED |
| D2 | Module system: ESM main, CJS preload, renderer via Vite | LOCKED |
| D3 | Agent runtime host: dedicated `utilityProcess` | LOCKED |
| D4 | AI harness: Vercel AI SDK 7 + official OpenRouter provider | LOCKED |
| D5 | Model catalog: fetched from OpenRouter, filtered, cached | LOCKED |
| D6 | Secret storage: `safeStorage` async API, main process only | LOCKED |
| D7 | Settings + conversation persistence: JSON/NDJSON, no native modules | LOCKED |
| D8 | Theming: light only, via CSS custom properties | SUPERSEDED by D28 |
| D9 | Model context: layered, user-editable, inspectable | LOCKED |
| D10 | Shell tool: per-OS shell selection + OS detection | LOCKED |
| D11 | Command safety: policy engine + approval, enforced outside the LLM | LOCKED |
| D12 | Autonomy levels: `ask` / `safe-auto` / `auto` | LOCKED |
| D13 | OS-level confinement: optional, per-OS, honestly scoped | LOCKED |
| D14 | Process hygiene: env scrub, cwd jail, timeouts, output caps | LOCKED |
| D15 | Streaming & cancellation over IPC | LOCKED |
| D16 | Renderer state: own store, AI SDK UI message shape | LOCKED |
| D10 | ~~Shell tool + OS detection~~ | **VOID** (D26) |
| D11 | ~~Command safety policy~~ | **VOID** (D26) |
| D12 | ~~Autonomy levels~~ | **VOID** (D26) |
| D13 | ~~OS-level confinement~~ | **MOOT** (D26) |
| D14 | Process hygiene | **REVISED** — narrowed to the `python` tool |
| D15 | Streaming and cancellation | LOCKED |
| D16 | Renderer state | SUPERSEDED by D25 |
| D17 | Threat model: prompt injection is the primary adversary | LOCKED |
| D18 | Supporting stack (locked versions) | LOCKED |
| D19 | ~~Two execution substrates~~ | **SUPERSEDED** (D26) — one substrate |
| D20 | ~~`python` exempt from approval~~ | **SUPERSEDED** (D26) — approval is gone entirely |
| D21 | Bengali numerals normalised to ASCII in math spans | LOCKED |
| D22 | Context auto-compaction with structured running summary | LOCKED |
| D23 | English UI chrome; bilingual model answers | LOCKED |
| D24 | No separate answer-verification pass | LOCKED |
| D25 | Zustand + IPC reducer, not `useChat` | LOCKED |
| D26 | **General shell execution removed; `python` is the only tool** | LOCKED |
| D27 | **Answer is a human worked example; agent steps behind a Thought toggle** | LOCKED |
| D28 | **Light-only. No theme setting, no dark palette** | LOCKED |
| D29 | **Math renderer: MathJax to inline SVG, replacing KaTeX** | LOCKED |

> **D7 is superseded** by the SQLite decision (see amendment table).
> **D10–D14 are void or moot** as of D26. Their reasoning is retained above, so
> that reintroducing a shell later starts from a recorded position rather than
> from scratch.
> **Normative spec:** `specifications.md` v2.0. This file records rationale and
> rejected alternatives; where the two disagreed, `specifications.md` won and an
> amendment was recorded below.

---

## D1 — Product shape

**Decision.** ISHKAPON AI is a **local-first desktop AI agent**. There is no
ISHKAPON backend. All model traffic goes from the user's machine directly to
OpenRouter using an API key the user supplies. Nothing is proxied, logged, or
telemetry'd by us.

**Consequences.**
- We never hold user keys → we have no key-handling liability.
- Offline behaviour is limited to UI/settings; chat requires network.
- We must be careful with wording: the app is *not* fully offline, and we must
  never imply it is.
- OpenRouter's optional attribution headers (`X-Title`, `HTTP-Referer`) are sent
  with `X-Title: ISHKAPON AI`. `HTTP-Referer` is omitted until a public site
  exists — it must not be faked.

---

## D2 — Module system and process architecture

**Decision.** Mixed module system, forced by a hard platform constraint:

| Process | Module system | Reason |
|---|---|---|
| Main | **ESM** | Must import AI SDK 7, which is ESM-only |
| Preload | **CJS (bundled)** | Sandboxed preloads *cannot* use ESM imports |
| Renderer | ESM via Vite | Normal web target |

**Context.** AI SDK 7 is ESM-only and requires Node ≥ 22. Electron's
**sandboxed preload scripts run as plain JavaScript with no ESM context**, and
preload scripts ignore `"type": "module"` (ESM preloads would need `.mjs` *and*
`sandbox: false`). We are keeping `sandbox: true`, so the preload must stay CJS.

**Verified.** Electron 44.4.5 bundles **Node 24.21.0** — clears the Node ≥ 22
floor. `@openrouter/ai-sdk-provider@3.1.0` declares `engines.node >= 22` and
`type: module`.

**Consequences.**
- Main becomes ESM: `out/main/index.js` with `"type": "module"` in the emitted
  package context.
- **The CJS/ESM boundary must be explicit.** Because ESM is async, Electron
  main-process module side effects do not all run before `ready`. Any API that
  must run pre-`ready` (`app.setPath`, `app.requestSingleInstanceLock`,
  `--password-store` flag handling) must sit in a **tiny synchronous CJS
  bootstrap**, which then `await import()`s the ESM app. This is the standard
  workaround and is non-negotiable.
- `externalizeDepsPlugin` must keep ESM-only deps external; they cannot be
  inlined into a CJS chunk.
- `engines.node` in `package.json` moves to `>=22` to match the SDK floor.

**Rejected.** Staying on CJS and pinning AI SDK 6 (CJS-compatible) — buys
nothing but defers a migration to a breaking major. Staying on CJS forever
means owning the tool loop, retries, SSE parsing, and token accounting
ourselves.

---

## D3 — Agent runtime host

**Decision.** The agent loop (model calls, tool dispatch, state) runs in a
**dedicated Electron `utilityProcess`**, not in the main process.

**Rationale.** Electron's process-model guidance explicitly nominates
`utilityProcess` for "untrusted services, CPU intensive tasks or crash prone
components", and recommends preferring it over `child_process.fork` for forking
from main. An LLM agent loop qualifies on all three counts: it is driven by
external content, it is long-running and stream-heavy, and a thrown error in a
tool should not be able to destabilise window creation or IPC.

**Bonus.** `utilityProcess.fork` accepts `disclaim: true` on macOS, which makes
the OS treat the child as a separate entity for TCC purposes — exactly the
right posture for a process that will run third-party, LLM-directed commands.

**Consequences.**
- Main ↔ agent transport is `MessagePortMain`, not renderer IPC. The renderer
  never talks to the agent host directly.
- Third-party AI deps are bundled into the agent bundle only, keeping the main
  process lean.
- The agent host is disposable: if it dies, main respawns it and restores
  conversation state from disk.

**Rejected.** Running the agent in the main process (simpler, but couples agent
crashes to app stability). A separate sidecar binary (true isolation, but
doubles the build/packaging matrix and complicates auto-update).

---

## D4 — AI harness

**Decision.** **Vercel AI SDK 7** (`ai`) with the **official OpenRouter
provider** (`@openrouter/ai-sdk-provider`). OpenRouter is a *provider*, not the
harness.

**Rationale.**
- First-party OpenRouter provider maintained by `OpenRouterTeam` (682★, 170
  forks, Apache-2.0) — not a community fork.
- Handles the parts we would otherwise hand-roll: multi-step tool loops
  (`stopWhen`), typed tool schemas, streaming part types, structured output,
  abort/cancellation, retry.
- TS-native, 12M+ weekly downloads, and `@ai-sdk/otel` gives us a tracing hook
  if we ever want local observability.
- v7 has first-class approval-policy concepts, which map onto D11/D12.

**Rejected.**
- *LangChain.js / LangGraph* — mature, but a large abstraction whose graph
  checkpointing model does not match a desktop app's persistence needs. Keep as
  an upgrade path if we ever need graph-shaped, resumable workflows.
- *OpenAI Agents SDK* — designed around OpenAI's Responses API; OpenRouter
  support is a compatibility shim rather than a target.
- *Mastra* — capable and AI SDK 7 compatible, but adds a second abstraction
  layer we do not need yet. Documented upgrade path.
- *Hand-rolled `fetch` loop* — the escape hatch if the ESM/Node-22 floor ever
  becomes a blocker. Costs us the tool loop, retries, and SSE parsing.
- *`@openrouter/sdk`* (Speakeasy client + OpenRouter "Agent SDK") — viable
  alternative that avoids the AI SDK entirely; noted, not chosen.

**Note.** The provider's README is the source of truth for the compatible
version line: install the release whose README says *"Setup for AI SDK v7"*
(currently `@openrouter/ai-sdk-provider@3.1.0`, peers `ai@^7.0.0`,
`zod@^3.25.76 || ^4.1.8`). Do not install a v5/v6 line.

---

## D5 — Model catalog and selection

**Decision.** The model list is fetched at runtime from
`GET https://openrouter.ai/api/v1/models`, filtered to models that support tool
calling, cached with a TTL, and offered to the user in Settings. The chosen
model ID is persisted and sent as the OpenRouter `model` slug.

**Rationale.** OpenRouter carries 500+ models with rapidly changing slugs.
Hardcoding a list would rot immediately; the catalog endpoint is authoritative.

**Consequences.**
- Catalog fetch is best-effort: on failure the app falls back to a bundled
  minimal list plus a free-text model-ID field, so a network blip never bricks
  the app.
- Only tool-capable models are listed — a non-tool model cannot be an agent.
  If the user types a custom ID that lacks tool support, the app warns.
- Model list entries show context window and pricing, since the user pays
  per-token. Per-turn `usage` (including OpenRouter's `usage.cost`) is surfaced
  in the UI.
- Provider routing/fallback (`models: [...]` array) is **out of scope for v1**.

---

## D6 — Secret storage

**Decision.** The OpenRouter API key is held **only in the main process**,
encrypted at rest with Electron's `safeStorage` **async** API
(`encryptStringAsync` / `decryptStringAsync`), and written to a file in
`app.getPath('userData')`.

**Rationale.** `safeStorage` delegates to macOS Keychain, Windows DPAPI, and on
Linux to kwallet / gnome-libsecret / the freedesktop Secret Service portal. The
async API is the documented recommendation: it is non-blocking, supports key
rotation via `shouldReEncrypt`, and handles temporary unavailability via
`isTemporarilyUnavailable`. The sync API may be deprecated.

**Hard rules.**
- The key **transits the renderer exactly once** (the user types it into a
  Settings field) and is then sent to main over IPC. It is never persisted,
  logged, or re-read by the renderer.
- The renderer only ever receives `{ configured: boolean, hint: '…abcd' }`.
  Main performs key validation itself and returns a status object, never the key.
- On **Linux**, check `safeStorage.getSelectedStorageBackend()`. A `basic_text`
  backend means the OS has no secret store and the value is effectively
  plaintext-encrypted. The app must **warn the user in Settings** rather than
  silently pretend it is secure.
- The key is **never placed in a child-process environment** (see D14). An
  untrusted command running `env` must not be able to read it.

---

## D7 — Settings and conversation persistence

**Decision.** SQLite for persistence. The driver is the **built-in
`node:sqlite` module** — verified working in Electron 44.4.5's bundled Node
24.21.0, including the `json1` extension.

**Superseded rationale.** This decision previously rejected SQLite to avoid
`better-sqlite3`'s native rebuild against each Electron version. `node:sqlite`
removes that objection entirely: real SQLite, zero native modules, no
`electron-rebuild` step, no per-platform build matrix. See `specifications.md` §6
for the schema.

**Consequences.**
- Secrets live in a **separate table** from ordinary settings, so non-secret
  settings can be exported or backed up without the credential.
- Tool calls are persisted, not pruned, so the student's work stays auditable.
- WAL mode and `foreign_keys = ON`.
- The escalation trigger is gone; this is now the storage layer.

---

## D8 — Theming

> **Superseded by D28.** Kept verbatim for the record. What survives is the token
> discipline and the "verify contrast, do not eyeball it" rule; the three modes,
> the `data-theme` attribute and the preload bootstrapping are all gone.

**Decision.** Three modes — **light**, **dark**, **system** — driven entirely by
CSS custom properties, selected by a `data-theme` attribute on `<html>`, and
persisted in settings.

**Rationale.** One token set, three themes, no runtime CSS-in-JS cost, and
per-OS fidelity. `system` tracks the OS and updates live.

**Flash-free bootstrapping.** The resolved theme is applied by the **preload
script at preload time** (it runs before page scripts) using the value passed
via `webPreferences.additionalArguments`, plus `nativeTheme.themeSource` in main
so the **native window chrome / title bar matches**. This avoids an inline
`<script>` in `index.html`, which our strict CSP (`script-src 'self'`) would
block. A CSS `@media (prefers-color-scheme)` baseline covers first paint before
preload completes.

**Consequences.**
- All colour values in the existing `styles.css` must be re-expressed as tokens
  under `[data-theme='light']` / `[data-theme='dark']`. The current hard-coded
  dark palette is a starting point, not the final structure.
- Contrast must be verified in **both** themes, not just dark.
- Charts, diffs, and syntax highlighting must all be token-driven.

---

## D9 — Model context composition

**Decision.** The system prompt is **composed in four ordered layers**, not a
single string:

1. **Base agent prompt** — product rules and tool-use policy. Shipped, versioned.
2. **User instructions** — free-text, edited in Settings, with live preview.
3. **Workspace `AGENTS.md`** — optional per-workspace file the user can edit
   alongside their project.
4. **Runtime environment block** — auto-generated: detected OS, resolved shell,
   working directory, platform/arch, current date, and the list of tools
   actually available with their schemas.

**Consequences.**
- Layers 1 and 4 are machine-owned and must not be user-editable; layers 2 and 3
  are user text and are treated as **untrusted input** (see D17).
- Settings offers a **"view exact payload"** inspector so the user can always
  see precisely what is sent on each turn. Transparency is a feature, not a
  debug affordance.
- Tool schemas are advertised to the model from the same registry the policy
  engine enforces, so the model can never be told about a tool that is not
  actually gated.

---

## D10 — Shell tool: OS detection and shell selection

**Decision.** ~~Use a shell tool.~~ **VOID IN v1 (2026-09-26, amendment D26).**
The `python` sandbox (§7 of `specifications.md`) is the only execution substrate.
OS detection is no longer needed for shell selection; minimal platform/locale
information is still reported to the model for formatting.

**Retained reasoning, for the record.** Windows has no dependency-free way to
confine a shell to a filesystem jail, which is why this became the single
largest risk in the design. Removing the shell removed the problem rather than
mitigating it.

---

## D11 — Command safety policy

**Decision.** ~~A policy engine gates every command.~~ **VOID IN v1 (amendment
D26).** There are no commands. Execution safety is now a *property of the
substrate* rather than a filtering layer: the `python` tool has no filesystem,
no network, and no child processes, so there is nothing to gate.

**Retained for the record — the required shape if a shell is ever
reintroduced.** A policy engine would be non-negotiable, would live in the agent
host, and would be unreachable and non-overridable by the model. No prompt is a
security boundary. All stages must pass:

1. **Tokenise** with a real shell-quote parser. Policy input is argv, never a
   string.
2. **Deny rules** — destructive binaries and shapes refused outright.
3. **Destructive-flag detection** — the same binary is safe or not depending on
   flags (`rm` vs `rm -rf`, `find` vs `find -delete`, `git status` vs
   `git clean -fdx`).
4. **Path jail** — reject arguments resolving outside the workspace root via
   absolute paths, `..`, or symlink escape.
5. **Egress rules** — network-fetching commands are treated as state-changing.
6. **Approval** — anything not auto-allowed stops and asks the user (D12).

**Retained hard rules.**
- The policy engine is **not reachable or overridable by the model**. The
  system prompt *tells* the model it must route through the tool; that is
  advisory. Enforcement is code.
- The approval dialog shows the **exact argv**, the resolved cwd, and the
  resolved absolute paths of any file arguments. No re-rendering, no
  truncation, no elision.
- Classification is **asymmetric**: misclassifying a write as read-only is a
  security bug; misclassifying a read as a write costs one click. The
  classifier must err toward "state-changing".
- Rules live in a data file with unit tests; this is security-critical code and
  gets test coverage proportional to its importance.

---

## D12 — Autonomy levels

**Decision.** ~~Three user-selectable autonomy levels.~~ **VOID IN v1
(amendment D26).** Nothing requires approval, because nothing can harm the
machine. There is no autonomy setting.

**Retained for the record.** If a shell is ever reintroduced, these levels return
with `safe-auto` as the default, because prompting for every read trains users to
approve without reading — which destroys the value of the prompt on the commands
that actually matter. Classification stays asymmetric, erring toward
"state-changing". The active level must be visible while a turn runs, and
auto-approved actions must still appear in the transcript: auto means no dialog,
not invisible.

---

## D13 — OS-level confinement (honest scope)

**Decision.** ~~Layered, per-OS, honestly labelled.~~ **MOOT IN v1 (amendment
D26).** The unresolved Windows confinement gap existed only because a shell
needed confining. With no filesystem access there is nothing to confine, so
there is no confinement claim to make on any platform — and no awkward
disclosure to carry.

**Revives in full if a shell is ever reintroduced.** The position recorded below
was: no native helper, no confinement claim on Windows, and a per-OS label
rendered in the UI and repeated in the README.
**no confinement claim on Windows** and say so plainly in the product.

**Layer 1 — always on, all platforms:** D11 policy + D12 approval + D14
hygiene + workspace jail.

**Layer 2 — optional, only where a no-native-code primitive exists:**

| Platform | Mechanism | Status |
|---|---|---|
| Linux | **`bubblewrap` (`bwrap`)** — `--unshare-all --die-with-parent`, read-only root bind, writable bind limited to the workspace | Preferred; used when `bwrap` is on PATH |
| Linux (packaging) | Ship as **Flatpak** — the entire app inherits the sandbox | Deferred, strong option |
| macOS | **`sandbox-exec`** with a generated profile | Optional; undocumented/deprecated, availability not guaranteed |
| Windows | **None.** | **No confinement. We do not claim any.** |

**The Windows position, stated plainly.** Windows offers no dependency-free way
to confine a shell to a filesystem jail. Job Objects constrain CPU, memory, and
process count — they do **not** restrict filesystem writes. Real confinement
would require a native helper (restricted tokens / AppContainer), which means
per-arch native builds, code signing, and ongoing maintenance across Electron
and Windows releases.

**We are not building that.** The decision is to make **no confinement claim on
Windows** rather than to ship a weak approximation and label it "sandboxed":

- No native helper is planned, for v1 or beyond, unless this decision is
  explicitly amended.
- The Windows experience is **policy-gated with user approval** (D11 + D12 +
  D14) and nothing more. That is what it is.
- **The UI must state this**, not imply otherwise. The agent's tool surface
  shows the active confinement layer: on Linux with `bwrap` present, "confined";
  on macOS with `sandbox-exec`, "confined (best effort)"; on Windows,
  **"not sandboxed — policy and approval only"**.
- README, release notes, and any store listing use the same wording. No
  "sandboxed execution" in marketing copy without a per-OS qualifier.

**Consequences.**
- Security expectations must differ per OS, and the app states which regime it
  is in rather than implying one global guarantee.
- Linux is the platform where this app is meaningfully safer. If cross-platform
  parity of safety matters more than shipping on Windows, the alternative is to
  drop Windows support — that is a product decision, not an engineering one.
- If `bwrap` is absent on Linux, the app still works at Layer 1 and says so.
- Confined execution can break legitimate workflows (package managers, `ssh`,
  `docker`); failures must surface as readable errors, not silent no-ops.

---

## D14 — Process hygiene

**Decision.** ~~Every spawned command runs under all of the following.~~ **VOID
IN v1 (amendment D26).** No command is spawned and no child process is created
on behalf of model output, so environment allowlisting, path jails, process-tree
kills, and TTY suppression are all unnecessary.

**Retained for the record, and now a stronger property.** The motivating
concern was that an untrusted command reading the parent environment could
exfiltrate the OpenRouter key, which is the student's money. With no child
process, that is no longer a control to configure — the key is **unreachable by
construction** rather than protected by filtering. That is a strictly better
posture than an allowlist, and it is the single strongest argument for removing
the shell.

**Still required for the `python` tool** (see `specifications.md` §7.2, §8):

| Control | Value |
|---|---|
| Timeout | 60 s, user-adjustable, interruptible via `checkInterrupt` |
| Output cap | 64 KB, then truncated with a visible marker |
| Isolation | In-memory VFS only; no real filesystem, no network, `micropip` disabled |
| Lifetime | One interpreter per session, **reset between sessions** |

---

## D15 — Streaming and cancellation

**Decision.**

- The agent host consumes AI SDK `fullStream` and emits typed events
  (text delta, reasoning delta, tool call, tool result, error, done).
- Transport is `MessagePortMain` from agent host to main; main fans out to the
  renderer.
- Renderer delivery starts as `webContents.send` with **coalescing (~30 ms)**
  to avoid flooding IPC on fast streams. `MessagePortMain` transferred directly
  to the renderer is the scale-up if profiling justifies it.
- One `AbortController` per turn. The **stop button** aborts the model stream
  **and** kills any running process tree.
- Partial assistant output is persisted as it streams, so a crash mid-answer
  does not lose the turn.

**Consequences.**
- Token-level deltas are the common case; React re-render cost is controlled by
  coalescing rather than by diffing every character.
- Abort must be idempotent and must still persist the partial turn.

---

## D16 — Renderer state

**Decision.** The renderer owns a **small custom store (Zustand)** fed by an
IPC event reducer. We do **not** use `@ai-sdk/react`'s `useChat`.

**Rationale.** `useChat` is built around HTTP request/response semantics
(`DefaultChatTransport` posts to a route). We are bridging over IPC with a
long-lived stream and tool-approval round-trips, which is a materially different
transport. Forcing our shape into `useChat` would mean fighting the abstraction.

**Consequences.**
- The renderer still adopts AI SDK's **`UIMessage` part shape**, so we stay
  compatible with AI SDK tooling and can migrate to `useChat` later if a
  non-HTTP transport lands.
- Approval requests are modelled as first-class state, not as chat messages.
- Markdown rendering uses `react-markdown` + `remark-gfm`. **Syntax
  highlighting is deferred** to a follow-up decision rather than committing to
  a heavy highlighter (Shiki) now.
- Routing: `react-router` in declarative mode, in-memory. Custom-protocol deep
  links are out of scope for v1.

---

## D17 — Threat model

**Decision.** The primary adversary is **prompt injection**, not a human
attacker. Design accordingly.

**Reasoning.** The model reads attacker-influenceable text — file contents,
command output, web pages — and that text can attempt to instruct the model to
run something dangerous. The model is therefore an **untrusted component that
happens to be well-informed**, and no prompt can be trusted to hold a security
boundary.

**Hard rules.**
- D11 enforcement lives outside the model, in code the model cannot reach.
- Tool **results** are labelled as untrusted data when returned to the model,
  and system-prompt layer 1 forbids treating file or command output as
  instructions.
- User instructions (D9 layers 2–3) are user text, not a security boundary.
- No tool can exfiltrate the API key (D14 env allowlist).
- Rendering model output must not execute anything: no `dangerouslySetInnerHTML`
  with unsanitised HTML, no `javascript:` URLs, no remote script loading.
- `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, strict CSP and
  navigation blocking **stay in force**. They are not relaxed for convenience.
- OpenRouter's server-side guardrails (which can return HTTP 400 with a
  `guardrail_id`) are treated as defence in depth, not as our control.

**Consequences.**
- The app is expected to occasionally refuse or ask. That is correct behaviour,
  not a bug to be smoothed away.
- Any feature that widens what the model can reach is a security change and
  needs review against this section.

---

## D18 — Supporting stack (locked)

| Concern | Choice | Notes |
|---|---|---|
| AI SDK | `ai@^7` | ESM-only, Node ≥ 22 |
| OpenRouter provider | `@openrouter/ai-sdk-provider@^3` | Line whose README states "Setup for AI SDK v7" |
| Tool schemas | `zod` | `^3.25.76 \|\| ^4.1.8` per provider peer range |
| Command tokenising | ~~`shell-quote`~~ **removed** | No command is ever parsed |
| Calculation sandbox | `pyodide@^0.29` | Bundled locally with `sympy`, `numpy`, `mpmath` wheels |
| Database | `node:sqlite` | Built into Node 24. No native module |
| Renderer store | `zustand` | |
| Routing | `react-router` | Declarative, in-memory |
| Markdown | `react-markdown` + `remark-gfm` | |
| Mathematics | ~~`remark-math` + `rehype-katex`~~ | **SUPERSEDED** (D29) — MathJax |
| Diagrams | `mermaid` | Lazy-loaded |
| Theming | CSS custom properties | No runtime theming library |

**Dependency placement rule (carried over from the existing scaffold).** Anything
bundled by Vite belongs in `devDependencies`, so it is not shipped twice inside
`app.asar`. Only what the main or agent process genuinely requires at runtime
belongs in `dependencies`. This is why React is a devDependency today.

---

## Verification gates before implementation is called done

- [ ] `npm run typecheck` passes for main, preload, and renderer
- [ ] `npm run build` produces ESM main, CJS preload, ESM renderer
- [ ] Packaged app boots; preload still sandboxed (no ESM in preload)
- [ ] Theme applies before first paint in all three modes, both OS light/dark — **VOID** (D28); replaced by: the app renders light regardless of OS theme, and the native title bar matches
- [ ] API key round-trips: entered in renderer → stored encrypted in main →
      used by agent host → **never** returned to renderer
- [ ] `env` run as an agent command does **not** reveal the API key
- [ ] Denylist cases blocked on all three shells (bash, PowerShell, and a
      Windows-specific case)
- [ ] `ask` mode blocks every tool call; default `safe-auto` allows **only** the
      read-only allowlist and asks for everything else
- [ ] Read-only classifier is asymmetric: writes are never auto-approved
- [ ] Confinement label shown in the UI is correct per-OS, and says
      "not sandboxed" on Windows
- [ ] Timeout kills the process tree, not just the direct child
- [ ] Output cap truncates and marks truncation visibly
- [ ] Stop button aborts both the stream and the running command
- [ ] Conversation survives an app restart

---

## Explicitly out of scope for v1

Recorded here so their absence is a decision, not an oversight.

- Images / vision input, audio, embeddings
- MCP client/server integration (OpenRouter does host an MCP endpoint; revisit
  when there is a concrete tool to add)
- Auto-update (`electron-updater`), code signing, notarisation
- Multi-user / cloud sync, accounts, telemetry
- Windows Job Objects / AppContainer native helper — **declined, not deferred**
  (D13); no confinement claim on Windows
- Flatpak packaging
- Syntax highlighting in rendered output
- Model provider routing/fallback arrays
- OS-level filesystem confinement on Windows

---

## Amendments

Append new entries below. Do not edit existing decisions in place.

| Date | Decision | Change | Reason |
|------|----------|--------|--------|
| 2026-09-26 | — | Initial lock of D1–D18 | First decisions pass |
| 2026-09-26 | D13 | Windows: **declined** a native confinement helper entirely. No confinement claim on Windows; UI/docs must say "not sandboxed — policy and approval only" | Chosen over deferring to v2. A weak approximation labelled "sandboxed" is worse than an honest gap. Parity of safety would mean dropping Windows, which is a product call. |
| 2026-09-26 | D12 | Default autonomy changed `ask` → `safe-auto` | Most legitimate agent work is inspection. Prompting for every read trains users to approve without reading, which defeats the prompt on the commands that matter. `ask` stays one click away. |
| 2026-09-26 | D7 | **Superseded.** SQLite adopted via built-in `node:sqlite` | `spec.md` mandates SQLite. The original objection was `better-sqlite3` native rebuilds; `node:sqlite` gives real SQLite with zero native modules, so the objection no longer holds. Schema in `specifications.md` §6. |
| 2026-09-26 | **D19** | **New.** Two execution substrates: `python` (Pyodide/WASM, in-memory, no FS, no network) and `shell` (full bash/PowerShell) | `spec.md` called for both a code interpreter and shell. They have very different security properties, so they are specified as separate tools rather than one mechanism. The `python` substrate guarantees calculations work on any machine regardless of what is installed. |
| 2026-09-26 | **D20** | **New.** `python` is exempt from approval at every autonomy level | It has no filesystem and no network, so a hijacked calculation can at worst produce a wrong answer. Approving arithmetic would be friction with no security benefit — and it is the path every legitimate answer takes. |
| 2026-09-26 | **D21** | **New.** Bengali numerals normalised to ASCII inside math and code spans | KaTeX cannot parse `০–৯`. Without normalisation a student writing `২+৩` gets a raw render error instead of an answer. Prose is left untouched. |
| 2026-09-26 | **D22** | **New.** Context auto-compaction with a structured running summary, budget derived from the selected model's context length | `spec.md` requires small-context models to work while retaining enough context, and that chat progression must be preserved. Structured summary (Problem / Givens / Established results / Conventions / Remaining) rather than free prose. SQLite keeps the unabridged transcript; only the sent context is compacted. |
| 2026-09-26 | **D23** | **New.** English-only UI chrome; model answers bilingual | Chosen over a full i18n layer. The draft required only that the *AI response* be Bangla or English. Roboto + Kalpurush still needed for rendering answers. |
| 2026-09-26 | **D24** | **New.** No separate answer-verification pass | Correctness rests on code-derived numbers plus visible working. A verification call would roughly double cost and latency for the target user, and errors are already visible in the shown steps. |
| 2026-09-26 | **D25** | **New.** Renderer uses Zustand + an IPC reducer, not `@ai-sdk/react`'s `useChat` | `useChat` is HTTP-shaped. This app bridges a long-lived stream with approval round-trips over IPC. The AI SDK `UIMessage` part shape is still adopted for forward compatibility. |
| 2026-09-26 | **D26** | **General shell execution removed from the product.** `python` (Pyodide/WASM) is the only tool. **Voids D10, D11, D12, D14; makes D13 moot; supersedes D19.** `shell-quote` dropped from the stack | Confirmed with the author: the problem always arrives in the prompt, so file and OS access are not required. Pyodide already provides exact arithmetic, symbolic algebra, calculus, units, matrices, and plotting — none of which a system shell supplies reliably on an arbitrary student machine. Sequential Python statements also map better onto the "no jumps" requirement than a shell pipeline. Removing the shell collapses the prompt-injection blast radius to *a wrong answer* and eliminates the unresolved Windows confinement gap entirely, rather than mitigating it. |
| 2026-09-26 | **D27** | **New.** The student's answer is a human worked example; the agent's steps (reasoning, Python, raw output, failed attempts) live behind a collapsible "Thought" toggle above it, not inline in the transcript | The agent loop is identify → compute → see results → write answer, so the answer is written *after* the results exist and can be a clean derivation. Showing code inline made a solved problem look like a machine transcript, which is not what a student reads. Evidence is still one click away and still in SQLite, so auditability is unchanged |
| 2026-09-26 | D14 (revised) | Process hygiene narrowed to the `python` tool: 60 s interruptible timeout, 64 KB output cap, in-memory VFS, reset between sessions | The env-allowlist rationale is superseded by a stronger property: with no child process, the API key is unreachable **by construction** rather than protected by filtering |
| 2026-09-26 | **D28** | **Light only. Supersedes D8.** `ThemeMode` and `Settings.theme` removed from the contract, the dark palette deleted, the Appearance pane removed, and the `data-theme` mechanism retired | Author's decision. A student reads worked solutions here for minutes at a time, often in a bright classroom, and often prints or screenshots the result — a fixed light surface is the better reading experience and is unambiguous in a shared image. It also removes a whole class of work rather than adding one: no second palette to keep accessible, no first-paint flash to prevent, and no "which theme is this screenshot?" question. The token discipline and the measured-contrast rule from D8 survive; only the switching does not |
| 2026-09-26 | **D29** | **Math renderer changed from KaTeX to MathJax, rendering to inline SVG in the pipeline.** `rehype-katex` + `katex` removed; `rehype-mathjax` + `mathjax-full` added. Amends D18 | Author's decision, after seeing real answers. KaTeX's metrics read as cramped — symbols too close together to scan — and that is a deliberate difference between the two projects, not a bug that could be tuned away. MathJax is roomier, more forgiving of a malformed expression, and renders the full AMS environment set. The cost is accepted knowingly: a larger renderer bundle and slower typesetting. The author also asked for multi-line equations to be preferred, which the prompt now requires (§11.1.9) — that request is independent of the renderer and would have been worth doing under either one. A real KaTeX defect was found and fixed on the way out (below), and it accounted for the "fraction with no line" symptom; the cramped-spacing complaint is what remained after that, and it is the part that needed a different renderer |

### D28 — Light only

**Decision.** ISHKAPON has exactly one theme: light. There is no setting for
it, no `data-theme` attribute, and no dark palette in the codebase.

**Rationale.** The author's call, and it is the right one for this product. The
app is a reading surface first — a worked solution with every step shown — so
the palette is a legibility decision, not a preference. Three things follow that
are worth stating rather than assuming:

- **A light surface is the right reading surface here.** Long-form solutions
  with maths, tables and code, read for minutes, in a room that is often lit
  from behind the screen.
- **The cost was asymmetry.** A second palette is not a one-off: every future
  colour has to be re-checked against it, and the first person to add a token
  will forget. That is a permanent tax on a codebase that has one audience and
  one job.
- **"Respect the OS" is a desktop-app habit, not a requirement.** Copying it
  here would have bought a preference some students have and some do not, at
  the price of a permanent maintenance obligation.

**What is kept, and what goes.**

Kept: the token discipline (every colour in `styles.css` is a custom property;
no literal colours in component rules) and the measured-contrast rule — the
palette is verified by `tools/contrast.mjs`, not by eye. Both were the durable
part of D8.

Removed: the `ThemeMode` type, `Settings.theme`, the `[data-theme='dark']` token
block, the `data-theme` / `data-theme-source` attributes, the preload's
`installTheme()`, the `--ishkapon-theme` `additionalArguments` channel, the
`resolvedTheme` selector, the `systemPrefersDark` store field and its
`prefers-color-scheme` listener, the Appearance pane, and the `sun` icon.

**Consequences.**
- `theme` joins `titleModelId` in `RETIRED_SETTINGS`: dropped from a patch
  rather than fatal, so a stored row or a not-yet-restarted renderer holding
  the old contract cannot block an unrelated settings write. `migrate()`
  iterates `DEFAULT_SETTINGS`, so a retired key is never read in and is gone
  again on the next write.
- `color-scheme: light` moved from the preload into `:root`, where it is a
  declaration about the document rather than something a script has to run
  first. Scrollbars, form controls and the caret follow from it.
- `nativeTheme.themeSource` is still pinned to `'light'` in main. This is the
  one part CSS cannot reach: without it a student on a dark-mode OS gets a dark
  title bar around a light app.
- The `nativeTheme` `'updated'` listener is gone. With `themeSource` pinned,
  the resolved theme cannot change, and a listener that re-asserts a constant
  implies a value is in flux when it is not.
- `showThinking` moved to the Answers pane. It was sharing Appearance with the
  theme selector, and it is about how an answer reads, not how the app looks.

**Rejected: keeping the switch, defaulting to light.** A hidden `theme` field
would have preserved the dark palette "just in case" — at the cost of keeping
it verified and current, forever, for a mode that ships switched off. A
half-maintained dark theme is worse than none, because it will look fine in
review and be wrong in the one place someone checks.

---

## D29 — MathJax, not KaTeX

**Decision.** Mathematics renders through `rehype-mathjax` to **inline SVG**,
in the Markdown pipeline. `rehype-katex` and `katex` are gone as direct
dependencies.

**Rationale.** The author's call, made after looking at real answers rather than
at a demo. Two things were wrong, and it is worth being precise that they were
*different* things:

- **A real defect, found and fixed first.** KaTeX lays a fraction out by drawing
  content *outside* the box it computes — `.vlist > span` is `height: 0`, with
  the numerator moved by `top: -2.3em`. The stylesheet had
  `overflow-y: hidden` on `.katex-display`, which sliced the numerator off the top
  and the denominator off the bottom, leaving the rule stranded between the
  stumps. That was "the numerator and denominator run together and there is no
  line", and it also explains a tall `align` block losing most of its rows.
  Fixed in `c12d11b` before the renderer was replaced, and the fix would have
  been needed under either renderer had KaTeX stayed.
- **A matter of taste that no setting fixes.** KaTeX sets its symbols tighter
  than MathJax. That is a deliberate difference between the two projects, not a
  defect, and no CSS change reverses it. The author found it hard to read.

Also relevant, and the reason a swap rather than a tweak was the right shape:
KaTeX cannot render `multline` at all, and MathJax is markedly more forgiving of
a malformed expression, falling back to showing the source rather than to an
error box.

**The cost, accepted knowingly.** A larger renderer bundle and slower
typesetting. Measured: the renderer chunk is 2.28 MB minified, a full re-render
of a twelve-equation answer is 18 ms, and a streaming delta costs 2–6 ms —
against a 30 ms event coalescing interval, so it is not the bottleneck. The
per-equation DOM weight is real, at roughly 11 KB each, because
`fontCache: 'local'` makes every SVG self-contained.

**Why SVG and not CHTML.** CHML is about a third of the size and would cut the
DOM weight, but it needs a `fontURL` pointing at MathJax's own woff files, which
under `font-src 'self'` means copying them into the bundle and keeping them in
step with the MathJax version. SVG needs no font at all and stays sharp when a
student zooms into an equation. On an offline desktop app, fewer moving parts
beat smaller output.

**Why the extension list is explicit.** `rehype-mathjax` defaults to
`AllPackages`, which includes `html` — TeX can then emit raw markup and
`\href` URLs — and `require`, which can pull in further components at parse time.
Model output is untrusted (D17), so both are excluded and the list of what is
loaded is readable in one place. Verified inert rather than assumed: a
`javascript:` href and an `onerror` image both render as plain text.

**The landmine worth recording.** `mathjax-full/js/components/version.js` reads
its own version with an `eval('require')` that is **not** wrapped in try/catch,
and Rollup does not substitute `PACKAGE_VERSION` on its own. Left undefined, the
minified comparison folds to true, the bundle calls `eval`, and the app's CSP
(`script-src 'self'`, no `unsafe-eval`) throws `EvalError` during module
evaluation — taking down the entire renderer chunk rather than just the
equations. The build emitted no warning beyond Rollup's generic "use of eval is
discouraged", and a clean build still produced it. Fixed by defining
`PACKAGE_VERSION` in `electron.vite.config.ts`, which makes the comparison fold
to false and the `eval` disappear as dead code; verified absent from the bundle
afterwards. **This is the class of bug that looks correct in every check and
fails only on load.**

**Rejected: CHTML with copied fonts.** Smaller, and the DOM weight is the one
genuine cost of SVG. Rejected because it trades a bundle-size win for a font
pipeline that has to stay correct across MathJax upgrades, under a CSP that makes
a mistake a blank page.

**Rejected: keeping KaTeX and fixing the prompt alone.** The prompt work is
right and was done regardless — multi-line `align` over one long chained line,
`\dfrac` over inline `\frac` — but it cannot widen the glyph metrics. It would
have left the actual complaint standing.
