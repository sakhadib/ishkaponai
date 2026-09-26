/**
 * SVG sanitisation for Mermaid output.
 *
 * Model output is untrusted, and the product rule (spec §12.2) is that it is
 * never injected as raw HTML. Mermaid's only output channel is an SVG string,
 * so rather than reach for `dangerouslySetInnerHTML` this module parses the
 * string into a detached document, walks it, and rebuilds a node tree from a
 * whitelist. The result is inserted with the DOM API, so no HTML parser ever
 * sees model-derived markup.
 *
 * Mermaid runs with `securityLevel: 'strict'`, which already escapes label
 * text; this is the second, independent layer.
 */

/** Elements that can execute, fetch, or escape the SVG sandbox. */
export const FORBIDDEN_SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'handler',
  'listener',
  'set',
  'animate',
  'animatetransform',
  'animatemotion',
  'discard'
])

/**
 * Attributes that can point somewhere or run something.
 *
 * Exported so the security decision can be verified without a DOM.
 */
export function isForbiddenSvgAttribute(name: string): boolean {
  const lower = name.toLowerCase()
  // Inline event handlers.
  if (lower.startsWith('on')) return true
  // Any navigation or subresource reference. `sanitiseAttributes` re-admits
  // `xlink:href` when it is a same-document fragment, which is how Mermaid
  // wires markers, gradients and clip paths.
  if (lower === 'href' || lower.endsWith(':href')) return true
  if (lower === 'src' || lower === 'srcdoc') return true
  // SMIL animation targets. The elements are already excluded above; this is
  // defence in depth for the same attributes on a permitted element.
  if (lower === 'data' || lower === 'attributename' || lower === 'to' || lower === 'from') {
    return true
  }
  return false
}

/**
 * CSS inside a mermaid `<style>` must not reach outside the document.
 * Exported so the security decision can be verified without a DOM.
 */
export function isSafeSvgCss(css: string): boolean {
  const lower = css.toLowerCase()
  if (lower.includes('@import')) return false
  if (lower.includes('javascript:')) return false
  // `url()` may only reference a same-document fragment, for gradients.
  for (const match of lower.matchAll(/url\(\s*['"]?([^'")]*)/g)) {
    const target = (match[1] ?? '').trim()
    if (!target.startsWith('#')) return false
  }
  return true
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

function sanitiseAttributes(source: Element, target: Element): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name
    const value = attribute.value

    if (isForbiddenSvgAttribute(name)) continue
    if (value.includes('javascript:')) continue

    if (name.toLowerCase() === 'style' && !isSafeSvgCss(value)) continue

    if (name.toLowerCase().startsWith('xlink:')) {
      // Only same-document fragment references survive.
      if (!value.startsWith('#')) continue
      target.setAttributeNS(XLINK_NS, name, value)
      continue
    }
    if (name === 'xml:space') {
      target.setAttributeNS(XML_NS, name, value)
      continue
    }
    target.setAttribute(name, value)
  }
}

function sanitiseNode(source: Node, target: Node): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.nodeValue ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const element = child as Element
    const tag = element.localName.toLowerCase()
    if (FORBIDDEN_SVG_ELEMENTS.has(tag)) continue

    const created = document.createElementNS(SVG_NS, element.localName)
    sanitiseAttributes(element, created)

    if (tag === 'style') {
      const css = element.textContent ?? ''
      if (isSafeSvgCss(css)) created.appendChild(document.createTextNode(css))
    } else {
      sanitiseNode(element, created)
    }

    target.appendChild(created)
  }
}

/**
 * Parses a Mermaid SVG string into a sanitised, document-owned `<svg>` element.
 * Returns `null` when the string is not parseable SVG, so the caller can fall
 * back to showing the source.
 */
export function parseSanitisedSvg(svg: string): SVGSVGElement | null {
  if (svg === '' || typeof DOMParser === 'undefined') return null

  let parsed: Document
  try {
    parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return null
  }

  // A parse failure is reported as a `parsererror` document rather than thrown.
  if (parsed.getElementsByTagName('parsererror').length > 0) return null

  const root = parsed.documentElement
  if (root.localName.toLowerCase() !== 'svg') return null

  const svgElement = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  sanitiseAttributes(root, svgElement)
  sanitiseNode(root, svgElement)
  return svgElement
}
