import ts from 'typescript'

export const RULES = [
  { id: 'bare-border', hint: 'Specify a soft neutral rim or a semantic border color (STYLE.md §2–4).' },
  { id: 'border-border-full-opacity', hint: 'Use border-border/50 or /60 except on focus-within (STYLE.md §2).' },
  { id: 'directional-bare-border', hint: 'Use background steps between panels, soft dividers inside cards (STYLE.md §2).' },
  { id: 'naked-overflow-scroll', hint: 'Use ScrollArea for UI surfaces; native content overflow needs the global skin (STYLE.md §9).' },
  { id: 'micro-typography', hint: 'Use text-caption or a larger semantic role; minimum 12px (STYLE.md §12).' },
]

export function sourceStrings(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const strings = []
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail) {
      strings.push({ text: node.text, start: node.getStart(file) + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return strings
}

function utility(token) {
  // Colons inside arbitrary selectors/values are not Tailwind variant separators.
  let depth = 0
  let split = -1
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[') depth++
    if (token[i] === ']') depth--
    if (token[i] === ':' && depth === 0) split = i
  }
  return { variant: token.slice(0, split + 1), name: token.slice(split + 1).replace(/^!/, '') }
}

function borderColor(name) {
  return /^border-(?:(?:[tblrxy])-)?(?:border(?:\/[\d.]+)?|transparent|current|inherit|(?:sidebar-border|primary(?:-foreground)?|secondary(?:-foreground)?|destructive|input|ring|muted|accent|foreground)(?:\/[\d.]+)?|(?:amber|rose|emerald|sky|violet|red|green|blue|yellow|orange|cyan|teal|indigo|pink|purple|lime|fuchsia|slate|gray|zinc|neutral|stone)-\d+(?:\/[\d.]+)?|(?:white|black)(?:\/[\d.]+)?|\[(?![\d.]+(?:px|rem|em)\])[^\]]+\])$/.test(name)
}

export function minimumTextViolations(source) {
  const hits = []
  const patterns = [
    /text-\[(?:length:)?([\d.]+)(px|rem|em)\]/g,
    /font-size:\s*([\d.]+)(px|rem|em)\b/g,
    /fontSize:\s*([\d.]+)\b/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const pixels = Number(match[1]) * (match[2] === 'rem' ? 16 : match[2] === 'em' ? 12 : 1)
      if (pixels < 12) hits.push({ index: match.index, value: match[0] })
    }
  }
  return hits
}

export function auditSource(source, filename) {
  const hits = Object.fromEntries(RULES.map(({ id }) => [id, new Set()]))
  const lineAt = (index) => source.slice(0, index).split('\n').length
  for (const { text, start } of sourceStrings(source, filename)) {
    const tokens = text.split(/\s+/).map(utility)
    for (const { name, variant } of tokens) {
      const line = lineAt(start)
      if (/^border(?:-[tblr])?$/.test(name)) {
        const side = name === 'border' ? '' : name.slice(7)
        const colored = tokens.some((token) => (token.variant === variant || token.variant === '')
          && borderColor(token.name)
          && (() => {
            const colorSide = /^border-([tblrxy])-/.exec(token.name)?.[1]
            if (!colorSide) return true
            if (!side) return false
            return colorSide === side || colorSide === 'x' && 'lr'.includes(side) || colorSide === 'y' && 'tb'.includes(side)
          })())
        if (!colored) hits[name === 'border' ? 'bare-border' : 'directional-bare-border'].add(line)
      }
      if (name === 'border-border' && !variant.split(':').includes('focus-within')) {
        hits['border-border-full-opacity'].add(line)
      }
      if (/^overflow-(?:auto|scroll|[xy]-(?:auto|scroll))$/.test(name)) {
        hits['naked-overflow-scroll'].add(line)
      }
    }
  }
  for (const { index } of minimumTextViolations(source)) hits['micro-typography'].add(lineAt(index))
  return Object.fromEntries(Object.entries(hits).map(([id, lines]) => [id, [...lines].sort((a, b) => a - b)]))
}
