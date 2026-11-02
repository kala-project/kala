import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachedExecutor } from '@agent-kernel/shared'

import { i18n } from '../../../i18n/index.js'
import { McpSection } from './McpSection.js'

const executors: AttachedExecutor[] = [{
  executorId: 'exec-1',
  workspaceId: 'workspace/a',
  workspaceName: 'Primary workspace',
  tools: ['bash'],
  runtime: 'node',
  runtimeVersion: 'v22.22.2',
  clientVersion: '1.0.0',
  executorVersion: '1.0.0',
  hostname: 'executor-host',
}]

const supportedSettings = {
  supported: true,
  workspaceId: 'workspace/a',
  servers: [{ name: 'filesystem' }],
}

describe('McpSection', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(async () => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads a workspace configuration and replaces it with structured arguments', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(supportedSettings), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        supported: true,
        workspaceId: 'workspace/a',
        servers: [{ name: 'github' }],
      }), { status: 200 }))

    render(<McpSection executors={executors} />)

    expect(await screen.findByDisplayValue('filesystem')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/settings/mcp?workspaceId=workspace%2Fa', expect.objectContaining({ cache: 'no-store' }))
    expect(screen.getByTestId('settings-mcp-warning').textContent).toContain('executes third-party code')
    expect((screen.getByLabelText('Server 1 arguments') as HTMLTextAreaElement).value).toBe('[]')
    expect((screen.getByLabelText('Server 1 command') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/saved commands and arguments are not sent back/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Server 1 name'), { target: { value: 'github' } })
    fireEvent.change(screen.getByLabelText('Server 1 command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText('Server 1 arguments'), { target: { value: '["server.js", "--read-only"]' } })
    fireEvent.click(screen.getByLabelText(/I understand that saving executes these commands/))
    fireEvent.click(screen.getByTestId('settings-mcp-save'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith('/settings/mcp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace/a',
        servers: [{ name: 'github', command: 'node', args: ['server.js', '--read-only'] }],
      }),
    })
    expect(await screen.findByText('MCP server configuration saved and started.')).toBeTruthy()
  })

  it.each([
    { status: 401, error: 'operator_authentication_required', title: 'Administrator sign-in required', detail: 'This Dashboard session is not authenticated to manage MCP.' },
    { status: 403, error: 'admin_required', title: 'Permission denied', detail: 'Your account does not have permission' },
    { status: 409, error: 'workspace_offline', title: 'Workspace unavailable or unmanaged', detail: 'workspace Executor is offline' },
    { status: 409, error: 'unmanaged_executor', title: 'Workspace unavailable or unmanaged', detail: 'no authenticated Executor available' },
    { status: 502, error: 'mcp_status_unavailable', title: 'MCP request failed', detail: 'Executor did not respond' },
    { status: 500, error: 'internal_service_error', title: 'MCP request failed', detail: 'MCP service could not complete' },
  ])('shows the specific $status load failure without an editor', async ({ status, error, title, detail }) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status }))

    render(<McpSection executors={executors} />)

    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.getByText(new RegExp(detail))).toBeTruthy()
    expect(screen.queryByText(error)).toBeNull()
    if (status === 401) expect(screen.getByText(/configure MCP on the Executor machine/)).toBeTruthy()
    expect(screen.queryByTestId('settings-mcp-save')).toBeNull()
    expect(screen.queryByText('MCP server configuration saved and started.')).toBeNull()
  })

  it('keeps the editor and reports a rejected save without claiming success', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(supportedSettings), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This executor is unmanaged.' }), { status: 409 }))

    render(<McpSection executors={executors} />)
    await screen.findByDisplayValue('filesystem')
    fireEvent.change(screen.getByLabelText('Server 1 command'), { target: { value: 'npx' } })
    fireEvent.click(screen.getByLabelText(/I understand that saving executes these commands/))
    fireEvent.click(screen.getByTestId('settings-mcp-save'))

    expect(await screen.findByText('Workspace unavailable or unmanaged')).toBeTruthy()
    expect(screen.getByText(/cannot be managed from Dashboard right now/)).toBeTruthy()
    expect(screen.getByDisplayValue('filesystem')).toBeTruthy()
    expect(screen.queryByText('MCP server configuration saved and started.')).toBeNull()
  })

  it('removes the editor when a save is rejected for missing authentication', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(supportedSettings), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'operator_authentication_required' }), { status: 401 }))

    render(<McpSection executors={executors} />)
    await screen.findByDisplayValue('filesystem')
    fireEvent.change(screen.getByLabelText('Server 1 command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByLabelText(/I understand that saving executes these commands/))
    fireEvent.click(screen.getByTestId('settings-mcp-save'))

    expect(await screen.findByText('Administrator sign-in required')).toBeTruthy()
    expect(screen.getByText(/configure MCP on the Executor machine/)).toBeTruthy()
    expect(screen.queryByTestId('settings-mcp-save')).toBeNull()
    expect(screen.queryByDisplayValue('node')).toBeNull()
  })

  it('distinguishes unsupported and absent online workspaces', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      supported: false,
      note: 'Executor version does not include MCP support.',
      workspaceId: 'workspace/a',
      servers: [],
    }), { status: 200 }))

    const view = render(<McpSection executors={executors} />)
    expect(await screen.findByText('MCP is not supported for this workspace')).toBeTruthy()
    expect(screen.getByText('Executor version does not include MCP support.')).toBeTruthy()
    expect(screen.queryByTestId('settings-mcp-save')).toBeNull()

    view.unmount()
    fetchMock.mockClear()
    render(<McpSection executors={[]} />)
    expect(screen.getByText(/No online workspace is available/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects shell-like argument text unless it is a JSON string array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(supportedSettings), { status: 200 }))
    render(<McpSection executors={executors} />)
    await screen.findByDisplayValue('filesystem')

    fireEvent.change(screen.getByLabelText('Server 1 command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText('Server 1 arguments'), { target: { value: '--flag value' } })
    fireEvent.click(screen.getByLabelText(/I understand that saving executes these commands/))
    fireEvent.click(screen.getByTestId('settings-mcp-save'))

    expect(await screen.findByText(/must be a valid JSON array containing only strings/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
