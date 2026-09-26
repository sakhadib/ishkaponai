/**
 * MathJax configuration (spec §13.1).
 *
 * Rendered at pipeline time by `rehype-mathjax`, not in the browser. There is no
 * MathJax on the client and no runtime typesetting step: the plugin converts
 * each math node to SVG while the Markdown is being turned into React elements.
 * That keeps the renderer's CSP untouched and means a malformed expression
 * cannot take the page down at runtime.
 *
 * ## Why SVG and not CHTML
 *
 * CHTML is roughly a third of the size but requires a `fontURL` — the output
 * references MathJax's own woff files by URL. Our CSP is `font-src 'self'`, so
 * those files would have to be copied into the bundle and kept in step with the
 * MathJax version. SVG carries its glyph geometry inside the markup, needs no
 * font at all, and stays sharp when a student zooms into an equation. On a local
 * desktop app the extra bytes in the installer are the cheaper trade.
 *
 * The glyphs are filled with `currentColor`, so the equations take the answer's
 * colour from the `--text` token with no per-glyph theming.
 *
 * ## Why the package list is explicit
 *
 * `rehype-mathjax` defaults to `AllPackages`, which includes `html` — a package
 * that lets TeX emit raw markup and `\href` URLs. Model output is untrusted
 * (spec §12.2), and the point of an explicit list is that the answer to "what
 * can this input reach" is readable in one place. `html` and `require` are
 * therefore both left out; `require` is left out because it can pull in further
 * components at parse time, which is a loader we do not want to exist.
 *
 * What is in the list is what a physics, chemistry and mathematics answer
 * actually needs. `mhchem` and `physics` are the two that earn their place on
 * their own — they are why a chemical equation or a differential renders at all.
 */
import type { Options } from 'rehype-mathjax'

/**
 * Extensions, in the order MathJax loads them.
 *
 * - `base` is not optional; everything else is a decision.
 * - `ams` is the important one. It brings `align`, `gather`, `multline`,
 *   `split`, `cases`, `dfrac` and `\tag` — the multi-line derivation
 *   environments the prompt asks for, including `multline`, which KaTeX
 *   cannot render at all.
 * - `noerrors` and `noundefined` are the graceful-degradation pair. A parse
 *   error renders the original TeX in red instead of throwing, and an unknown
 *   macro renders as red text instead of failing the whole expression. A
 *   student sees the source, which is more use to them than an error box.
 */
const PACKAGES: readonly string[] = [
  'base',
  'ams',
  'newcommand',
  'configmacros',
  'noundefined',
  'noerrors',
  'color',
  'boldsymbol',
  'textcomp',
  'textmacros',
  'mathtools',
  'enclose',
  'centernot',
  'extpfeil',
  'gensymb',
  'upgreek',
  'unicode',
  'autoload',
  'tagformat',
  'physics',
  'mhchem'
]

export const MATHJAX_OPTIONS: Options = {
  tex: {
    packages: [...PACKAGES],
    /**
     * `ams` rather than `all`: only AMS environments get numbered, which is what
     * a worked solution wants. `all` would number every `equation` a model
     * writes by reflex, and those numbers mean nothing to a student.
     */
    tags: 'ams',
    /** `\$` in the source is a literal dollar sign, not a broken delimiter. */
    processEscapes: true
  },
  svg: {
    /**
     * Per-equation `<defs>`, so each SVG is self-contained. The alternative,
     * `global`, injects one shared font cache into the document — which React
     * discards on the next re-render, and this pane re-renders on every
     * streamed token.
     */
    fontCache: 'local',
    /**
     * Left-aligned, not centred. A derivation is read downwards and its `=`
     * signs are meant to line up; centring a three-line `align` throws that
     * away and leaves the student re-finding the left edge each row. It also
     * keeps the equations on the same left edge as the prose, which is what
     * `displayAlign: 'center'` would break.
     */
    displayAlign: 'left',
    displayIndent: '0'
  }
}
