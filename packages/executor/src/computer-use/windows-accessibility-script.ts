export const WINDOWS_ACCESSIBILITY_SCRIPT = String.raw`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Native IDs can arrive before the managed control-type registry is initialized.
[void][System.Windows.Automation.ControlType]::Button
$script:KalaRefs = @{}
$script:KalaSnapshot = $null
$script:KalaUIA = $null
$script:KalaPatterns = @{
  invoke = @('IUIAutomationInvokePattern',10000,30031)
  setValue = @('IUIAutomationValuePattern',10002,30043)
  toggle = @('IUIAutomationTogglePattern',10015,30041)
  select = @('IUIAutomationSelectionItemPattern',10010,30036)
}
function Initialize-KalaAccessibility {
  if ($null -ne $script:KalaUIA) { return }
  # Import the inbox native UIA typelib in memory, without a downloaded interop DLL.
  Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public class KalaNativeAutomation : ITypeLibImporterNotifySink {
  static Assembly interop;
  [DllImport("oleaut32.dll",CharSet=CharSet.Unicode)]
  static extern int LoadTypeLibEx(string path,int kind,out ITypeLib library);
  static Assembly Import() {
    ITypeLib library;
    Marshal.ThrowExceptionForHR(LoadTypeLibEx(Environment.SystemDirectory+"\\UIAutomationCore.dll",2,out library));
    try {
      return new TypeLibConverter().ConvertTypeLibToAssembly(library,"KalaNativeUIA.dll",TypeLibImporterFlags.None,new KalaNativeAutomation(),null,null,"KalaNativeUIA",null);
    } finally { Marshal.ReleaseComObject(library); }
  }
  public static object Create() {
    if (interop == null) interop = Import();
    return Activator.CreateInstance(interop.GetType("KalaNativeUIA.CUIAutomationClass",true));
  }
  public static object Call(object target,string contract,string method,object[] arguments) {
    var member = interop.GetType("KalaNativeUIA."+contract,true).GetMethod(method);
    if (member == null) throw new MissingMethodException(contract,method);
    return member.Invoke(target,arguments);
  }
  public static object Get(object target,string contract,string property) {
    var member = interop.GetType("KalaNativeUIA."+contract,true).GetProperty(property);
    if (member == null) throw new MissingMemberException(contract,property);
    return member.GetValue(target,null);
  }
  public void ReportEvent(ImporterEventKind kind,int code,string message) {
    if (kind != ImporterEventKind.NOTIF_TYPECONVERTED) throw new InvalidOperationException("Cannot import native UIA: "+message);
  }
  public Assembly ResolveRef(object library) { throw new NotSupportedException("Unexpected native UIA type-library dependency"); }
}
'@
  $client = [KalaNativeAutomation]::Create()
  $walker = [KalaNativeAutomation]::Get($client,'IUIAutomation','ControlViewWalker')
  $script:KalaUIA = $client
  $script:KalaWalker = $walker
}
function Get-KalaProperty($element,[int]$id) {
  return [KalaNativeAutomation]::Call($element,'IUIAutomationElement','GetCurrentPropertyValue',@($id))
}
function Get-KalaState($element) {
  $roleId = [int](Get-KalaProperty $element 30003)
  $role = [System.Windows.Automation.ControlType]::LookupById($roleId)
  return @{
    Name=[string](Get-KalaProperty $element 30005)
    Role=$(if ($null -ne $role) { $role.ProgrammaticName } else { 'ControlType.' + $roleId })
    IsEnabled=[bool](Get-KalaProperty $element 30010)
    IsOffscreen=[bool](Get-KalaProperty $element 30022)
    IsPassword=[bool](Get-KalaProperty $element 30019)
  }
}
function Get-KalaRuntime($element) {
  return ([KalaNativeAutomation]::Call($element,'IUIAutomationElement','GetRuntimeId',@()) -join ',')
}
function Get-KalaWindow {
  [KalaDesktop]::Check()
  Initialize-KalaAccessibility
  $handle = [KalaDesktop]::Foreground()
  if ($handle -eq [IntPtr]::Zero) { throw 'No foreground application. Focus a window or use a screenshot.' }
  return [KalaNativeAutomation]::Call($script:KalaUIA,'IUIAutomation','ElementFromHandle',@($handle))
}
function Get-KalaPattern($element,[string]$kind) {
  $definition = $script:KalaPatterns[$kind]
  if ([bool](Get-KalaProperty $element $definition[2])) {
    return [KalaNativeAutomation]::Call($element,'IUIAutomationElement','GetCurrentPattern',@([int]$definition[1]))
  }
  return $null
}
function Get-KalaObservation([string]$query = '') {
  $script:KalaRefs = @{}
  $root = Get-KalaWindow
  $script:KalaWindow = [KalaDesktop]::Foreground()
  $script:KalaSnapshot = [Guid]::NewGuid().ToString()
  $script:KalaExpires = [DateTime]::UtcNow.AddSeconds(30)
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue($root)
  $elements = New-Object System.Collections.ArrayList
  $visited = 0
  $omitted = $false
  while ($queue.Count -gt 0 -and $elements.Count -lt 64 -and $visited -lt 512) {
    $element = $queue.Dequeue()
    $visited++
    $child = [KalaNativeAutomation]::Call($script:KalaWalker,'IUIAutomationTreeWalker','GetFirstChildElement',@($element))
    while ($null -ne $child -and ($visited + $queue.Count) -lt 512) {
      $queue.Enqueue($child)
      $child = [KalaNativeAutomation]::Call($script:KalaWalker,'IUIAutomationTreeWalker','GetNextSiblingElement',@($child))
    }
    if ($null -ne $child) { $omitted = $true }
    $state = Get-KalaState $element
    if ($state.IsOffscreen) { continue }
    $actions = New-Object System.Collections.ArrayList
    foreach ($kind in @('invoke', 'setValue', 'toggle', 'select')) {
      $pattern = Get-KalaPattern $element $kind
      if ($null -ne $pattern -and -not ($kind -eq 'setValue' -and ($state.IsPassword -or [bool][KalaNativeAutomation]::Get($pattern,'IUIAutomationValuePattern','CurrentIsReadOnly')))) {
        [void]$actions.Add($kind)
      }
    }
    if (-not $state.Name -and $actions.Count -eq 0) { continue }
    if ($query -and ([string]$state.Name).IndexOf($query,[StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $ref = 'e' + ($elements.Count + 1)
    $script:KalaRefs[$ref] = @{element=$element; name=$state.Name; role=$state.Role; actions=$actions; runtime=(Get-KalaRuntime $element)}
    $name = [string]$state.Name
    [void]$elements.Add(@{ref=$ref; role=$state.Role; name=$name.Substring(0,[Math]::Min(160,$name.Length)); enabled=$state.IsEnabled; actions=@($actions.ToArray())})
  }
  $title = [string](Get-KalaProperty $root 30005)
  return @{backend='desktop'; snapshotId=$script:KalaSnapshot; targetId=$script:KalaWindow.ToInt64().ToString(); title=$title.Substring(0,[Math]::Min(160,$title.Length)); elements=@($elements.ToArray()); truncated=($queue.Count -gt 0 -or $omitted)}
}
function Invoke-KalaSemantic($request) {
  if ($request.operation -eq 'observe') { return Get-KalaObservation ([string]$request.query) }
  [KalaDesktop]::Check()
  if ($request.snapshotId -ne $script:KalaSnapshot -or [DateTime]::UtcNow -ge $script:KalaExpires -or [KalaDesktop]::Foreground() -ne $script:KalaWindow) {
    throw 'Stale desktop refs. Observe the foreground window again.'
  }
  for ($i=0; $i -lt $request.actions.Count; $i++) {
    try {
      [KalaDesktop]::Check()
      if ([KalaDesktop]::Foreground() -ne $script:KalaWindow -or [DateTime]::UtcNow -ge $script:KalaExpires) { throw 'Foreground window changed or refs expired. Observe again.' }
      $action = $request.actions[$i]
      $saved = $script:KalaRefs[[string]$action.ref]
      if ($null -eq $saved -or -not $saved.actions.Contains([string]$action.action)) { throw 'Unknown ref or unsupported semantic action.' }
      $element = $saved.element
      $state = Get-KalaState $element
      if (-not $state.IsEnabled -or $state.IsOffscreen -or $state.Name -ne $saved.name -or $state.Role -ne $saved.role -or (Get-KalaRuntime $element) -ne $saved.runtime) {
        throw 'Desktop control changed or is unavailable.'
      }
      $pattern = Get-KalaPattern $element ([string]$action.action)
      if ($null -eq $pattern) { throw 'Control pattern is no longer available.' }
      switch ($action.action) {
        'invoke' { [void][KalaNativeAutomation]::Call($pattern,'IUIAutomationInvokePattern','Invoke',@()) }
        'setValue' {
          if ($state.IsPassword -or [bool][KalaNativeAutomation]::Get($pattern,'IUIAutomationValuePattern','CurrentIsReadOnly')) { throw 'Protected or read-only control.' }
          [void][KalaNativeAutomation]::Call($pattern,'IUIAutomationValuePattern','SetValue',@([string]$action.value))
        }
        'toggle' { [void][KalaNativeAutomation]::Call($pattern,'IUIAutomationTogglePattern','Toggle',@()) }
        'select' { [void][KalaNativeAutomation]::Call($pattern,'IUIAutomationSelectionItemPattern','Select',@()) }
      }
    } catch {
      $script:KalaRefs = @{}
      $script:KalaSnapshot = $null
      throw ('Desktop batch stopped at action ' + ($i+1) + '; ' + ($request.actions.Count-$i-1) + ' later actions skipped. ' + $_.Exception.Message)
    }
  }
  return Get-KalaObservation
}
`
