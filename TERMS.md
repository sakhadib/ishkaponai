# Terms of Use

**ISHKAPON AI** — version 0.1.0

These terms cover your use of the ISHKAPON AI desktop application. The application
is open-source software released under the [MIT License](LICENSE); this document
adds the rules of use and, importantly, an honest statement of what the software
cannot promise you.

Last updated: 26 September 2026

---

## 1. What this application is

ISHKAPON AI is an offline-first study aid for physics, chemistry and mathematics. You
type a problem; it produces a worked answer, with the arithmetic carried out by a
Python runtime on your own computer rather than by the model.

It has **no account system and no server of its own.** Questions are sent to
[OpenRouter](https://openrouter.ai), which runs the model. The
[Privacy Policy](PRIVACY.md) describes exactly what is sent.

## 2. Educational use, and its limits

**Language models are wrong sometimes, and they are wrong confidently.** They can
invent plausible values, misapply a formula, misread a diagram, or produce arithmetic
that looks clean and is not. This is a property of the technology, not a defect we
intend to fix in a later release.

Therefore:

- **Check the answer before you rely on it.** Treat ISHKAPON as a second opinion and
  a study aid, not as an authority. For anything that matters — an exam, a
  submission, a laboratory conclusion — verify it against your textbook, your
  teacher, or a worked example you trust.
- **If the answer is wrong, that is a known failure of this kind of software, not a
  defect you may claim against us.** See §5.
- **You are responsible for the conclusions you draw.** A worked example that
  arrives quickly and reads well is not the same as a correct one.

The one thing the application does do is compute rather than recall: every number in
a calculation is produced by Python in the sandbox, and the model is required to
show the code that produced it. That makes arithmetic errors much less likely than
in a system that has the model guess at `4.7 × 8.2`. It does not make reasoning
errors impossible, and it cannot verify that the model set up the right calculation
in the first place.

## 3. Your OpenRouter account, your key, your charges

ISHKAPON does not provide model access and does not bill you.

- **You supply your own OpenRouter API key**, or use OpenRouter's free model router.
- **Any charge is between you and OpenRouter.** Use of a paid model consumes your
  credits at OpenRouter's rates. ISHKAPON shows what it can of token usage; it does
  not set, cap, or see your bill.
- **Your key is yours.** Keep it safe. It is stored encrypted with your operating
  system's secret store where one is available; see
  [PRIVACY.md § Your API key](PRIVACY.md#your-api-key) for the Linux exception, which
  is a real one.
- **Do not paste a key belonging to someone else.** If you use a key you were not
  given permission to use, that is on you and may breach your agreement with
  OpenRouter.

You can run the application without any key at all by selecting the free model
router. Nothing is held back.

## 4. Acceptable use

Do not use the application to:

- produce or distribute content that is unlawful where you are, or that harasses,
  threatens, or exploits anyone;
- attempt to break the sandbox. The calculation environment is deliberately
  restricted — no network, no filesystem, no operating-system commands, no native
  libraries. Attempts to escape it are prohibited, will fail, and are a breach of
  these terms. (The restrictions are documented and honestly described in
  [PRIVACY.md § The calculation sandbox](PRIVACY.md#the-calculation-sandbox) — read
  it, rather than assuming it.)
- submit content you do not have the right to submit;
- interfere with the operation of OpenRouter, including by automating requests
  beyond what a human study session requires, or by attempting to exceed the limits
  of your plan.

Reverse engineering for interoperability is permitted under the MIT License.
Circumventing the sandbox is not.

## 5. No warranty — please read this

The software is provided **"as is", without warranty of any kind**, as stated in the
MIT License. That is not boilerplate here; it is the accurate description of a tool
that calls a third-party model to produce answers about matters of correctness.

In particular, ISHKAPON makes **no warranty** that:

- answers will be accurate, complete, or free of error;
- the application will be available, uninterrupted, or fit for any particular
  purpose;
- a given model will behave the same way tomorrow. Third-party models change
  without notice, and a model you depend on can be retired, repriced, or made worse
  by its provider;
- your data will never be lost. Your chats live in a local database file. Back it up
  if it matters to you.

**ISHKAPON's total liability to you, for any claim arising from this software, is
zero.** Some jurisdictions do not permit the exclusion of implied warranties or
liability for certain kinds of loss, in which case the exclusion applies only to the
extent the law allows.

## 6. Third parties

ISHKAPON is developed independently and is **not affiliated with, endorsed by, or
sponsored by OpenRouter, Electron, Pyodide, MathJax, or any model provider.**

- **OpenRouter** is the party that receives your questions and runs the model. Their
  terms and privacy policy govern that relationship.
  [openrouter.ai/terms](https://openrouter.ai/terms) · [openrouter.ai/privacy](https://openrouter.ai/privacy)
- **The model you select** is a third-party system with its own behaviour, including
  its own training data and its own biases. Different models give different answers
  to the same question, and the application does not hide which one produced a given
  answer.

## 7. Your content

You keep ownership of what you type. ISHKAPON claims no licence over your questions
or your notes beyond the narrow permission needed to transmit them to OpenRouter in
order to produce an answer — which is the entire reason they are transmitted.

## 8. Changes

These terms may change as the software does. The version and date at the top track
the release, and changes are made in the same commit as the behaviour they describe.

## 9. Contact

**ISHKAPON**
5, Kumarpara, Rajshahi, Bangladesh
