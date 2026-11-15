import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { DEDICATED_DEPLOYMENT } from '@agent-kernel/shared'
import { HooksSection } from './HooksSection.js'

it('shows loaded source metadata without exposing command-bearing legacy fields or a Web save action', () => {
  const payload = {
    providers: [], defaultModel: '', hooks: [{ event: 'session_start', command: 'secret-bearing-command-must-not-render' }],
    hooksSummary: { sourceRef: 'mounted-unit-hooks-manifest', loadState: 'loaded', events: ['session_start'],
      loadedAt: '2026-01-01T00:00:00.000Z', version: '7', applyMode: 'restart' },
    deployment: { product: 'dedicated', deployment: DEDICATED_DEPLOYMENT, capabilities: {} },
    paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '/private/operator/hooks.toml', sessionsDir: '' },
    mcp: { supported: false, note: '' },
  } as ServerSettingsPayload
  const view = render(<HooksSection payload={payload} />)
  expect(screen.getByText('session_start')).toBeTruthy()
  expect(view.container.textContent).not.toContain('secret-bearing-command-must-not-render')
  expect(view.container.textContent).not.toContain('/private/operator/hooks.toml')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
})
