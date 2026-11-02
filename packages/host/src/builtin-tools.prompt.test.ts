import { describe, expect, it } from 'vitest'
import { createBuiltinAgentModule, DEFAULT_KALA_SYSTEM_PROMPT, resolveBuiltinAgentModule } from './builtin-tools.js'

const context = { mode: 'coding' as const, skills: [] }

describe('built-in assistant identity', () => {
  it('keeps LLM tools and prompts stable across desktop feature settings', () => {
    const enabled = resolveBuiltinAgentModule({ systemPrompt: 'My instructions.', computerUseEnabled: true })
    const disabled = resolveBuiltinAgentModule({ systemPrompt: 'My instructions.', computerUseEnabled: false })
    expect(disabled.systemPrompt).toBe('My instructions.')
    expect(disabled.tools).toEqual(enabled.tools)
    expect(disabled.systemPrompt).toBe(enabled.systemPrompt)
    expect(disabled.tools.some((tool) => tool.name === 'computer_use')).toBe(true)
    expect(disabled.tools.some((tool) => tool.name === 'shell')).toBe(true)
  })
  it('uses brand-neutral Kala metadata and identity', () => {
    const module = createBuiltinAgentModule()
    const prompt = module.systemPrompt.render(context)

    expect(module.id).toBe('coding-agent-kala')
    expect(module.label).toBe('Kala Prompt')
    expect(prompt).toContain('You are Kala, an AI coding agent')
    expect(prompt).not.toContain('You are Codex')
    expect(prompt).not.toContain('You are Claude Code')
  })

  it('asks the default prompt to avoid trivial delegation and hand off verified context', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('Do small lookups, single-file edits, and narrow tests yourself')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('verified facts and relevant files, remaining questions, edit scope, verification, and expected output')
  })

  it('teaches the default prompt Dashboard-previewable paths', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('[README.md](./README.md)')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('[app.tsx](./src/app.tsx:12)')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('current session working directory')
  })

  it('renders the complete selected slot prompt without changing tools', () => {
    const selected = resolveBuiltinAgentModule({ systemPrompt: 'My own instructions.' })
    const defaults = resolveBuiltinAgentModule()

    expect(selected.systemPrompt).toContain('My own instructions.')
    expect(selected.systemPrompt).toBe('My own instructions.')
    expect(selected.tools).toEqual(defaults.tools)
  })

  it('keeps authorization enforcement out of the prompt while retaining fixed tool boundaries', () => {
    const automatic = resolveBuiltinAgentModule()
    const manual = resolveBuiltinAgentModule({ desktopManualAuthorizationRequired: true })
    expect(manual.systemPrompt).toBe(automatic.systemPrompt)
    expect(manual.tools).toEqual(automatic.tools)
    expect(automatic.systemPrompt).not.toContain('The user must first enable local desktop sharing')
    const desktop = automatic.tools.find((tool) => tool.name === 'computer_use')
    expect(JSON.stringify(desktop)).toContain('a user pause')
    expect(JSON.stringify(desktop)).toContain('not blanket approval for external side effects')
  })

  it('distinguishes discussion from implementation and includes language guidance', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('For questions, explanations, reviews, or design discussions')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('For implementation tasks')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('Respond in the user’s current language')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).not.toMatch(/token budget|time budget/i)
  })
})
