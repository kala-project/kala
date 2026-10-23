import { constants } from 'node:fs'
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { runDesktopCommand, type DesktopCommandRunner } from './desktop-driver.js'
import { COMPANION_TOKEN } from './companion-protocol.js'

export type CompanionConfig = { version: 1; platform: 'linux' | 'win32'; endpoint: string; token: string }
export type CompanionSecurityOptions = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: DesktopCommandRunner }

export function companionLoopbackPort(endpoint: string): number {
  const match = /^tcp:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint)
  const port = match && match[0] === endpoint ? Number(match[1]) : 0
  if (port < 1 || port > 65535) throw new Error('Invalid local companion endpoint: expected tcp://127.0.0.1:<port>')
  return port
}

// Token bytes never pass through PowerShell. Paths are data on stdin, not source.
export const COMPANION_WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $dir=[System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath([string]$r.path))
  if($r.operation -eq 'prepare' -and -not [System.IO.Directory]::Exists($dir)) {
    $missing=New-Object 'System.Collections.Generic.List[string]'
    $ancestor=$dir
    while(-not [System.IO.Directory]::Exists($ancestor)) {
      $missing.Add($ancestor)
      $parent=[System.IO.Directory]::GetParent($ancestor)
      if($null -eq $parent) { throw 'Companion directory requires an existing local volume.' }
      $ancestor=$parent.FullName
    }
    $cursor=Get-Item -LiteralPath $ancestor -Force
    while($null -ne $cursor) {
      if(($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Companion paths must not use reparse points.' }
      $cursor=$cursor.Parent
    }
    $acl=New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($current,$system)) {
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
    for($i=$missing.Count-1;$i -ge 0;$i--) { [void][System.IO.Directory]::CreateDirectory($missing[$i],$acl) }
  }
  $cursor=Get-Item -LiteralPath $dir -Force
  while($null -ne $cursor) {
    if(($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Companion paths must not use reparse points.' }
    $cursor=$cursor.Parent
  }
  $acl=Get-Acl -LiteralPath $dir
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if($r.operation -eq 'prepare' -and $owner.Value -ne $current.Value) { throw 'Companion directory must belong to the logged-in user.' }
  if($owner.Value -eq $system.Value -or -not $acl.AreAccessRulesProtected) { throw 'Companion directory must be a protected per-user directory.' }
  $paths=@($dir)
  if($r.operation -eq 'validate') { $paths+=([string]$r.path) }
  foreach($path in $paths) {
    $item=Get-Item -LiteralPath $path -Force
    if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Companion config must not be a reparse point.' }
    $security=Get-Acl -LiteralPath $path
    if($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Companion configuration owner mismatch.' }
    $seenUser=$false; $seenSystem=$false
    foreach($rule in $security.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      $sid=$rule.IdentityReference.Value
      if(($sid -ne $owner.Value -and $sid -ne $system.Value) -or $rule.AccessControlType -ne 'Allow') { throw 'Companion ACL may grant access only to its user SID and SYSTEM.' }
      if(($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Companion ACL requires user and SYSTEM full control.' }
      if($sid -eq $owner.Value) { $seenUser=$true }
      if($sid -eq $system.Value) { $seenSystem=$true }
    }
    if(-not $seenUser -or -not $seenSystem) { throw 'Companion ACL must include its user SID and SYSTEM.' }
  }
  [Console]::Out.Write('{"ok":true}')
} catch { [Console]::Error.Write('Private companion ACL validation failed: '+$_.Exception.Message); exit 1 }
`

function platformOf(options: CompanionSecurityOptions): 'linux' | 'win32' {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux' && platform !== 'win32') throw new Error('Desktop companion supports only Linux X11 and Windows')
  return platform
}

async function windowsAcl(path: string, operation: 'prepare' | 'validate', options: CompanionSecurityOptions) {
  const env = options.env ?? process.env
  const root = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows'
  const result = await (options.run ?? runDesktopCommand)(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(COMPANION_WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64'),
  ], { env, timeoutMs: 15_000, maxOutputBytes: 4096, stdin: JSON.stringify({ path, operation }) })
  if (result.toString('utf8').replace(/^\uFEFF/, '') !== '{"ok":true}') throw new Error('Private companion ACL validation failed')
}

async function privateLinuxDirectory(path: string) {
  const directory = await lstat(dirname(path))
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error('Companion config requires a user-owned private directory (0700), without symlinks')
  }
  let cursor = dirname(dirname(path))
  let sharedWritable = false
  while (true) {
    const ancestor = await lstat(cursor)
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || (ancestor.uid !== 0 && ancestor.uid !== process.getuid?.())) throw new Error('Companion directory ancestors must be trusted directories without symlinks')
    if ((ancestor.mode & 0o022) !== 0) sharedWritable = true
    // A private parent blocks other users from reaching writable descendants.
    else if (ancestor.uid === process.getuid?.() && (ancestor.mode & 0o077) === 0) sharedWritable = false
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (sharedWritable) throw new Error('Companion directory ancestors must not be writable by other users')
}

export async function prepareCompanionDirectory(path: string, options: CompanionSecurityOptions = {}): Promise<string> {
  const absolute = resolve(path)
  if (platformOf(options) === 'win32') await windowsAcl(absolute, 'prepare', options)
  else {
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await privateLinuxDirectory(absolute)
  }
  return absolute
}

export function validateCompanionConfig(value: unknown, path: string, platform: 'linux' | 'win32'): CompanionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid companion config')
  const config = value as Record<string, unknown>
  if (Object.keys(config).sort().join(',') !== 'endpoint,platform,token,version' || config.version !== 1 || config.platform !== platform
      || typeof config.token !== 'string' || !COMPANION_TOKEN.test(config.token) || typeof config.endpoint !== 'string') throw new Error('Invalid companion config')
  if (platform === 'win32') {
    companionLoopbackPort(config.endpoint)
  } else if (!isAbsolute(config.endpoint) || dirname(config.endpoint) !== dirname(path)
      || !/^\.kala-[0-9a-f]{32}\.sock$/.test(config.endpoint.slice(config.endpoint.lastIndexOf('/') + 1))
      || Buffer.byteLength(config.endpoint) > 103) throw new Error('Invalid local companion socket path (must fit 103 bytes)')
  return config as CompanionConfig
}

export async function readCompanionConfig(path: string, options: CompanionSecurityOptions = {}): Promise<CompanionConfig> {
  const absolute = resolve(path), platform = platformOf(options)
  if (platform === 'win32') await windowsAcl(absolute, 'validate', options)
  else await privateLinuxDirectory(absolute)
  const before = await lstat(absolute)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error('Companion config must be a private regular file, at most 4096 bytes')
  const handle = await open(absolute, constants.O_RDONLY | (platform === 'linux' ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 4096 || info.nlink !== 1 || info.ino !== before.ino || info.dev !== before.dev
        || (platform === 'linux' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) throw new Error('Companion config must be a private owner-only regular file (0600)')
    const bytes = Buffer.alloc(4097)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > 4096) throw new Error('Companion config exceeds safety limit')
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) } catch { throw new Error('Invalid companion config JSON') }
    return validateCompanionConfig(value, absolute, platform)
  } finally { await handle.close() }
}

export async function writeCompanionConfig(path: string, config: CompanionConfig, options: CompanionSecurityOptions = {}): Promise<() => Promise<void>> {
  const platform = platformOf(options)
  validateCompanionConfig(config, path, platform)
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (platform === 'linux' ? constants.O_NOFOLLOW : 0), 0o600)
  const info = await handle.stat()
  const cleanup = async () => {
    try {
      const current = await lstat(path)
      if (current.ino === info.ino && current.dev === info.dev && !current.isSymbolicLink()) await unlink(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  try {
    await handle.writeFile(JSON.stringify(config), 'utf8')
    await handle.sync()
    await handle.close()
    if (platform === 'win32') await windowsAcl(path, 'validate', options)
    return cleanup
  } catch (error) {
    await handle.close().catch(() => {})
    await cleanup()
    throw error
  }
}

export function companionEndpoint(path: string, random: string): string {
  return join(dirname(path), `.kala-${random}.sock`)
}
