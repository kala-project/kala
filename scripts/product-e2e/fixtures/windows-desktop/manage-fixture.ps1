# Isolated VM only. Start/verify/stop with the SAME private Root and explicitly pinned computer name.
# Example: .\manage-fixture.ps1 -Action start -Root "$env:LOCALAPPDATA\KalaDesktopAcceptance\run1" -ExpectedComputerName TESTVM -AllowIsolatedDesktopTest
param(
  [Parameter(Mandatory=$true)][ValidateSet('start','verify','stop','clean')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$ExpectedComputerName,
  [switch]$AllowIsolatedDesktopTest,
  [ValidateRange(30,1800)][int]$LifetimeSeconds=1200
)
$ErrorActionPreference='Stop'
if (-not $AllowIsolatedDesktopTest -or $env:OS -ne 'Windows_NT' -or $env:COMPUTERNAME -ine $ExpectedComputerName) { throw 'Explicit isolated Windows target confirmation is required.' }
$Root=[IO.Path]::GetFullPath($Root)
if ($Root -eq [IO.Path]::GetPathRoot($Root) -or $Root.Contains('"')) { throw 'Use a dedicated private evidence directory, never a drive root.' }
for ($p=$Root; $p; $p=[IO.Path]::GetDirectoryName($p)) {
  if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Evidence directory ancestry must not contain reparse points.' }
  if ($p -eq [IO.Path]::GetPathRoot($p)) { break }
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$markerPath=Join-Path $Root '.kala-desktop-acceptance.json'
$readyPath=Join-Path $Root 'cu-win-native.ready'
$taskPath=Join-Path $Root 'cu-win-native.fixture-task'
$fixture=Join-Path $PSScriptRoot 'gui-fixture.ps1'
if (-not (Test-Path -LiteralPath $Root)) {
  if ($Action -ne 'start') { throw 'Create the private fixture with -Action start first.' }
  [void][IO.Directory]::CreateDirectory($Root)
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  foreach($principal in @($sid,$system)) {
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Root -AclObject $acl
  $marker=@{purpose='kala-isolated-desktop-v1';computer=$ExpectedComputerName;ownerSid=$sid.Value}
  [IO.File]::WriteAllText($markerPath,($marker|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
}
$acl=Get-Acl -LiteralPath $Root
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) { throw 'Evidence directory must belong to this logged-in user.' }
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -cne $sid.Value -and $rule.IdentityReference.Value -cne $system.Value) { throw 'Evidence directory is not private to this user and SYSTEM.' }
}
$marker=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json
if ($marker.purpose -cne 'kala-isolated-desktop-v1' -or $marker.computer -ine $ExpectedComputerName -or $marker.ownerSid -cne $sid.Value) { throw 'Refusing an unrecognized evidence directory.' }
function Stop-OwnedFixture {
  if (Test-Path -LiteralPath $readyPath) {
    $value=[IO.File]::ReadAllText($readyPath)
    if ($value -match 'pid=(\d+)') {
      $id=[int]$Matches[1]
      $p=Get-Process -Id $id -ErrorAction SilentlyContinue
      $details=Get-CimInstance Win32_Process -Filter ("ProcessId="+$id) -ErrorAction SilentlyContinue
      if ($p) {
        if ($p.ProcessName -ne 'powershell' -or $p.SessionId -eq 0 -or -not $details.CommandLine.Contains($fixture) -or -not $details.CommandLine.Contains($Root)) { throw 'Refusing to stop a PID not belonging to this exact fixture and evidence directory.' }
        if (-not $p.CloseMainWindow()) { Stop-Process -Id $id -Force }
        elseif (-not $p.WaitForExit(5000)) { Stop-Process -Id $id -Force }
      }
    }
  }
  if (Test-Path -LiteralPath $taskPath) {
    $task=[IO.File]::ReadAllText($taskPath)
    if ($task -notmatch '^KalaDesktopFixture-[0-9a-f]{32}$') { throw 'Unrecognized fixture task name.' }
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  }
}
if ($Action -eq 'start') {
  if (Test-Path -LiteralPath $readyPath) {
    $value=[IO.File]::ReadAllText($readyPath)
    if ($value -match 'pid=(\d+)' -and (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue)) { throw 'Stop the prior fixture explicitly before starting another.' }
  }
  Get-ChildItem -LiteralPath $Root -Filter 'cu-win-native.*' -File|Remove-Item -Force
  $task='KalaDesktopFixture-'+[Guid]::NewGuid().ToString('N')
  $arguments="-NoLogo -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File `"$fixture`" -Root `"$Root`" -ExpectedComputerName `"$ExpectedComputerName`" -AllowIsolatedDesktopTest -LifetimeSeconds $LifetimeSeconds"
  $actionObject=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($LifetimeSeconds+30))
  Register-ScheduledTask -TaskName $task -Action $actionObject -Principal $principal -Settings $settings|Out-Null
  [IO.File]::WriteAllText($taskPath,$task)
  try {
    Start-ScheduledTask -TaskName $task
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while (-not(Test-Path -LiteralPath $readyPath)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Medium-token fixture readiness exceeded 30 seconds.' }
      Start-Sleep -Milliseconds 100
    }
    $ready=[IO.File]::ReadAllText($readyPath)
    if ($ready -notmatch 'integritySid=S-1-16-8192\b') { throw 'Fixture did not prove Medium integrity.' }
    @{ready=$ready;root=$Root;task=$task}|ConvertTo-Json -Compress
  } catch { Stop-OwnedFixture; throw }
} elseif ($Action -eq 'verify') {
  $events=[IO.File]::ReadAllText((Join-Path $Root 'cu-win-native.events'))
  $text=[IO.File]::ReadAllText((Join-Path $Root 'cu-win-native.text'))
  $expected=('Ab9-'+[char]0x4E2D+[char]0x00E9+[char]0x6587+[char]::ConvertFromUtf32(0x1F600)+'|')*51+[char]0x754C+'Z'
  $state=[IO.File]::ReadAllText((Join-Path $Root 'cu-win-native.state'))
  $required=@('key-down Escape','mouse-double Left','mouse-down Right','mouse-up Right','mouse-down Middle','mouse-up Middle','wheel vertical delta=-120','wheel vertical delta=120','wheel horizontal delta=120','wheel horizontal delta=-120','mouse-move buttons=Left','key-up ControlKey','key-up ShiftKey','key-down B')
  $missing=@($required|Where-Object {-not $events.Contains($_)})
  if (-not ($events.Contains('key-down Enter') -or $events.Contains('key-down Return'))) { $missing+='key-down Enter/Return' }
  $counts=@{}
  foreach($button in @('Left','Right','Middle')) {
    $down=[regex]::Matches($events,"mouse-down $button ").Count
    $up=[regex]::Matches($events,"mouse-up $button ").Count
    $counts[$button]=@{down=$down;up=$up;balanced=($down -eq $up -and $down -gt 0)}
  }
  $result=@{exactUnicode=($text -ceq $expected);utf16Units=$text.Length;state=$state;missing=$missing;buttons=$counts;ready=[IO.File]::ReadAllText($readyPath)}
  $result.ok=$result.exactUnicode -and $missing.Count -eq 0 -and $state.Contains('buttons=None modifiers=None keys=None') -and @($counts.Values|Where-Object {-not $_.balanced}).Count -eq 0
  $result|ConvertTo-Json -Depth 6 -Compress
  if (-not $result.ok) { throw 'Genuine physical GUI verification failed.' }
} else {
  Stop-OwnedFixture
  if ($Action -eq 'clean') {
    $bridgeDirectory=Join-Path $Root 'desktop-companion'
    if (Test-Path -LiteralPath $bridgeDirectory) {
      if (@(Get-ChildItem -LiteralPath $bridgeDirectory -Force).Count) { throw 'Companion files still exist; close the test companion before cleanup.' }
      Remove-Item -LiteralPath $bridgeDirectory
    }
    $entries=Get-ChildItem -LiteralPath $Root -Force
    foreach($entry in $entries) {
      if ($entry.PSIsContainer -or ($entry.Name -ne '.kala-desktop-acceptance.json' -and -not $entry.Name.StartsWith('cu-win-native.'))) { throw 'Unrecognized evidence remains; refusing recursive cleanup.' }
    }
    $entries|Remove-Item -Force
    Remove-Item -LiteralPath $Root
  }
}
