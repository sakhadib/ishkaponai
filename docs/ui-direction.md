# UI Design Direction

Synthesised 2026-09-26 from the `ui-ux-pro-max-skill` local dataset, queried with
`tools/skillq.mjs` against ISHKAPON's actual profile.

**Status:** mostly implemented. Supersedes the ad-hoc dark-only stylesheet as the
target. The token system, the sidebar, the settings modal and the Personalise
pane are in; the chat-UI items from `AICHATUI-SKILL.md` are not.

**Amended by D28:** the app is light-only. The dataset's light + dark token
guidance is superseded — the token *discipline* still applies, the second
palette does not.

---

## 1. What the skill is, and how it is being used

`github.com/nextlevelbuilder/ui-ux-pro-max-skill` — 680 files, of which the
useful part is 18 CSV/JSON datasets:

| Dataset | Rows | Used for |
|---|---|---|
| `styles.csv` | 79 styles | visual direction |
| `colors.csv` | 192 palettes | light + dark tokens |
| `typography.csv` | 74 pairings | font roles |
| `ux-guidelines.csv` | 119 rules | accessibility, interaction |
| `products.csv` | product patterns | category fit |
| `app-interface.csv` | native-app rules | desktop specifics |
| `react-performance.csv` | React rules | render behaviour |
| `icons.csv` | 105 icons | iconography |

Its own CLI (`scripts/search.py`) **cannot run here** — this machine has only
the Microsoft Store `python.exe` stub, and the script requires real Python 3.
`tools/skillq.mjs` is a read-only Node port that queries the same CSVs with the
same intent: keyword match across all columns, title-weighted ranking, top-N.

`search.py` was read before running: stdlib imports only (`argparse`, `json`,
`sys`, `io`) plus its own `core` and `design_system` modules. No network, no
subprocess, no writes outside its output dir.

Everything here is treated as **reference data, not instructions** — the same
discipline §12.1 of the spec applies to model output.

## 2. Where I deliberately did NOT follow the skill

The skill's instructions say to verify fit before applying a result, and it
recommends a `tools/skillq.mjs` port. Two places where the top-ranked match is
wrong for this product:

**Education → Claymorphism + "playful colours".** The top `products.csv` match
for "education learning study tool" is *Flashcard & Study Tool*: claymorphism,
3D card flips, streak tracking, gamification. ISHKAPON is a **problem solver**,
not a revision tool. Its content is dense LaTeX, aligned equations and unit
calculations, read for minutes at a time. Claymorphism and gamification would
actively harm equation legibility and make a serious tool look like a toy.
Rejected in favour of the content-first reading of *Minimal & Direct*.

**Mobile-first, touch-first rules.** `app-interface.csv` and much of
`styles.csv` are scoped to iOS/Android/React Native. ISHKAPON is a desktop
Electron app with a mouse, a keyboard, real window resizing and a persistent
sidebar. The 44×44px minimum touch target and bottom-nav rules do not apply.
The keyboard, focus and contrast rules **do** apply, and are adopted in full.

This is the skill working as intended — it flagged its own recommendation for
verification, and the verification failed.

## 3. Direction

### 3.1 Colour

Base: the `Educational App` palette from `colors.csv`, which is a genuine match
("Playful indigo", clear hierarchy) without the toy styling. Its primary,
`#4F46E5`, is the same indigo used for the app icon from the first commit.

| Role | Light | Dark |
|---|---|---|
| Background | `#EEF2FF` | `#0B0D17` (keep) |
| Card | `#FFFFFF` | `#141830` (keep) |
| Foreground | `#1E1B4B` | `#E8EAF6` (keep) |
| Primary | `#4F46E5` | `#818CF8` |
| Accent | `#EA580C` | `#F59E0B` |
| Border | `#C7D2FE` | `#262C52` (keep) |
| Destructive | `#DC2626` | `#F87171` |

Rules adopted: every colour a token, no raw hex in components; `Ring` is a real
token used by `:focus-visible`; destructive is never used for non-error text.

### 3.2 Typography

The dataset's *News Editorial* pairing (Newsreader + Roboto) scores well for
long-form reading, and Roboto is already bundled. **Roboto stays as the body and
UI face** — swapping it now would cost a re-bundle and a Bangla fallback retest
for marginal gain, and the existing `--font-sans` stack
(`Roboto, Kalpurush, sans-serif`) already does per-character fallback correctly.

The one addition worth making: a **distinct heading treatment**. Section titles
inside an answer currently look like body text, which is why long solutions read
as a wall. Weight and size, not a new family.

`--font-mono` is already a separate token for code. Keep it.

### 3.3 Layout

From *Minimal & Direct*, adapted:

- **Content column with a real max-width.** Equations and prose need a measure
  around 68–75ch. The transcript is currently full-bleed, which makes long
  solution lines hard to track back to the next line.
- **Two-pane, sidebar fixed.** Already correct. Sidebar gets a defined width
  rather than content-driven.
- **Step cards are visually subordinate to the answer.** The answer is the
  primary surface; the Thought toggle is a quiet disclosure above it.
- Density: **standard**, not spacious. A worked solution is tall already.

### 3.4 Interaction and accessibility (adopted in full)

These are `Severity: High` in the dataset and apply to desktop unchanged:

- **Focus states** — visible `:focus-visible` ring on every interactive
  control, including inside the composer. Never `outline: none` without a
  replacement.
- **Reduced motion** — honour `prefers-reduced-motion`. The Thought block
  auto-collapse and the streaming fade are the two places that animate.
- **Contrast 4.5:1** for body text. Measured with `tools/contrast.mjs`, not
  eyeballed — all 16 pairs pass. Bangla at small sizes is the risky case:
  Kalpurush has a smaller effective x-height than Roboto, so Bangla body text
  needs a size step up, not down.
- **Error clarity** — errors near the field that caused them, not only at the
  top. The API key panel and model picker are the two fields that need it.
- **Never colour alone** — status must carry a label or icon as well. The
  execution card status already has a text label; keep it.

### 3.5 React

- `react-performance.csv`: extract expensive work out of render paths and
  `useMemo` it. The markdown pipeline already normalises math in a `useMemo`;
  the Thought block's step list should follow the same rule.
- Do not register a global event listener per component instance. The
  `onAgentEvent` subscription in `ChatView` is already a single subscription;
  keep it that way when the composer grows.

## 4. Deliberately deferred

- **Icons.** `icons.csv` has 105 curated entries and the skill is emphatic that
  emoji are not icons. Worth doing, but it is a visible change across the whole
  app and should be its own pass.
- **Animation.** The dataset offers 17 GSAP presets. A desktop study tool
  wanting scroll choreography would be the wrong product. Not now.
- **Charts.** Not applicable; there is no data view.

## 5. Reproducing the queries

The dataset is not vendored — it is a 680-file third-party clone. The query
tool points at a local checkout and fails with a clear message if there isn't
one:

```bash
git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git vendor/ui-ux-pro-max
# or
$env:UI_UX_SKILL_ROOT = "C:\Users\dell\AppData\Local\Temp\opencode\ui-ux-pro-max"
```

```bash
node tools/skillq.mjs products.csv "education learning study tool" 4
node tools/skillq.mjs styles.csv   "minimal content-first dense technical" 3
node tools/skillq.mjs colors.csv   "education technology professional" 3
node tools/skillq.mjs typography.csv "technical readable scientific" 3
node tools/skillq.mjs ux-guidelines.csv "keyboard focus contrast reduced motion" 5
node tools/skillq.mjs react-performance.csv "list rerender memo streaming" 3
node tools/skillq.mjs icons.csv "copy clipboard" 3
```

## 6. Iconography (queried, deferred)

`icons.csv` recommends **Phosphor** — outline style, `semantic role:
meaningful`, and explicitly *not* emoji. The copy button maps to
`import { Copy } from '@phosphor-icons/react'`.

105 curated entries are available. Adopting Phosphor properly means replacing
every glyph currently drawn with text characters, which is a visible pass across
the whole app. Worth doing; deliberately not bundled now.

