/**
 * Clipboard access. The renderer has no Node and no `navigator.clipboard`
 * guarantee in an Electron `file://` document, so there is a fallback.
 */

async function writeViaExecCommand(text: string): Promise<void> {
  const area = document.createElement('textarea')
  area.value = text
  // Keep it out of view and out of the accessibility tree, and avoid scrolling.
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('The clipboard rejected the copy request.')
  } finally {
    area.remove()
  }
}

/**
 * Copies `text`, returning `true` on success. Never throws: a failed copy is a
 * cosmetic problem and must not become an unhandled rejection.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or a non-secure context; fall through.
  }
  try {
    await writeViaExecCommand(text)
    return true
  } catch {
    return false
  }
}
