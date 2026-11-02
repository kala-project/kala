import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { selectPortableInstallation } from './portable-installation.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('claims a previously nonexistent root, then reopens only the marked SQLite installation', () => {
  const parent = mkdtempSync(join(tmpdir(), 'kala-portable-fresh-'))
  roots.push(parent)
  const root = join(parent, 'state')
  expect(selectPortableInstallation(root, true)).toBe('sqlite')
  expect(selectPortableInstallation(root, false)).toBe('sqlite')
  expect(existsSync(join(root, 'portable-installation.json'))).toBe(true)
})

it('never switches an existing unmarked installation even when explicitly requested', () => {
  const parent = mkdtempSync(join(tmpdir(), 'kala-portable-legacy-'))
  roots.push(parent)
  const root = join(parent, 'state')
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const history = join(root, 'sessions', 'existing.jsonl')
  writeFileSync(history, '{"legacy":true}\n')
  expect(selectPortableInstallation(root, false)).toBe('legacy')
  expect(() => selectPortableInstallation(root, true)).toThrow('previously nonexistent state root')
  expect(readFileSync(history, 'utf8')).toBe('{"legacy":true}\n')
  expect(existsSync(join(root, 'portable-installation.json'))).toBe(false)
})

it('fails closed on unrecognized markers', () => {
  const parent = mkdtempSync(join(tmpdir(), 'kala-portable-marker-'))
  roots.push(parent)
  writeFileSync(join(parent, 'portable-installation.json'), '{"schemaVersion":2,"authority":"sqlite"}')
  expect(() => selectPortableInstallation(parent, false)).toThrow('Unrecognized Portable installation marker')
})
