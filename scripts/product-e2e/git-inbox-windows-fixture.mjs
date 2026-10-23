import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const FIXTURE = /^git-inbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function validateWindowsFixture(value, workspaceRoot = 'C:\\KalaTest\\workspace') {
  assert(value?.schemaVersion === 1 && value.platform === 'windows', 'Expected a version-1 Windows fixture manifest.')
  assert(typeof value.fixture === 'string' && win32.isAbsolute(value.fixture), 'Expected an absolute Windows fixture path.')
  const fixture = win32.normalize(value.fixture)
  assert(!fixture.startsWith('\\\\') && !/['"\r\n]/u.test(fixture), 'UNC paths and script metacharacters are not accepted.')
  assert.equal(win32.dirname(fixture).toLowerCase(), win32.normalize(workspaceRoot).replace(/\\$/u, '').toLowerCase(), 'Fixture must be an immediate child of the explicitly authorized workspace.')
  assert(FIXTURE.test(win32.basename(fixture)), 'Fixture must have its own git-inbox UUID directory.')
  assert(typeof value.workspaceName === 'string' && value.workspaceName.length > 0, 'Workspace name is required.')
  for (const field of ['root', 'rename', 'changed', 'head']) assert(HASH.test(value.hashes?.[field] ?? ''), `Invalid ${field} commit hash.`)
  return { ...value, fixture }
}

export function windowsFixtureRemovalScript(manifest, workspaceRoot) {
  const { fixture } = validateWindowsFixture(manifest, workspaceRoot)
  return `$ErrorActionPreference = 'Stop'\n$path = '${fixture}\\will-disappear'\n$directory = Get-Item -LiteralPath $path -Force\nif (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular acceptance directory' }\nif (@(Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1).Count) { throw 'Acceptance directory must be empty' }\nRemove-Item -LiteralPath $path -Force -ErrorAction Stop\nif (Test-Path -LiteralPath $path) { throw 'Acceptance directory still exists' }\n'GIT_INBOX_FAILURE_DIRECTORY_REMOVED'\n`
}

/** Called only during an explicitly started Windows acceptance run, never during preparation. */
export async function removeWindowsFixtureDirectory({ workerRoot, manifest, workspaceRoot, timeoutMs = 15_000 }) {
  assert(typeof workerRoot === 'string' && workerRoot.length > 0, 'GIT_INBOX_E2E_WINDOWS_WORKER_ROOT is required for the authorized worker.')
  const script = windowsFixtureRemovalScript(manifest, workspaceRoot)
  const id = `gitinboxremove${randomUUID().replaceAll('-', '')}`
  const worker = join(workerRoot, 'windows-test')
  await writeFile(join(worker, 'jobs', `${id}.json`), JSON.stringify({ id, script }), { flag: 'wx', mode: 0o600 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result
    try { result = JSON.parse(await readFile(join(worker, 'results', `${id}.json`), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (result) {
      assert(result.ok === true && result.output?.includes('GIT_INBOX_FAILURE_DIRECTORY_REMOVED'), `Windows fixture-directory removal failed: ${String(result.output ?? '').slice(0, 2_000)}`)
      return { jobId: id, removed: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out awaiting this acceptance run's own directory-removal job ${id}. Do not start another run until the worker owner has checked it.`)
}
