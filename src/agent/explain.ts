/**
 * Restating a provider failure in plain words, with the next step in it.
 *
 * ## Why this module exists
 *
 * Every one of these used to reach the transcript as whatever the provider
 * happened to say. OpenRouter's own wording for a mistyped model is
 *
 *   deepseek/deepseek-v4-flash-latest is not a valid model ID
 *
 * which names the id but not the cause, never says where to fix it, and gives a
 * student who copied that id *verbatim* from openrouter.ai no way to tell that
 * they dropped the leading `~` off a `-latest` alias. The app then looked
 * broken. It is not broken; one character is wrong, and the fix is in Settings.
 *
 * The rule: name what happened, name the fix, and point at the screen. When
 * nothing matches, the provider's own words are still better than a guess, so
 * they are passed through unchanged rather than replaced with something vaguer.
 *
 * No imports, deliberately. This is pure text and it is the one thing in the
 * agent host worth testing without a sandbox, a network, or an API key.
 */

/**
 * @param raw    The provider's message, verbatim.
 * @param modelId The id this turn asked for, which is usually the missing half
 *   of the explanation.
 */
export function explainTurnError(raw: string, modelId: string): string {
  const text = raw.trim()

  // The tilde is invisible in most fonts and is the single most common way to
  // get this wrong, so it is called out by name as well as matched by shape.
  if (/is not a valid model ID/i.test(text) || /\bNo endpoints found\b/i.test(text)) {
    return (
      `OpenRouter does not recognise the model ID “${modelId}”. ` +
      'Check it in Settings → Model and copy it again from the model’s page on ' +
      'openrouter.ai. ' +
      (modelId.startsWith('~')
        ? 'If the ID is exactly that, note that the same model without the leading ~ is a ' +
          'different entry, and the tilde is part of the ID.'
        : 'Some IDs start with a ~ , for example ~deepseek/deepseek-v4-flash-latest.') +
      ' Choosing Free model always works.'
    )
  }

  if (/\b(?:402|insufficient credits|no credits|quota exceeded)\b/i.test(text)) {
    return (
      'OpenRouter says this key has no credits left. Add credits at openrouter.ai, ' +
      'or switch to Free model in Settings → Model.'
    )
  }

  if (/\b(?:429|rate limit|too many requests)\b/i.test(text)) {
    return 'OpenRouter is rate-limiting this key. Wait a moment and ask again.'
  }

  if (/\b(?:401|403|invalid.*(?:api )?key|unauthorized|authentication)\b/i.test(text)) {
    return 'OpenRouter rejected the API key. Check it in Settings → Account.'
  }

  if (/\bdoes not support tools|tool.?calling.*(?:not|un)support/i.test(text)) {
    return (
      `The model “${modelId}” cannot call tools, and ISHKAPON cannot calculate without them. ` +
      'Pick a model whose page lists tool-calling, or choose Free model.'
    )
  }

  if (/\bcontext (?:length|window) exceeded|too many tokens|maximum context\b/i.test(text)) {
    return (
      `The conversation no longer fits in ${modelId}’s context window. ` +
      'Start a new chat, or switch to a model with a larger window.'
    )
  }

  return text
}
