param(
    [string]$WorkspaceRoot = 'C:\KalaTest\workspace',
    [string]$WorkspaceName = 'kala-clean-windows',
    [string]$ManifestPath,
    [string]$GitPath
)
$ErrorActionPreference = 'Stop'
if ($env:GIT_INBOX_E2E_ISOLATED -ne '1') { throw 'Set GIT_INBOX_E2E_ISOLATED=1 only in the authorized disposable Windows VM.' }

if (-not $GitPath) {
    $command = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $command) { throw 'git_unavailable: git.exe is missing from this process PATH. No download or installation was attempted.' }
    $GitPath = $command.Source
}
if (-not (Test-Path -LiteralPath $GitPath -PathType Leaf)) { throw 'git_unavailable: the specified Git executable does not exist.' }
$root = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
if ($root -ne 'C:\KalaTest\workspace') { throw 'This fixture preparer is restricted to C:\KalaTest\workspace.' }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'The authorized workspace directory must already exist.' }
$fixture = Join-Path $root ('git-inbox-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$gitOptions = @('-c', 'user.name=Git Inbox Acceptance', '-c', 'user.email=acceptance@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false')
function Invoke-FixtureGit([string[]]$GitArguments) {
    $output = & $GitPath @gitOptions @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git command failed with exit code $LASTEXITCODE" }
    return ($output -join "`n").Trim()
}
Push-Location -LiteralPath $fixture
try {
    $version = Invoke-FixtureGit @('--version')
    Invoke-FixtureGit @('init', '-q', '-b', 'main') | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'original.txt'), "ROOT_ACCEPTANCE_CONTENT`n", $utf8)
    Invoke-FixtureGit @('add', 'original.txt') | Out-Null
    Invoke-FixtureGit @('commit', '-qm', 'Acceptance root commit', '-m', 'Root full message proof.') | Out-Null
    $rootHash = Invoke-FixtureGit @('rev-parse', 'HEAD')
    Invoke-FixtureGit @('mv', 'original.txt', 'renamed.txt') | Out-Null
    Invoke-FixtureGit @('commit', '-qm', 'Acceptance rename commit', '-m', 'Rename metadata proof.') | Out-Null
    $renameHash = Invoke-FixtureGit @('rev-parse', 'HEAD')
    [IO.File]::WriteAllText((Join-Path $fixture 'renamed.txt'), "ROOT_ACCEPTANCE_CONTENT`nMEANINGFUL_ADDED_LINE`n", $utf8)
    Invoke-FixtureGit @('add', 'renamed.txt') | Out-Null
    Invoke-FixtureGit @('commit', '-qm', 'Acceptance changed-content commit', '-m', 'Full author and per-file patch proof.') | Out-Null
    $changedHash = Invoke-FixtureGit @('rev-parse', 'HEAD')
    for ($index = 0; $index -lt 31; $index++) {
        Invoke-FixtureGit @('commit', '--allow-empty', '-qm', ('History page filler {0:d2}' -f $index)) | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $fixture 'will-disappear') | Out-Null
    $manifest = @{
        schemaVersion = 1
        platform = 'windows'
        workspaceName = $WorkspaceName
        fixture = $fixture
        gitVersion = $version
        gitPath = $GitPath
        preparedAt = [DateTime]::UtcNow.ToString('o')
        hashes = @{ root = $rootHash; rename = $renameHash; changed = $changedHash; head = (Invoke-FixtureGit @('rev-parse', 'HEAD')) }
    } | ConvertTo-Json -Depth 5
    if ($ManifestPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($ManifestPath), $manifest, $utf8) }
    $manifest
} finally {
    Pop-Location
}
