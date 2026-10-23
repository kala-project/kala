import { describe, expect, it } from 'vitest'

import type { Message, ToolSchema } from '@agent-kernel/kernel'
import { COMPUTER_SCREENSHOT_KIND } from '@agent-kernel/shared'

import { buildAnthropicRequestBody, buildOpenAIRequestBody } from './provider-request-builder.js'

const READ_TOOL: ToolSchema = {
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  requiresApproval: false,
}

const EDIT_TOOL: ToolSchema = {
  name: 'edit',
  description: 'edit a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } } },
  requiresApproval: true,
}

describe('provider request builder', () => {
  it('converts desktop observations to actual images after all parallel OpenAI tool results', async () => {
    const screenshot = { mimeType: 'image/png', base64: 'AA==', width: 1280, height: 800, originX: -1280, originY: 0 }
    const content = JSON.stringify({ kind: COMPUTER_SCREENSHOT_KIND, screenshot })
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_call', callId: 'desktop', name: 'computer_use', input: { operation: 'screenshot' } }, { type: 'tool_call', callId: 'read', name: 'read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'desktop', ok: true, content }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'read', ok: true, content: 'file' }] },
    ]
    const result = await buildOpenAIRequestBody({ messages, tools: [] }, 'test', undefined)
    expect(result.body.messages).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      { role: 'tool', tool_call_id: 'desktop', content: expect.stringContaining('origin (-1280, 0)') },
      { role: 'tool', tool_call_id: 'read', content: 'file' },
      { role: 'user', content: [{ type: 'text', text: expect.stringContaining('untrusted') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    ])
    const anthropic = await buildAnthropicRequestBody({ messages, tools: [] }, 'test', undefined, false)
    expect(anthropic.body.messages).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'desktop', is_error: false, content: [{ type: 'text', text: expect.stringContaining('1280x800') }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', is_error: false, content: 'file' }] },
    ])
  })

  it('does not let unrelated tool text masquerade as an authorized desktop image', async () => {
    const content = JSON.stringify({ kind: COMPUTER_SCREENSHOT_KIND, screenshot: { mimeType: 'image/png', base64: 'AA==', width: 1, height: 1, originX: 0, originY: 0 } })
    const messages: Message[] = [{ role: 'tool', content: [{ type: 'tool_result', callId: 'untrusted', ok: true, content }] }]
    const result = await buildOpenAIRequestBody({ messages, tools: [] }, 'test', undefined)
    expect(result.body.messages).toEqual([{ role: 'tool', tool_call_id: 'untrusted', content }])
  })
  it('omits provider output limits unless explicitly configured', async () => {
    const params = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'write a large file' }] }], tools: [] }

    const openai = await buildOpenAIRequestBody(params, 'gpt-test', undefined)
    const anthropic = await buildAnthropicRequestBody(params, 'claude-test', undefined, true)

    expect(openai.body.max_tokens).toBeUndefined()
    expect(openai.omittedDefaults).toContain('max_tokens')
    expect(anthropic.body.max_tokens).toBeUndefined()
    expect(anthropic.omittedDefaults).toContain('max_tokens')
  })

  it('passes explicit output limits without inventing defaults', async () => {
    const params = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'short' }] }], tools: [] }

    const openai = await buildOpenAIRequestBody(params, 'gpt-test', 32000)
    const anthropic = await buildAnthropicRequestBody(params, 'claude-test', 32000, true)

    expect(openai.body.max_tokens).toBe(32000)
    expect(openai.omittedDefaults).not.toContain('max_tokens')
    expect(anthropic.body.max_tokens).toBe(32000)
    expect(anthropic.omittedDefaults).not.toContain('max_tokens')
  })

  it('maps assistant tool calls and tool results to OpenAI chat completions shape', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read readme' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_call', callId: 'call_1', name: 'read', input: { path: 'README.md' } }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'call_1', ok: true, content: '# hi' }] },
    ]

    const plan = await buildOpenAIRequestBody({ messages, tools: [READ_TOOL] }, 'gpt-test', undefined)

    expect(plan.body.messages).toEqual([
      { role: 'user', content: 'read readme' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '# hi' },
    ])
    expect(plan.body.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'read a file', parameters: READ_TOOL.inputSchema } }])
    expect(plan.body.tool_choice).toBe('auto')
  })

  it('maps Anthropic system, cache breakpoints, tools, and thinking budget', async () => {
    const plan = await buildAnthropicRequestBody({
      systemPrompt: 'be exact',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
      tools: [READ_TOOL, EDIT_TOOL],
      thinkingBudget: 4096,
    }, 'claude-test', undefined, true)

    expect(plan.body.system).toEqual([{ type: 'text', text: 'be exact', cache_control: { type: 'ephemeral' } }])
    expect(plan.body.tools).toEqual([
      { name: 'read', description: 'read a file', input_schema: READ_TOOL.inputSchema },
      { name: 'edit', description: 'edit a file', input_schema: EDIT_TOOL.inputSchema, cache_control: { type: 'ephemeral' } },
    ])
    expect(plan.body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    expect((plan.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.cache_control).toBeUndefined()
    expect((plan.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('omits Anthropic cache_control when cache is disabled', async () => {
    const plan = await buildAnthropicRequestBody({
      systemPrompt: 'plain',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [READ_TOOL],
    }, 'claude-test', undefined, false)

    expect(plan.body.system).toBe('plain')
    expect((plan.body.tools as Array<Record<string, unknown>>)[0]!.cache_control).toBeUndefined()
    expect((plan.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.cache_control).toBeUndefined()
  })

  it('converts text file attachments into bounded provider text blocks', async () => {
    const attachment = {
      type: 'file' as const,
      name: 'settings.json',
      mediaType: 'application/json',
      data: Buffer.from('{"enabled":true}').toString('base64'),
    }
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'review' }, attachment] }]

    const openai = await buildOpenAIRequestBody({ messages, tools: [] }, 'gpt-test', undefined)
    const anthropic = await buildAnthropicRequestBody({ messages, tools: [] }, 'claude-test', undefined, false)

    expect(openai.body.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'review' },
        { type: 'text', text: expect.stringContaining('{"enabled":true}') },
      ],
    })
    expect(anthropic.body.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'review' },
        { type: 'text', text: expect.stringContaining('settings.json') },
      ],
    })
  })

  it('rejects binary file attachments on the Kernel provider path', async () => {
    const messages: Message[] = [{
      role: 'user',
      content: [{
        type: 'file',
        name: 'archive.zip',
        mediaType: 'application/zip',
        data: 'UEsDBA==',
      }],
    }]

    await expect(buildOpenAIRequestBody({ messages, tools: [] }, 'gpt-test', undefined))
      .rejects.toThrow('cannot send binary attachment')
  })
})
