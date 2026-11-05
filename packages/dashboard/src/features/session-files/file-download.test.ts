import { describe, expect, it } from 'vitest'

import { downloadFilename, fileResultDownloadBlob } from './file-download.js'

describe('session file download helpers', () => {
  it('converts downloadable file results into blobs', async () => {
    const text = fileResultDownloadBlob({ requestId: 'r1', workspaceId: 'w1', path: '/repo/a.txt', kind: 'text', content: 'hello', size: 5 })
    expect(text?.blob.size).toBe(5)
    expect(text?.blob.type).toBe('text/plain;charset=utf-8')

    const binary = fileResultDownloadBlob({ requestId: 'r1', workspaceId: 'w1', path: '/repo/a.bin', kind: 'binary', content: 'AAE=', encoding: 'base64', mediaType: 'application/octet-stream', size: 2 })
    expect(binary?.blob.size).toBe(2)
    expect(binary?.blob.type).toBe('application/octet-stream')
  })

  it('does not download truncated views as complete files', () => {
    expect(fileResultDownloadBlob({ requestId: 'r1', workspaceId: 'w1', path: '/repo/a.txt', kind: 'text', content: 'partial', size: 100, truncated: true })).toBeUndefined()
    expect(fileResultDownloadBlob({ requestId: 'r1', workspaceId: 'w1', path: '/repo/a.png', kind: 'image', content: 'AAE=', mediaType: 'image/png', size: 100, truncated: true })).toBeUndefined()
    expect(fileResultDownloadBlob({ requestId: 'r1', workspaceId: 'w1', path: '/repo/a.bin', kind: 'binary', content: 'AAE=', mediaType: 'application/octet-stream', size: 100, truncated: true })).toBeUndefined()
  })

  it('does not save a short cached preview when the file size claims a full ZIP', () => {
    expect(fileResultDownloadBlob({
      kind: 'binary', content: 'UEsDBA==', mediaType: 'application/zip',
      size: 50 * 1024 * 1024,
    })).toBeUndefined()
    expect(fileResultDownloadBlob({ kind: 'text', content: 'abc', size: 10 })).toBeUndefined()
  })

  it('derives a filename without leaking parent path components', () => {
    expect(downloadFilename('/repo/archive.tar.gz')).toBe('archive.tar.gz')
    expect(downloadFilename('C:\\repo\\notes.txt')).toBe('notes.txt')
    expect(downloadFilename('/')).toBe('download')
  })
})
