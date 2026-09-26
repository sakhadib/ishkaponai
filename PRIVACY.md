# Privacy Policy

**ISHKAPON AI** — version 1.0.0

This policy describes what the software actually does. Every claim below was read
out of the source rather than assumed, and the file each claim comes from is named
so you can check it. Where the honest answer is a limitation, it is stated as a
limitation rather than smoothed over.

Last updated: 27 September 2026

---

## The short version

ISHKAPON AI is a local desktop application. It has **no servers of its own, no
account system, and no analytics**. Your questions go to
[OpenRouter](https://openrouter.ai), and nowhere else, because a language model
has to run somewhere for an answer to come back.

Two things are worth reading before you decide it is fine to use:

1. If you fill in your **name, age, grade or subjects** in Settings, those are sent
   to OpenRouter with every single question. They are optional, and the app works
   with all of them blank.
2. **Uninstalling does not delete your data.** See [Deleting your data](#deleting-your-data).

---

## What is sent to OpenRouter

The app talks to exactly three OpenRouter endpoints, and to nothing else on the
network except one documentation link in the Help menu that opens in your browser.

| Endpoint | When | What is sent |
| --- | --- | --- |
| `openrouter.ai/api/v1/chat/completions` | Every question you send | Your question, the conversation so far, your API key, and the settings listed below |
| `openrouter.ai/api/v1/models` | When you open the model list | Nothing identifying. No API key is attached |
| `openrouter.ai/api/v1/key` | When you validate a key | The key itself, to confirm it works |

*(Source: `src/main/openrouter.ts:23-25`, `src/agent/provider.ts`.)*

### Exactly what rides along with each question

Everything below is in the request body:

- **Your question**, and the text of earlier turns in that conversation, so the
  model has context.
- **The Python code the model writes, and the results your device computes.** These
  are calculated on your machine by a sandboxed Python runtime, but the code and
  its output are part of the conversation and are sent like any other text.
- **Your name, age, grade and subjects** — *only if you entered them.* These sit in
  Settings and are injected into the system prompt so answers can be pitched at the
  right level. Leaving them blank means they are never sent.
  *(Source: `src/agent/host.ts:811-812`.)*
- **Any custom instructions** you wrote in Settings.
- **Your chosen language and model.**

### What OpenRouter does with it

That is OpenRouter's policy, not ours, and it is the part you most need to read:
[openrouter.ai/privacy](https://openrouter.ai/privacy).

In short: they are an independent company, they are the processor for everything
listed above, and your agreement to their terms covers what they do with it. ISHKAPON
is not a party to that relationship and cannot see or influence it.

## What stays on your device

A single SQLite database, `ishkapon.db`, in your operating system's per-user
application-data folder, reached through `app.getPath('userData')`. On Windows that
is under `%APPDATA%`, in a folder named after the app — `ISHKAPON AI` for an
installed build, `ishkapon-ai` when you run it from a source checkout.
*(Source: `src/main/index.ts:38,148`.)*

| Table | Holds | Deletable by you |
| --- | --- | --- |
| `sessions` | Chat titles and timestamps | Yes — deleting a chat |
| `messages` | Your questions and the answers, and the Python code and results in each turn | Yes — deleting the chat |
| `tool_calls` | Which calculations ran, and whether they succeeded | Yes — with the chat |
| `settings` | Model, language, your instructions, and the name/age/grade/subjects above | Yes — in Settings |
| `secrets` | Your OpenRouter API key, encrypted (see below) | Yes — clear the key in Settings |
| `usage_daily` | Daily **token counts only**. No question text, no answer text | No — see below |

Also written locally: `window-state.json`, which remembers the window size and
position. Nothing else.

### About the usage table

`usage_daily` keeps a running count of tokens in and tokens out, bucketed by day, so
the Usage page can show totals. It stores **counts, never content**. There is no
question text, no answer text, and no model name in it.

It is deliberately **not** deleted when you delete a chat. A total that shrank
because you tidied up would be a lie, and the Usage page exists to be believed. The
trade-off is that this one table is not something you can remove from inside the
app. Deleting the database file, or uninstalling and then removing that folder,
removes it.

### Your API key

- It is encrypted with your operating system's secret store via Electron's
  `safeStorage` — the Windows Credential Manager, or the macOS Keychain.
  *(Source: `src/main/secrets.ts`.)*
- **If that store is unavailable, the app refuses to save the key** rather than
  writing it in plain text. You can still type a key for the current session; it just
  will not be remembered. *(Source: `src/main/secrets.ts:193-200`.)*
- **The honest exception, on Linux:** Electron's `safeStorage` has a `basic_text`
  backend that stores the "encrypted" value as plain text. Where that backend is
  selected, the key on disk is readable by anything running as your user. The app
  detects and reports which backend is in use rather than implying protection it
  does not have. *(Source: `src/main/secrets.ts:10,37-40`.)*
- The plaintext key exists only in the main process, for as long as a turn is
  running. It is never sent to the renderer.

## What is never collected

There is **no telemetry, no analytics, no crash reporting, and no error reporting**
in this application. No usage counters leave your machine except the token counts
you send to OpenRouter as part of a normal request. Nothing is sent to any
ISHKAPON-owned service, because there is no such service.

## The calculation sandbox

Every number ISHKAPON AI shows you is computed on your own machine, by CPython
running inside WebAssembly, not by the model. This matters for privacy as well as
for honesty, so the specifics are worth stating.

The sandbox has **no network access, no filesystem access, and no ability to run
operating-system commands or load native libraries.** Model-written Python cannot
phone home, read your files, or run a program on your computer.

This is enforced rather than assumed. Pyodide is built for a browser, where the host
has nothing to offer, so it does not lock these down by itself — and each escape was
demonstrated working on Node 24.21 with Pyodide 0.29.5 before being closed:

- **Network.** The WebAssembly build links SOCKFS, which Emscripten proxies to
  `node:net`. `socket.create_connection` really did connect. `socket`, `_socket`,
  `ssl`, `selectors`, `asyncio` and friends are set to `None` in `sys.modules`, so
  importing them raises `ImportError` — which also stops every standard-library
  client that reaches the network through one of them.
- **OS commands.** `os.system` is implemented on top of the host shell and really
  did create a file on disk. It is replaced with a function that raises.
- **Native code.** `ctypes.CDLL(None).system(...)` was another way to run commands.
  The `ctypes` module itself stays, because SymPy needs it at import, but every
  route to a library handle — `CDLL`, `PyDLL`, the platform loaders, `pythonapi` —
  is removed.
- **The host `js` module.** By default it *is* the worker thread's `globalThis`, so
  `from js import fetch` reached the host network. It is replaced with an empty
  module, which leaves `import js` working and every attribute lookup failing.

*(Source: `src/agent/sandbox.ts:600-651`; re-checked on every run by
`src/agent/dev/selfcheck.ts`.)*

Calculation packages are read from a directory on your disk. A missing package is a
file error, never a download, so a calculation cannot pull code from the internet.

## Deleting your data

- **A single chat:** delete it in the sidebar. The messages and calculation records
  go with it. The token counts in the Usage page do not — see
  [About the usage table](#about-the-usage-table).
- **Your API key:** clear the field in Settings.
- **Everything:** quit the app and delete the `ishkapon.db` file and
  `window-state.json` in your user-data folder.
- **Uninstalling the app does not delete either file.** An MSI removes what it
  installed, and your database is not something it installed — it lives in your user
  profile, where Windows leaves it alone. So your chats survive a reinstall, which
  is convenient, and which is also why uninstalling is *not* a way to erase your
  data. Delete the file yourself if you want it gone.

## School students and minors

This app is built for students, and some of them will be minors. The design
consequences are worth being concrete about:

- **No personal information is required.** Every identity field is optional, and the
  app is fully usable with all of them blank. Nothing is collected about you unless
  you type it in.
- **If you do enter a name and age, they are sent to OpenRouter** with each question,
  as described above. Entering a nickname rather than a full name limits this.
- **The app cannot reach the internet on your behalf** beyond the OpenRouter
  requests listed above, so it cannot gather information about you or your device.

**This document describes the software's behaviour. It is not a legal compliance
assessment,** and ISHKAPON makes no claim of GDPR, COPPA, FERPA or equivalent
compliance on the basis of this file. If you need a compliance determination for a
school or district, that is a question for your institution and for OpenRouter as the
actual processor of your data.

## Changes to this policy

If the data this app handles changes, this file changes with it, in the same commit
as the code. There is no separate published version that can drift out of date.

## Contact

**ISHKAPON** — Rajshahi, Bangladesh

**Enquiries, including requests to delete data:**
<https://github.com/sakhadib/ishkaponai/issues>

> A street address is deliberately not published here. This repository is public
> and permanently indexed, and a home address in a public file is scraped within
> hours and cannot be recalled. A city is enough to establish jurisdiction, and
> the issue tracker is a faster and more accountable route for a request than
> post. If a postal address is ever genuinely needed, it belongs in a private
> reply to an issue rather than in a tracked file.
