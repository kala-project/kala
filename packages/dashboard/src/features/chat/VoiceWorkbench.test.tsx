import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { useVoiceRecorder } from '../voice/useVoiceRecorder.js'
import { VoiceWorkbench } from './VoiceWorkbench.js'

type Voice = ReturnType<typeof useVoiceRecorder>
function voice(overrides: Partial<Voice> = {}): Voice {
  return {
    phase: 'listening',
    configuration: { configured: true, enabled: true, provider: 'azure', mode: 'realtime', realtimeMaxMinutes: 15, afterRecordingMaxMinutes: 15 },
    finalTranscript: 'Recognized speech.',
    interimTranscript: ' Current words',
    elapsedSeconds: 18,
    levels: [0, 0.2, 0.6, 0.4],
    secureContext: true,
    start: vi.fn(async () => {}), stop: vi.fn(async () => 'Recognized speech.'),
    cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), dismissError: vi.fn(),
    prepare: vi.fn(async () => {}), refreshConfiguration: vi.fn(async () => null),
    ...overrides,
  } as Voice
}

function show(recording: Voice, draft = { text: '', caret: 0 }, onStopAndSend = vi.fn(async () => {})) {
  const onCompact = vi.fn()
  const view = render(<VoiceWorkbench voice={recording} draft={draft} onCompact={onCompact} onStopAndSend={onStopAndSend} />)
  return { ...view, onCompact, onStopAndSend }
}

describe('VoiceWorkbench', () => {
  it('shows one recording state, preserves transcript contrast and never displays an empty draft or needless return button', () => {
    const recording = voice()
    const { onCompact } = show(recording)
    expect(screen.getByTestId('voice-workbench').getAttribute('role')).toBe('dialog')
    expect(screen.getByTestId('voice-workbench').textContent).toContain('Live')
    expect(screen.getByTestId('voice-workbench-transcript').textContent).toContain('Current words')
    expect(screen.queryByTestId('voice-workbench-draft')).toBeNull()
    expect(screen.queryByTestId('voice-workbench-return-latest')).toBeNull()
    expect(screen.getByTestId('voice-workbench').textContent).toContain('00:18')
    expect(screen.getByTestId('voice-workbench').textContent).not.toContain('15:00')
    const waveform = screen.getByTestId('composer-voice-waveform')
    expect(waveform.className).toContain('flex-1')
    expect(waveform.querySelector('polyline')).toBeTruthy()
    expect(waveform.querySelector('path')).toBeTruthy()
    fireEvent.click(screen.getByTestId('voice-workbench-minimize'))
    expect(onCompact).toHaveBeenCalledOnce()
    expect(recording.cancel).not.toHaveBeenCalled()
    expect(recording.stop).not.toHaveBeenCalled()
  })

  it('distinguishes cancel, stop to edit and send, without triggering another speech service', async () => {
    const recording = voice()
    const send = vi.fn(async () => {})
    const { rerender } = show(recording, { text: 'Earlier draft', caret: 13 }, send)
    expect(screen.getByTestId('voice-workbench-draft').textContent).toContain('Earlier draft')
    fireEvent.click(screen.getByTestId('voice-workbench-stop'))
    fireEvent.click(screen.getByTestId('voice-workbench-send'))
    expect(recording.stop).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    rerender(<VoiceWorkbench voice={recording} draft={{ text: 'Earlier draft', caret: 13 }} onCompact={() => {}} onStopAndSend={send} />)
    fireEvent.click(screen.getByTestId('voice-workbench-cancel'))
    await waitFor(() => expect(recording.cancel).toHaveBeenCalledOnce())
  })

  it('allows accessible mobile handle activation and ignores short or canceled drags', () => {
    const { onCompact } = show(voice())
    const handle = screen.getByTestId('voice-workbench-drag-handle')
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 })
    expect(onCompact).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 100 })
    fireEvent.pointerCancel(handle, { pointerId: 2 })
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 220 })
    expect(onCompact).not.toHaveBeenCalled()
    fireEvent.click(handle)
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('warns only near the configured limit in the recording status without displaying that limit', () => {
    const recording = voice({ elapsedSeconds: 869 })
    const { rerender } = show(recording)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<VoiceWorkbench voice={{ ...recording, elapsedSeconds: 870 }} draft={{ text: '', caret: 0 }} onCompact={() => {}} onStopAndSend={async () => {}} />)
    expect(screen.getByRole('alert').textContent).toContain('almost out of time')
    expect(screen.getByTestId('voice-workbench').textContent).toContain('14:30')
    expect(screen.getByTestId('voice-workbench').textContent).not.toContain('15:00')
  })

  it('does not imply live transcription in after-recording mode and retains the configured duration', () => {
    const recording = voice({
      configuration: { configured: true, enabled: true, provider: 'azure', mode: 'after_recording', afterRecordingMaxMinutes: 37, realtimeMaxMinutes: 15 },
    })
    show(recording, { text: '   ', caret: 3 })
    expect(screen.getByTestId('voice-workbench-transcript').textContent).toContain('after recording stops')
    expect(screen.getByTestId('voice-workbench-transcript').textContent).not.toContain('Recognized speech')
    expect(screen.queryByTestId('voice-workbench-draft')).toBeNull()
    expect(screen.getByTestId('voice-workbench').textContent).toContain('00:18')
    expect(screen.getByTestId('voice-workbench').textContent).not.toContain('37:00')
  })

  it('shows the latest shortcut only after the user scrolls away from overflowing text', () => {
    show(voice())
    const transcript = screen.getByTestId('voice-workbench-transcript').querySelector('[data-radix-scroll-area-viewport]') as HTMLDivElement
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    transcript.scrollTop = 0
    fireEvent.scroll(transcript)
    expect(screen.getByTestId('voice-workbench-return-latest')).toBeTruthy()
    transcript.scrollTop = 800
    fireEvent.scroll(transcript)
    expect(screen.queryByTestId('voice-workbench-return-latest')).toBeNull()
  })
})
