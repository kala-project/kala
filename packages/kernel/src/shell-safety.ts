/**
 * Recursive Shell Command AST / Token-Stream Safety Analyzer.
 *
 * Pure, zero-dependency parser and classifier used by the Kernel reducer,
 * Host runtime / extension hooks, and Workspace Executor to inspect `shell` /
 * `bash` commands across compound pipelines, nested subshells, command
 * substitutions, wrapper binaries (`sudo`, `env`, `bash -c`, `xargs`,
 * `find -exec`), redirections, and shell expansion constructs.
 */

export type ShellSafetyRisk = 'safe' | 'caution' | 'high_risk' | 'blocked'

export interface ShellSafetyFinding {
  readonly ruleId: string
  readonly risk: ShellSafetyRisk
  readonly segment: string
  readonly reason: string
}

export interface ShellSafetyReport {
  readonly command: string
  readonly risk: ShellSafetyRisk
  readonly requiresExplicitApproval: boolean
  readonly findings: readonly ShellSafetyFinding[]
  readonly summary?: string
}

const RISK_RANK: Record<ShellSafetyRisk, number> = {
  safe: 0,
  caution: 1,
  high_risk: 2,
  blocked: 3,
}

function maxRisk(a: ShellSafetyRisk, b: ShellSafetyRisk): ShellSafetyRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b
}

const SAFE_READONLY_BINARIES = new Set([
  'true',
  'false',
  'pwd',
  'whoami',
  'id',
  'uname',
  'date',
  'echo',
  'printf',
  'ls',
  'dir',
  'stat',
  'file',
  'wc',
  'head',
  'tail',
  'cat',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'which',
  'whereis',
  'type',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'du',
  'df',
  'ps',
  'top',
  'uptime',
  'printenv',
  'jq',
  'cut',
  'sort',
  'uniq',
  'tr',
  'diff',
  'comm',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'test',
  '[',
])

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'tag',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  ' blame',
  'blame',
  'shortlog',
  'describe',
  'remote',
  'config',
  'worktree',
])

const KNOWN_GIT_MUTATIONS = new Set([
  'add', 'commit', 'fetch', 'pull', 'switch', 'merge', 'rebase', 'cherry-pick',
  'stash', 'init', 'clone', 'mv', 'rm', 'submodule', 'bisect',
])

const INSPECTED_GIT_MUTATIONS = new Set(['push', 'reset', 'clean', 'checkout', 'restore', 'branch'])

const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
])

const DOWNLOAD_BINARIES = new Set([
  'curl',
  'wget',
  'fetch',
])

const WRAPPER_BINARIES = new Set([
  'command',
  'builtin',
  'exec',
  '!',
  'nohup',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'timeout',
])

const OPAQUE_SHELL_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'alias', 'unalias', 'coproc', '[[', '((',
  '{', '}',
])

export interface ParsedSegment {
  readonly raw: string
  readonly operatorBefore?: '|' | '&&' | '||' | ';' | '&' | '\n'
  readonly tokens: readonly string[]
  readonly redirections: readonly { op: string; target: string }[]
  readonly substitutions: readonly string[]
  readonly subshells: readonly string[]
}

/**
 * Extract nested `$(...)` and backtick command substitutions while respecting
 * single-quote literacy and backslash escaping.
 */
function extractSubstitutionsAndSubshells(source: string): {
  substitutions: string[]
  subshells: string[]
} {
  const substitutions: string[] = []
  const subshells: string[] = []
  let i = 0
  let inSingle = false
  let inDouble = false

  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\\' && !inSingle) {
      i += 2
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      i += 1
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      i += 1
      continue
    }
    if (!inSingle && ch === '$' && source[i + 1] === '(') {
      // Distinguish arithmetic $(( ... )) from command substitution $( ... )
      if (source[i + 2] === '(') {
        i += 3
        continue
      }
      const start = i + 2
      let depth = 1
      let j = start
      let subSingle = false
      let subDouble = false
      while (j < source.length && depth > 0) {
        const c = source[j]!
        if (c === '\\' && !subSingle) {
          j += 2
          continue
        }
        if (c === "'" && !subDouble) subSingle = !subSingle
        else if (c === '"' && !subSingle) subDouble = !subDouble
        else if (!subSingle && !subDouble) {
          if (c === '(') depth += 1
          else if (c === ')') depth -= 1
        }
        j += 1
      }
      if (depth === 0) {
        substitutions.push(source.slice(start, j - 1))
        i = j
        continue
      }
    }
    if (!inSingle && ch === '`') {
      const start = i + 1
      let j = start
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '`') break
        j += 1
      }
      if (j < source.length) {
        substitutions.push(source.slice(start, j))
        i = j + 1
        continue
      }
    }
    if (!inSingle && !inDouble && ch === '(') {
      const start = i + 1
      let depth = 1
      let j = start
      let subSingle = false
      let subDouble = false
      while (j < source.length && depth > 0) {
        const c = source[j]!
        if (c === '\\' && !subSingle) {
          j += 2
          continue
        }
        if (c === "'" && !subDouble) subSingle = !subSingle
        else if (c === '"' && !subSingle) subDouble = !subDouble
        else if (!subSingle && !subDouble) {
          if (c === '(') depth += 1
          else if (c === ')') depth -= 1
        }
        j += 1
      }
      if (depth === 0) {
        subshells.push(source.slice(start, j - 1))
        i = j
        continue
      }
    }
    i += 1
  }

  return { substitutions, subshells }
}

/**
 * Split a shell script into top-level command segments separated by
 * `|`, `&&`, `||`, `;`, `&`, or `\n`, while respecting quotes, `$(...)`,
 * and `(...)` groups.
 */
export function splitShellSegments(command: string): Array<{
  raw: string
  operatorBefore?: '|' | '&&' | '||' | ';' | '&' | '\n'
}> {
  const result: Array<{ raw: string; operatorBefore?: '|' | '&&' | '||' | ';' | '&' | '\n' }> = []
  let current = ''
  let lastOp: '|' | '&&' | '||' | ';' | '&' | '\n' | undefined
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let parenDepth = 0

  const flush = (nextOp?: '|' | '&&' | '||' | ';' | '&' | '\n') => {
    const trimmed = current.trim()
    if (trimmed.length > 0) {
      result.push({ raw: trimmed, ...(lastOp ? { operatorBefore: lastOp } : {}) })
    }
    current = ''
    lastOp = nextOp
  }

  while (i < command.length) {
    const ch = command[i]!
    const next = command[i + 1]

    if (ch === '\\' && !inSingle) {
      current += ch + (next ?? '')
      i += 2
      continue
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle
      current += ch
      i += 1
      continue
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble
      current += ch
      i += 1
      continue
    }
    if (ch === '`' && !inSingle) {
      inBacktick = !inBacktick
      current += ch
      i += 1
      continue
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '#') {
        // Comment to end of line when preceded by whitespace or start of segment
        const prev = i > 0 ? command[i - 1]! : ' '
        if (/\s|[;&|(\n]/.test(prev)) {
          while (i < command.length && command[i] !== '\n') i += 1
          continue
        }
      }
      if (ch === '(') {
        parenDepth += 1
        current += ch
        i += 1
        continue
      }
      if (ch === ')' && parenDepth > 0) {
        parenDepth -= 1
        current += ch
        i += 1
        continue
      }
      if (parenDepth === 0) {
        if (ch === '&' && next === '&') {
          flush('&&')
          i += 2
          continue
        }
        if (ch === '|' && next === '|') {
          flush('||')
          i += 2
          continue
        }
        if (ch === '|') {
          flush('|')
          i += 1
          continue
        }
        if (ch === ';') {
          flush(';')
          i += 1
          continue
        }
        if (ch === '\n') {
          flush('\n')
          i += 1
          continue
        }
        if (ch === '&') {
          // Ignore redirection forms like 2>&1, >&2, &>file, &>>file
          const prev = i > 0 ? command[i - 1]! : ''
          if (prev !== '>' && next !== '>') {
            flush('&')
            i += 1
            continue
          }
        }
      }
    }

    current += ch
    i += 1
  }

  flush()
  return result
}

function tokenizeSegment(raw: string): {
  tokens: string[]
  redirections: Array<{ op: string; target: string }>
} {
  const rawTokens: string[] = []
  let current = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let parenDepth = 0

  while (i < raw.length) {
    const ch = raw[i]!
    if (ch === '\\' && !inSingle) {
      if (i + 1 < raw.length) {
        current += raw[i + 1]!
        i += 2
        continue
      }
    }
    if (ch === "'" && !inDouble && parenDepth === 0) {
      inSingle = !inSingle
      i += 1
      continue
    }
    if (ch === '"' && !inSingle && parenDepth === 0) {
      inDouble = !inDouble
      i += 1
      continue
    }
    if (!inSingle && !inDouble) {
      if (ch === '(') {
        parenDepth += 1
        current += ch
        i += 1
        continue
      }
      if (ch === ')' && parenDepth > 0) {
        parenDepth -= 1
        current += ch
        i += 1
        continue
      }
      if (parenDepth === 0 && /\s/.test(ch)) {
        if (current.length > 0) {
          rawTokens.push(current)
          current = ''
        }
        i += 1
        continue
      }
      if (parenDepth === 0 && (ch === '>' || ch === '<')) {
        if (current.length > 0 && !/^\d+$/.test(current)) {
          rawTokens.push(current)
          current = ''
        }
        let op = current + ch
        current = ''
        i += 1
        while (i < raw.length && (raw[i] === '>' || raw[i] === '<' || raw[i] === '&')) {
          op += raw[i]!
          i += 1
        }
        rawTokens.push(op)
        continue
      }
    }
    current += ch
    i += 1
  }
  if (current.length > 0) rawTokens.push(current)

  const tokens: string[] = []
  const redirections: Array<{ op: string; target: string }> = []
  for (let idx = 0; idx < rawTokens.length; idx += 1) {
    const tok = rawTokens[idx]!
    if (/^(?:\d+)?(?:>>?|<<?|[<>]&|&>>?)/.test(tok)) {
      const attachedTarget = tok.replace(/^(?:\d+)?(?:>>?|<<?|[<>]&|&>>?)/, '')
      if (attachedTarget.length > 0) {
        redirections.push({ op: tok.slice(0, tok.length - attachedTarget.length), target: attachedTarget })
      } else if (idx + 1 < rawTokens.length) {
        redirections.push({ op: tok, target: rawTokens[idx + 1]! })
        idx += 1
      }
      continue
    }
    tokens.push(tok)
  }

  return { tokens, redirections }
}

function normalizeBinaryName(token: string): string {
  const slashIdx = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  const base = slashIdx >= 0 ? token.slice(slashIdx + 1) : token
  return base.toLowerCase()
}

function stripLeadingEnvAssignments(tokens: readonly string[]): {
  assignments: Array<{ name: string; value: string }>
  argv: string[]
} {
  const assignments: Array<{ name: string; value: string }> = []
  let idx = 0
  while (idx < tokens.length) {
    const tok = tokens[idx]!
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tok)
    if (!match) break
    assignments.push({ name: match[1]!, value: match[2]! })
    idx += 1
  }
  return { assignments, argv: tokens.slice(idx) }
}

function unwrapCommandWrappers(argv: readonly string[]): {
  wrappers: string[]
  unwrappedArgv: string[]
  inlineShellScript?: string
} {
  const wrappers: string[] = []
  let current = [...argv]

  while (current.length > 0) {
    const bin = normalizeBinaryName(current[0]!)
    if (bin === 'sudo' || bin === 'doas' || bin === 'su') {
      wrappers.push(bin)
      let i = 1
      while (i < current.length && current[i]!.startsWith('-')) {
        const flag = current[i]!
        i += 1
        if ((flag === '-u' || flag === '-g' || flag === '-C' || flag === '-h' || flag === '-p') && i < current.length) {
          i += 1
        }
      }
      current = current.slice(i)
      continue
    }
    if (bin === 'env') {
      wrappers.push(bin)
      let i = 1
      while (i < current.length) {
        const tok = current[i]!
        if (tok === '-S' || tok === '--split-string' || tok.startsWith('--split-string=') || (tok.startsWith('-S') && tok.length > 2)) {
          return {
            wrappers,
            unwrappedArgv: current,
            inlineShellScript: tok.startsWith('--split-string=') ? tok.slice('--split-string='.length) :
              tok.length > 2 && tok.startsWith('-S') ? tok.slice(2) : current[i + 1] ?? '',
          }
        }
        if (tok === '-i' || tok === '-0' || tok === '--ignore-environment') {
          i += 1
          continue
        }
        if ((tok === '-u' || tok === '-C' || tok === '--unset' || tok === '--chdir') && i + 1 < current.length) {
          i += 2
          continue
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
          i += 1
          continue
        }
        break
      }
      current = current.slice(i)
      continue
    }
    if (WRAPPER_BINARIES.has(bin)) {
      wrappers.push(bin)
      let i = 1
      if (bin === 'timeout') {
        while (i < current.length && current[i]!.startsWith('-')) {
          const flag = current[i]!
          i += 1
          if ((flag === '-s' || flag === '-k') && i < current.length) i += 1
        }
        if (i < current.length) i += 1 // duration argument
      } else {
        while (i < current.length && current[i]!.startsWith('-')) i += 1
      }
      current = current.slice(i)
      continue
    }
    if (SHELL_INTERPRETERS.has(bin)) {
      wrappers.push(bin)
      for (let i = 1; i < current.length; i += 1) {
        const tok = current[i]!
        if (
          tok === '-c' ||
          tok === '-lc' ||
          tok === '-ic' ||
          tok === '/c' ||
          tok === '/C' ||
          tok.toLowerCase() === '-command' ||
          (/^-[a-zA-Z]*c$/.test(tok) && !tok.startsWith('--'))
        ) {
          const script = current[i + 1]
          if (typeof script === 'string' && script.length > 0) {
            return { wrappers, unwrappedArgv: current, inlineShellScript: script }
          }
        }
      }
    }
    break
  }

  return { wrappers, unwrappedArgv: current }
}

function isDangerousRmTarget(target: string): 'root' | 'wildcard_or_home' | null {
  const cleaned = target.replace(/^['"]|['"]$/g, '').trim()
  if (!cleaned || cleaned.startsWith('-')) return null
  if (
    cleaned === '/' ||
    cleaned === '/*' ||
    cleaned === '/.' ||
    cleaned === '/..' ||
    cleaned === '/etc' ||
    cleaned === '/usr' ||
    cleaned === '/var' ||
    cleaned === '/bin' ||
    cleaned === '/sbin' ||
    cleaned === '/lib' ||
    cleaned === '/lib64' ||
    cleaned === '/boot' ||
    cleaned === '/dev' ||
    cleaned === '/proc' ||
    cleaned === '/sys'
  ) {
    return 'root'
  }
  if (
    cleaned === '~' ||
    cleaned === '~/' ||
    cleaned === '~/*' ||
    cleaned === '$HOME' ||
    cleaned === '${HOME}' ||
    cleaned === '$HOME/*' ||
    cleaned === '${HOME}/*' ||
    cleaned === '*' ||
    cleaned === '.*' ||
    cleaned === '..' ||
    cleaned === '../' ||
    cleaned === '../*'
  ) {
    return 'wildcard_or_home'
  }
  return null
}

function hasUnclosedShellSyntax(command: string): boolean {
  let single = false
  let double = false
  let backtick = false
  let parentheses = 0
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (ch === '\\' && !single) { i += 1; continue }
    if (ch === "'" && !double && !backtick) { single = !single; continue }
    if (ch === '"' && !single && !backtick) { double = !double; continue }
    if (ch === '`' && !single) { backtick = !backtick; continue }
    if (single || backtick) continue
    if (ch === '(' && (!double || command[i - 1] === '$')) parentheses += 1
    if (ch === ')' && parentheses > 0) parentheses -= 1
  }
  return single || double || backtick || parentheses > 0
}

function hasProcessSubstitution(command: string): boolean {
  let single = false
  let double = false
  let backtick = false
  for (let i = 0; i < command.length - 1; i += 1) {
    const ch = command[i]!
    if (ch === '\\' && !single) { i += 1; continue }
    if (ch === "'" && !double && !backtick) { single = !single; continue }
    if (ch === '"' && !single && !backtick) { double = !double; continue }
    if (ch === '`' && !single) { backtick = !backtick; continue }
    if (!single && !double && !backtick && (ch === '<' || ch === '>') && command[i + 1] === '(') return true
  }
  return false
}

function hasAnsiCQuote(command: string): boolean {
  let single = false
  let double = false
  for (let i = 0; i < command.length - 1; i += 1) {
    const ch = command[i]!
    if (ch === '\\' && !single) { i += 1; continue }
    if (ch === "'" && !double) { single = !single; continue }
    if (ch === '"' && !single) { double = !double; continue }
    if (!single && !double && ch === '$' && command[i + 1] === "'") return true
  }
  return false
}

/**
 * Analyze a shell command string and return a structured safety report.
 */
export function analyzeShellCommand(command: string, depth = 0): ShellSafetyReport {
  const findings: ShellSafetyFinding[] = []
  const trimmed = command.trim()
  if (depth > 8) {
    return {
      command,
      risk: 'blocked',
      requiresExplicitApproval: true,
      findings: [{
        ruleId: 'shell.parse.depth_limit',
        risk: 'blocked',
        segment: trimmed,
        reason: 'Nested shell syntax exceeds the analyzer recursion limit and cannot be inspected.',
      }],
    }
  }
  if (trimmed.length === 0) {
    return {
      command,
      risk: 'safe',
      requiresExplicitApproval: false,
      findings: [],
    }
  }
  if (hasUnclosedShellSyntax(trimmed)) {
    findings.push({
      ruleId: 'shell.parse.incomplete',
      risk: 'blocked',
      segment: trimmed,
      reason: 'Unclosed shell quote, substitution, or group cannot be analyzed reliably.',
    })
  }
  if (hasProcessSubstitution(trimmed)) {
    findings.push({
      ruleId: 'shell.parse.process_substitution',
      risk: 'high_risk',
      segment: trimmed,
      reason: 'Process substitution produces a dynamic file or script and requires explicit approval.',
    })
  }
  if (hasAnsiCQuote(trimmed)) {
    findings.push({
      ruleId: 'shell.parse.ansi_c_quote',
      risk: 'high_risk',
      segment: trimmed,
      reason: 'ANSI-C quotes can synthesize executable names or scripts after tokenization.',
    })
  }

  // 1. Global raw-syntax checks for prompt-injection & shell obfuscation exploits
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*@[PpaAekK]\}/.test(trimmed)) {
    findings.push({
      ruleId: 'shell.obfuscation.param_transform',
      risk: 'blocked',
      segment: trimmed,
      reason: 'Parameter transformation operator (${var@P} / @a / @Q) is prohibited as a command obfuscation vector.',
    })
  }
  if (/\$\{![A-Za-z_][A-Za-z0-9_]*[*@]?\}|\$\{![A-Za-z_][A-Za-z0-9_]*\[/.test(trimmed)) {
    findings.push({
      ruleId: 'shell.obfuscation.indirect_expansion',
      risk: 'blocked',
      segment: trimmed,
      reason: 'Indirect variable expansion (${!var}) is prohibited because it dynamically constructs commands from variable names.',
    })
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(trimmed)) {
    findings.push({
      ruleId: 'shell.destructive.fork_bomb',
      risk: 'blocked',
      segment: trimmed,
      reason: 'POSIX shell fork bomb detected.',
    })
  }

  const segments = splitShellSegments(trimmed)
  let allSegmentsSafeReadonly = segments.length > 0

  // Track variable assignments across segments to detect progressive command construction
  const assignedVars = new Map<string, string>()

  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const seg = segments[segIdx]!
    const prevSeg = segIdx > 0 ? segments[segIdx - 1] : undefined

    // Recursively inspect nested $(...) and (...) subshells
    const { substitutions, subshells } = extractSubstitutionsAndSubshells(seg.raw)
    if (substitutions.length > 0) {
      allSegmentsSafeReadonly = false
      for (const sub of substitutions) {
        const subReport = analyzeShellCommand(sub, depth + 1)
        for (const f of subReport.findings) findings.push(f)
      }
    }
    for (const sub of subshells) {
      if (sub.trim() !== seg.raw.replace(/^\(|\)$/g, '').trim()) {
        const subReport = analyzeShellCommand(sub, depth + 1)
        if (subReport.risk !== 'safe') allSegmentsSafeReadonly = false
        for (const f of subReport.findings) findings.push(f)
      } else {
        const subReport = analyzeShellCommand(sub, depth + 1)
        if (subReport.risk !== 'safe') allSegmentsSafeReadonly = false
        for (const f of subReport.findings) findings.push(f)
      }
    }

    const { tokens, redirections } = tokenizeSegment(seg.raw)
    const { assignments, argv } = stripLeadingEnvAssignments(tokens)

    if (/^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(seg.raw)) {
      findings.push({
        ruleId: 'shell.parse.function_definition',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'Function definitions can hide commands outside the supported shell grammar.',
      })
    }

    for (const assign of assignments) {
      assignedVars.set(assign.name, assign.value)
    }

    // Detect chained variable assignments that progressively build and execute a command
    if (argv.length > 0 && assignedVars.size >= 2) {
      const firstToken = argv[0]!
      if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(firstToken)) {
        findings.push({
          ruleId: 'shell.obfuscation.chained_var_exec',
          risk: 'blocked',
          segment: seg.raw,
          reason: 'Executing a command constructed from chained variable assignments is prohibited.',
        })
      }
    }

    // Inspect redirections
    for (const redir of redirections) {
      if (redir.op.includes('<<')) {
        findings.push({
          ruleId: 'shell.parse.here_document',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Here-documents and here-strings can provide an uninspected interpreter script.',
        })
      }
      const isWriteRedir = redir.op.includes('>')
      if (!isWriteRedir) continue
      const target = redir.target.replace(/^['"]|['"]$/g, '')
      if (target !== '/dev/null' && !/^&\d+$/.test(target)) {
        allSegmentsSafeReadonly = false
      }
      if (
        /^\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|vd[a-z]\d*|xvd[a-z]\d*|disk\d+|mem|kmem)$/i.test(target) ||
        /^\/(?:etc|boot|usr|bin|sbin)\//.test(target)
      ) {
        findings.push({
          ruleId: 'shell.redirection.system_or_device',
          risk: 'blocked',
          segment: seg.raw,
          reason: `Redirection writes directly to protected system path or block device '${target}'.`,
        })
      } else if (/^\/dev\/tcp\/|^\/dev\/udp\//.test(target)) {
        findings.push({
          ruleId: 'shell.redirection.raw_socket',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `Redirection opens raw network socket '${target}'.`,
        })
      }
    }

    if (argv.length === 0) continue

    const { wrappers, unwrappedArgv, inlineShellScript } = unwrapCommandWrappers(argv)

    if (wrappers.includes('sudo') || wrappers.includes('doas') || wrappers.includes('su')) {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.privilege.escalation',
        risk: 'high_risk',
        segment: seg.raw,
        reason: `Privilege escalation wrapper '${wrappers[0]}' requires explicit approval.`,
      })
    }

    if (inlineShellScript !== undefined) {
      allSegmentsSafeReadonly = false
      if (wrappers.includes('env') && argv.some((arg) => arg === '-S' || arg.startsWith('-S') || arg.startsWith('--split-string'))) {
        findings.push({
          ruleId: 'shell.execution.env_split_string',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'env -S splits an executable command string; require approval when its arguments cannot be reconstructed.',
        })
      }
      if (/(?:^|[;&|])\s*\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})/.test(inlineShellScript)) {
        findings.push({
          ruleId: 'shell.execution.dynamic_script',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Interpreter script is supplied through shell variable expansion and cannot be inspected statically.',
        })
      }
      if (/\$\(|`/.test(inlineShellScript)) {
        findings.push({
          ruleId: 'shell.execution.dynamic_script',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Command substitution can generate an interpreter script that cannot be inspected statically.',
        })
      }
      const nested = analyzeShellCommand(inlineShellScript, depth + 1)
      for (const f of nested.findings) findings.push(f)
    }

    if (unwrappedArgv.length === 0) continue
    const bin = normalizeBinaryName(unwrappedArgv[0]!)
    const args = unwrappedArgv.slice(1)

    if (/\$|`/.test(unwrappedArgv[0]!)) {
      findings.push({
        ruleId: 'shell.execution.dynamic_executable',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'Expanded command name cannot be resolved statically.',
      })
    }

    if (OPAQUE_SHELL_KEYWORDS.has(bin)) {
      findings.push({
        ruleId: 'shell.parse.unsupported_control',
        risk: 'high_risk',
        segment: seg.raw,
        reason: `Shell control flow or alias '${bin}' cannot be resolved by the command-list analyzer.`,
      })
    }
    if (SHELL_INTERPRETERS.has(bin) && inlineShellScript === undefined && (
      args.length === 0 || args.some((a) => !a.startsWith('-')) ||
      redirections.some((r) => r.op.startsWith('<')) || seg.operatorBefore === '|'
    )) {
      findings.push({
        ruleId: 'shell.execution.opaque_script',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'Interpreter reads an external file or standard input whose contents cannot be inspected.',
      })
    }
    if (bin === 'source' || bin === '.') {
      findings.push({
        ruleId: 'shell.execution.opaque_script',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'Sourcing a file or dynamic stream runs code outside the visible command string.',
      })
    }
    if (/^(?:python(?:\d+(?:\.\d+)?)?|node|ruby|perl|php|awk|gawk|mawk|lua|bun|deno)$/.test(bin) && !args.every((a) => a === '--help' || a === '--version')) {
      findings.push({
        ruleId: 'shell.execution.opaque_interpreter',
        risk: 'high_risk',
        segment: seg.raw,
        reason: `Interpreter '${bin}' can execute code outside the supported shell grammar.`,
      })
    }
    if (bin === 'busybox') {
      findings.push({
        ruleId: 'shell.execution.opaque_interpreter',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'BusyBox applets include shell interpreters and cannot be resolved by this command parser.',
      })
    }
    if (bin === 'tee' && args.some((a) =>
      a !== '/dev/null' && (a.startsWith('/') || a.startsWith('~') || a.startsWith('..') || a.includes('$')))) {
      findings.push({
        ruleId: 'shell.redirection.tee_outside_workspace',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'tee writes to an absolute, parent, home, or dynamically expanded path.',
      })
    }
    if (bin === 'sed' && args.some((a) =>
      a === '-e' || a.startsWith('-e') || a === '--expression' || a.startsWith('--expression=') ||
      a === '-f' || a.startsWith('-f') || a === '--file' || a.startsWith('--file=') ||
      /(?:^|;)\s*w\s+/.test(a))) {
      findings.push({
        ruleId: 'shell.execution.sed_script',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'sed scripts may execute the write command or load a script not visible to the analyzer.',
      })
    }
    if (bin === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre='))) {
      findings.push({
        ruleId: 'shell.execution.external_preprocessor',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'ripgrep --pre executes an external preprocessor before searching.',
      })
    }

    // Pipeline into shell interpreter or eval: e.g. curl ... | sh, base64 -d | bash
    if (seg.operatorBefore === '|' && (SHELL_INTERPRETERS.has(bin) || bin === 'eval' || bin === 'source')) {
      allSegmentsSafeReadonly = false
      const prevTokens = prevSeg ? stripLeadingEnvAssignments(tokenizeSegment(prevSeg.raw).tokens).argv : []
      const prevBin = prevTokens[0] ? normalizeBinaryName(prevTokens[0]) : ''
      if (prevBin === 'base64' || prevBin === 'xxd' || prevBin === 'openssl') {
        findings.push({
          ruleId: 'shell.obfuscation.encoded_pipe_to_shell',
          risk: 'blocked',
          segment: `${prevSeg?.raw ?? ''} | ${seg.raw}`.trim(),
          reason: `Piping decoded payload from '${prevBin}' into '${bin}' is blocked as an obfuscated execution vector.`,
        })
      } else if (DOWNLOAD_BINARIES.has(prevBin)) {
        findings.push({
          ruleId: 'shell.network.pipe_to_shell',
          risk: 'high_risk',
          segment: `${prevSeg?.raw ?? ''} | ${seg.raw}`.trim(),
          reason: `Piping remote network content from '${prevBin}' directly into '${bin}' requires explicit user approval.`,
        })
      } else {
        findings.push({
          ruleId: 'shell.execution.pipe_to_shell',
          risk: 'high_risk',
          segment: `${prevSeg?.raw ?? ''} | ${seg.raw}`.trim(),
          reason: `Piping standard output into shell interpreter '${bin}' requires explicit user approval.`,
        })
      }
    }

    // Direct `eval`
    if (bin === 'eval') {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.obfuscation.eval',
        risk: 'blocked',
        segment: seg.raw,
        reason: 'Dynamic `eval` execution in shell commands is prohibited; run explicit commands directly.',
      })
      continue
    }

    // System / disk destruction binaries
    if (
      bin === 'mkfs' ||
      bin.startsWith('mkfs.') ||
      bin === 'fdisk' ||
      bin === 'parted' ||
      bin === 'wipefs' ||
      bin === 'shred'
    ) {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.destructive.disk_format',
        risk: 'blocked',
        segment: seg.raw,
        reason: `Filesystem/disk formatting utility '${bin}' is blocked.`,
      })
      continue
    }

    if (bin === 'dd') {
      allSegmentsSafeReadonly = false
      const ofArg = args.find((a) => a.startsWith('of='))
      if (ofArg && /^of=\/dev\/(?:sd|nvme|vd|xvd|disk|mem|kmem)/i.test(ofArg)) {
        findings.push({
          ruleId: 'shell.destructive.dd_device',
          risk: 'blocked',
          segment: seg.raw,
          reason: `'dd' writing to raw device '${ofArg}' is blocked.`,
        })
      } else {
        findings.push({
          ruleId: 'shell.destructive.dd',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `'dd' low-level block copy requires explicit user approval.`,
        })
      }
      continue
    }

    if (bin === 'shutdown' || bin === 'reboot' || bin === 'poweroff' || bin === 'halt' || bin === 'init') {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.system.power',
        risk: 'blocked',
        segment: seg.raw,
        reason: `System power/init control command '${bin}' is blocked.`,
      })
      continue
    }

    // Name-based process killing or forceful kill
    if (bin === 'pkill' || bin === 'killall' || bin === 'skill') {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.process.mass_kill',
        risk: 'high_risk',
        segment: seg.raw,
        reason: `Name-based process termination ('${bin}') can kill shared services; target specific PIDs or approve explicitly.`,
      })
      continue
    }

    if (bin === 'kill') {
      allSegmentsSafeReadonly = false
      const hasMinusOne = args.includes('-1') || args.includes('0')
      if (hasMinusOne) {
        findings.push({
          ruleId: 'shell.process.kill_all_pids',
          risk: 'blocked',
          segment: seg.raw,
          reason: '`kill` targeting PID -1 or 0 terminates all user/group processes and is blocked.',
        })
      } else {
        findings.push({
          ruleId: 'shell.process.kill',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Process termination (`kill`) requires explicit user approval.',
        })
      }
      continue
    }

    // `rm` analysis
    if (bin === 'rm' || bin === 'rmdir') {
      allSegmentsSafeReadonly = false
      const hasRecursive = args.some(
        (a) =>
          a === '--recursive' ||
          (a.startsWith('-') && !a.startsWith('--') && /[rR]/.test(a)),
      )
      const hasForce = args.some(
        (a) =>
          a === '--force' ||
          (a.startsWith('-') && !a.startsWith('--') && /f/.test(a)),
      )
      const hasNoPreserveRoot = args.some((a) => a.startsWith('--no-preserve-root'))
      if (hasNoPreserveRoot) {
        findings.push({
          ruleId: 'shell.destructive.rm_root',
          risk: 'blocked',
          segment: seg.raw,
          reason: '`rm --no-preserve-root` is blocked.',
        })
        continue
      }
      const targets = args.filter((a) => !a.startsWith('-'))
      for (const target of targets) {
        const danger = isDangerousRmTarget(target)
        if (danger === 'root') {
          findings.push({
            ruleId: 'shell.destructive.rm_root',
            risk: 'blocked',
            segment: seg.raw,
            reason: `Deleting system root or OS directory '${target}' is blocked.`,
          })
        } else if (danger === 'wildcard_or_home' && hasRecursive) {
          findings.push({
            ruleId: 'shell.destructive.rm_home_or_wildcard',
            risk: 'high_risk',
            segment: seg.raw,
            reason: `Recursive deletion of home/wildcard target '${target}' requires explicit user approval.`,
          })
        }
      }
      if (hasRecursive || hasForce) {
        findings.push({
          ruleId: 'shell.destructive.rm_rf',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `Recursive or forced file deletion ('${seg.raw}') requires explicit user approval.`,
        })
      }
      continue
    }

    // `chmod` / `chown` analysis
    if (bin === 'chmod' || bin === 'chown' || bin === 'chgrp') {
      allSegmentsSafeReadonly = false
      const isWorldWritable = args.some((a) => a === '777' || a === '0777' || a === '666' || a === 'a+rwx' || a === 'o+w')
      const hasRecursive = args.includes('-R') || args.includes('--recursive')
      if (isWorldWritable || hasRecursive) {
        findings.push({
          ruleId: 'shell.permissions.broad_change',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `Broad or recursive permission/ownership change ('${seg.raw}') requires explicit user approval.`,
        })
      }
      continue
    }

    // `find` analysis (`-delete` or `-exec`)
    if (bin === 'find') {
      if (args.includes('-delete')) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.destructive.find_delete',
          risk: 'high_risk',
          segment: seg.raw,
          reason: '`find -delete` bulk deletion requires explicit user approval.',
        })
      }
      const execIdx = args.findIndex((a) => a === '-exec' || a === '-execdir')
      if (execIdx >= 0) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.execution.find_exec',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'find -exec may expand arguments or invoke a program not fully reconstructed by the parser.',
        })
        const subTokens = args.slice(execIdx + 1).filter((t) => t !== ';' && t !== '\\;' && t !== '+' && t !== '{}')
        if (subTokens.length > 0) {
          const subReport = analyzeShellCommand(subTokens.join(' '), depth + 1)
          for (const f of subReport.findings) findings.push(f)
        }
      }
      continue
    }

    // `xargs` analysis
    if (bin === 'xargs') {
      allSegmentsSafeReadonly = false
      findings.push({
        ruleId: 'shell.execution.xargs_dynamic',
        risk: 'high_risk',
        segment: seg.raw,
        reason: 'xargs constructs command arguments dynamically from standard input.',
      })
      let i = 0
      while (i < args.length && args[i]!.startsWith('-')) {
        const flag = args[i]!
        i += 1
        if ((flag === '-I' || flag === '-L' || flag === '-n' || flag === '-P' || flag === '-s' || flag === '-d') && i < args.length) {
          i += 1
        }
      }
      const subTokens = args.slice(i)
      if (subTokens.length > 0) {
        const subReport = analyzeShellCommand(subTokens.join(' '), depth + 1)
        for (const f of subReport.findings) findings.push(f)
      }
      continue
    }

    // `git` analysis
    if (bin === 'git') {
      if (args.some((arg) => arg === '-c' || arg.startsWith('--config-env'))) {
        findings.push({
          ruleId: 'shell.git.dynamic_config',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Git configuration overrides can install aliases, hooks, external diff commands, or pagers.',
        })
      }
      // Skip global git flags like -C <dir>, --no-pager, -c key=val
      let i = 0
      while (i < args.length && args[i]!.startsWith('-')) {
        const flag = args[i]!
        i += 1
        if ((flag === '-C' || flag === '-c' || flag === '--git-dir' || flag === '--work-tree') && i < args.length) {
          i += 1
        }
      }
      const sub = args[i]?.toLowerCase()
      const subArgs = args.slice(i + 1)
      if (!sub) continue
      if (subArgs.some((a) => a === '--ext-diff' || a.startsWith('--ext-diff=') ||
          /^--output=(?:\/|~|\.\.|\$)/.test(a))) {
        findings.push({
          ruleId: 'shell.git.external_or_escaped_output',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Git external diff or output outside the working directory can run code or write beyond the workspace.',
        })
      }
      if (!SAFE_GIT_SUBCOMMANDS.has(sub) && !KNOWN_GIT_MUTATIONS.has(sub) &&
          !INSPECTED_GIT_MUTATIONS.has(sub)) {
        findings.push({
          ruleId: 'shell.git.unknown_subcommand',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `Unrecognized git subcommand '${sub}' may resolve to an executable alias.`,
        })
      }

      if (sub === 'push') {
        allSegmentsSafeReadonly = false
        const isForce = subArgs.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'))
        const hasDelete = subArgs.some((a) => a === '--delete' || a === '-d' || a.startsWith(':'))
        if (isForce || hasDelete) {
          findings.push({
            ruleId: 'shell.git.force_push',
            risk: 'high_risk',
            segment: seg.raw,
            reason: 'Force-pushing or deleting remote refs with `git push` requires explicit user approval.',
          })
        } else {
          findings.push({
            ruleId: 'shell.git.push',
            risk: 'high_risk',
            segment: seg.raw,
            reason: 'Pushing commits to a remote repository (`git push`) requires explicit user approval.',
          })
        }
        continue
      }

      if (sub === 'reset' && subArgs.some((a) => a === '--hard' || a === '--merge')) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.git.reset_hard',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Destructive working-tree reset (`git reset --hard`) discards uncommitted work and requires explicit user approval.',
        })
        continue
      }

      if (sub === 'clean' && subArgs.some((a) => a.startsWith('-') && /f/.test(a))) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.git.clean_force',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Destructive untracked-file removal (`git clean -f`) requires explicit user approval.',
        })
        continue
      }

      if ((sub === 'checkout' || sub === 'restore') && (subArgs.includes('--') || subArgs.includes('.'))) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.git.discard_changes',
          risk: 'high_risk',
          segment: seg.raw,
          reason: `Discarding working-tree modifications with 'git ${sub}' requires explicit user approval.`,
        })
        continue
      }

      if (sub === 'branch' && subArgs.includes('-D')) {
        allSegmentsSafeReadonly = false
        findings.push({
          ruleId: 'shell.git.branch_force_delete',
          risk: 'high_risk',
          segment: seg.raw,
          reason: 'Force-deleting a branch (`git branch -D`) requires explicit user approval.',
        })
        continue
      }

      const isReadonlyGit =
        SAFE_GIT_SUBCOMMANDS.has(sub) &&
        !(sub === 'branch' && subArgs.some((a) => a === '-d' || a === '-D' || a === '-m' || a === '-M')) &&
        !(sub === 'tag' && subArgs.some((a) => a === '-d' || a === '-f' || a === '-a')) &&
        !(sub === 'remote' && subArgs.some((a) => a === 'add' || a === 'remove' || a === 'rm' || a === 'set-url' || a === 'rename')) &&
        !(sub === 'config' && !subArgs.some((a) => a === '--get' || a === '--list' || a === '-l')) &&
        !(sub === 'worktree' && subArgs.some((a) => a !== 'list'))

      if (!isReadonlyGit) {
        allSegmentsSafeReadonly = false
      }
      continue
    }

    // Check if the binary is in the strict read-only allowlist
    if (!SAFE_READONLY_BINARIES.has(bin) || wrappers.length > 0) {
      allSegmentsSafeReadonly = false
    } else if (bin === 'sed' && args.some((a) => a === '-i' || a.startsWith('-i'))) {
      allSegmentsSafeReadonly = false
    }
  }

  let risk: ShellSafetyRisk = allSegmentsSafeReadonly ? 'safe' : 'caution'
  for (const finding of findings) {
    risk = maxRisk(risk, finding.risk)
  }

  const requiresExplicitApproval = risk === 'high_risk' || risk === 'blocked'
  const summary =
    findings.length > 0
      ? findings.map((f) => `[${f.ruleId}] ${f.reason}`).join(' ')
      : undefined

  return {
    command,
    risk,
    requiresExplicitApproval,
    findings,
    ...(summary ? { summary } : {}),
  }
}

export function formatShellSafetyBlock(
  report: ShellSafetyReport,
  options?: { isSubAgent?: boolean },
): string {
  const headline =
    report.risk === 'blocked'
      ? 'Shell command blocked by AST safety policy'
      : options?.isSubAgent
        ? 'High-risk shell command blocked in headless sub-agent session (user approval required)'
        : 'High-risk shell command requires explicit user approval'
  const reasons = report.findings
    .filter((f) => f.risk === 'blocked' || f.risk === 'high_risk')
    .map((f) => `- [${f.ruleId}] (${f.risk}): ${f.reason} (segment: \`${f.segment}\`)`)
    .join('\n')
  const guidance =
    report.risk === 'blocked'
      ? 'Rewrite the command using explicit, non-obfuscated workspace-scoped operations.'
      : options?.isSubAgent
        ? 'Do not run destructive or force-push commands inside a headless sub-agent; report the required command back to the parent session so the user can approve it.'
        : 'Ask the user for confirmation or use a non-destructive alternative.'
  return `${headline}:\n${reasons || `- Command classified as ${report.risk}`}\nNext step: ${guidance}`
}
