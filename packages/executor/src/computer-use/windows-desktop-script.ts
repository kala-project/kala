import { WINDOWS_ACCESSIBILITY_SCRIPT } from './windows-accessibility-script.js'

// Fixed script only: requests arrive as JSON on stdin, never as PowerShell source.
// A service must launch this in the logged-in user's session (not Session 0).
const ENCODING = String.raw`
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
`
const BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class KalaDesktop {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
    public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
    public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] struct UNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT key;
  }
  // Sequential outer struct naturally aligns the union at 8 on x64 (INPUT size 40).
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WTSINFOEX_LEVEL1 {
    public uint SessionId;
    public int SessionState,SessionFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=33)] public string WinStationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=21)] public string UserName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=18)] public string DomainName;
    public long LogonTime,ConnectTime,DisconnectTime,LastInputTime,CurrentTime;
    public uint IncomingBytes,OutgoingBytes,IncomingFrames,OutgoingFrames,IncomingCompressedBytes,OutgoingCompressedBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct WTSINFOEX {
    public uint Level;
    public WTSINFOEX_LEVEL1 Data;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, uint length, out uint needed);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out uint bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  static bool dpiInitialized;
  static void Send(INPUT input) {
    if (SendInput(1, new INPUT[]{input}, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput failed; desktop may be locked or target elevated (UIPI).");
  }
  static void Send(INPUT[] input) {
    if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(INPUT))) != (uint)input.Length)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput batch failed; desktop may be locked or target elevated (UIPI).");
  }
  static void Key(ushort key, bool up) {
    bool extended=(key>=33 && key<=40) || key==45 || key==46 || key==91;
    Send(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wVk=key, dwFlags=(up?2u:0u)|(extended?1u:0u) } } });
  }
  static void Unicode(char value, bool up) {
    Send(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wScan=value, dwFlags=4u|(up?2u:0u) } } });
  }
  static void Mouse(uint flags, int x, int y, uint data) {
    Send(new INPUT { type=0, data=new UNION { mouse=new MOUSEINPUT { dx=x, dy=y, mouseData=data, dwFlags=flags } } });
  }
  public static int[] Bounds() {
    return new int[]{GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79)};
  }
  public static void Check() {
    int session=Process.GetCurrentProcess().SessionId;
    if(session==0) throw new Exception("Session 0 is non-interactive. Configure a logged-in user-session bridge; Windows services cannot control the user's desktop directly.");
    IntPtr buffer; uint bytes;
    if(!WTSQuerySessionInformation(IntPtr.Zero,session,25,out buffer,out bytes))
      throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot query interactive session.");
    try {
      if(bytes<Marshal.SizeOf(typeof(WTSINFOEX))) throw new Exception("Cannot verify the interactive session lock state.");
      var info=(WTSINFOEX)Marshal.PtrToStructure(buffer,typeof(WTSINFOEX));
      if(info.Level!=1 || info.Data.SessionId!=(uint)session) throw new Exception("Unexpected interactive session information.");
      if(info.Data.SessionState!=0) throw new Exception("User session is disconnected or inactive. Log in and unlock the desktop.");
      // WTSInfoEx detects a lock even when Windows keeps Default as the input desktop.
      if(info.Data.SessionFlags!=1) throw new Exception("User session is locked or its lock state is unknown. Unlock the logged-in desktop.");
    } finally { WTSFreeMemory(buffer); }
    IntPtr desktop=OpenInputDesktop(0,false,0x101);
    if(desktop==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Input desktop inaccessible or locked. Log in and unlock the desktop.");
    try {
      var name=new StringBuilder(256); uint needed;
      if(!GetUserObjectInformation(desktop,2,name,512,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
        throw new Exception("Secure, locked or non-default input desktop. Unlock the logged-in desktop.");
      name.Clear();
      if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,name,512,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
        throw new Exception("Process is not attached to the user's Default desktop. Configure a logged-in user-session bridge.");
    } finally { CloseDesktop(desktop); }
    if(!dpiInitialized) {
      bool aware;
      try { aware=SetProcessDpiAwarenessContext(new IntPtr(-4)); }
      catch(EntryPointNotFoundException) { aware=SetProcessDPIAware(); }
      if(!aware) throw new Exception("Cannot establish physical desktop DPI awareness.");
      dpiInitialized=true;
    }
    int[] b=Bounds();
    if(b[2]<=0 || b[3]<=0 || b[2]>32768 || b[3]>32768 || (long)b[2]*b[3]>64000000)
      throw new Exception("Interactive desktop dimensions exceed the capture limit.");
  }
  public static string Capture() {
    Check(); int[] b=Bounds();
    using(var bitmap=new Bitmap(b[2],b[3],PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap))
        graphics.CopyFromScreen(b[0],b[1],0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
      Check();
      using(var stream=new MemoryStream()) {
        bitmap.Save(stream,ImageFormat.Png);
        if(stream.Length>33554432) throw new Exception("Screenshot exceeds 32 MiB.");
        return Convert.ToBase64String(stream.ToArray());
      }
    }
  }
  static void Move(int x,int y) {
    int[] b=Bounds();
    if(x<b[0] || y<b[1] || x>=b[0]+b[2] || y>=b[1]+b[3]) throw new Exception("Coordinates outside the virtual desktop.");
    // Target the pixel's centre: edge-based normalization can land one pixel left/up.
    Mouse(0xC001,Math.Min(65535,(int)((x-b[0]+0.5)*65536.0/b[2])),Math.Min(65535,(int)((y-b[1]+0.5)*65536.0/b[3])),0);
  }
  static uint Button(string name,bool up) {
    if(name=="left") return up?4u:2u;
    if(name=="right") return up?16u:8u;
    if(name=="middle") return up?64u:32u;
    throw new Exception("Invalid mouse button.");
  }
  public static void Release(string[] buttons, ushort[] keys, string text) {
    Exception failure=null;
    foreach(var button in buttons) { try { Mouse(Button(button,true),0,0,0); } catch(Exception e) { failure=e; } }
    foreach(var key in keys) { try { Key(key,true); } catch(Exception e) { failure=e; } }
    foreach(char c in text) { try { Unicode(c,true); } catch(Exception e) { failure=e; } }
    if(failure!=null) throw failure;
  }
  public static void Act(string kind,int x,int y,string button,bool down,int count,int dx,int dy,int tx,int ty,string text,ushort[] keys) {
    Check();
    if(kind=="move") { Move(x,y); return; }
    if(kind=="button") { Move(x,y); Mouse(Button(button,!down),0,0,0); return; }
    if(kind=="scroll") {
      Move(x,y);
      if(dy!=0) Mouse(0x800,0,0,unchecked((uint)-dy));
      if(dx!=0) Mouse(0x1000,0,0,unchecked((uint)dx));
      return;
    }
    if(kind=="click" || kind=="drag") {
      Move(x,y); string held=kind=="drag"?"left":button;
      for(int i=0;i<(kind=="drag"?1:count);i++) {
        bool pressed=false;
        try {
          pressed=true; Mouse(Button(held,false),0,0,0);
          if(kind=="drag") {
            for(int step=1;step<=12;step++) {
              Move(x+(int)(((long)tx-x)*step/12),y+(int)(((long)ty-y)*step/12));
              System.Threading.Thread.Sleep(8);
            }
          }
        } finally { if(pressed) Mouse(Button(held,true),0,0,0); }
        if(i+1<count) System.Threading.Thread.Sleep(60);
      }
      return;
    }
    if(kind=="key") {
      var held=new List<ushort>();
      try { foreach(ushort key in keys) { held.Add(key); Key(key,false); } }
      finally { held.Reverse(); foreach(ushort key in held) Key(key,true); }
      return;
    }
    if(kind=="type") {
      var input=new List<INPUT>(text.Length*2);
      foreach(char c in text) {
        if(c=='\r' || c=='\n' || c=='\t') {
          ushort key=c=='\t'?(ushort)9:(ushort)13;
          input.Add(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wVk=key } } });
          input.Add(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wVk=key, dwFlags=2 } } });
        } else {
          input.Add(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wScan=c, dwFlags=4 } } });
          input.Add(new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { wScan=c, dwFlags=6 } } });
        }
      }
      bool complete=false;
      try { if(input.Count!=0) Send(input.ToArray()); complete=true; }
      finally {
        if(!complete) foreach(char c in text) {
          try {
            if(c=='\r' || c=='\n' || c=='\t') Key(c=='\t'?(ushort)9:(ushort)13,true);
            else Unicode(c,true);
          } catch {}
        }
      }
      return;
    }
    throw new Exception("Unknown desktop action.");
  }
}
'@ -ReferencedAssemblies System.Drawing, System
`
const DISPATCH = String.raw`
if ($r.operation -eq 'release') {
  $script:KalaRefs = @{}
  $script:KalaSnapshot = $null
  [KalaDesktop]::Release([string[]]$r.buttons, [System.UInt16[]]$r.keys, [string]$r.text)
  $result = @{ok=$true}
} elseif ($r.operation -eq 'status') {
  [KalaDesktop]::Check()
  $result = @{ok=$true; bounds=[KalaDesktop]::Bounds()}
} elseif ($r.operation -eq 'screenshot') {
  $image = [KalaDesktop]::Capture()
  $result = @{ok=$true; bounds=[KalaDesktop]::Bounds(); base64=$image}
} elseif ($r.operation -eq 'input') {
  $script:KalaRefs = @{}
  $script:KalaSnapshot = $null
  $a=$r.action
  [KalaDesktop]::Act([string]$a.type,[int]$a.x,[int]$a.y,[string]$a.button,[bool]$a.down,[int]$a.clickCount,[int]$a.deltaX,[int]$a.deltaY,[int]$a.toX,[int]$a.toY,[string]$a.text,[System.UInt16[]]$r.keys)
  $result = @{ok=$true}
} elseif ($r.operation -eq 'semantic') {
  $observation = Invoke-KalaSemantic $r.request
  $result = @{ok=$true; observation=$observation}
} else { throw 'Invalid desktop operation.' }
`

// Kept for native diagnostic/acceptance jobs. Production uses the warm worker.
export const WINDOWS_DESKTOP_SCRIPT = ENCODING + BOOTSTRAP + String.raw`
try {
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
` + DISPATCH + String.raw`
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Error.Write('Native desktop operation failed: ' + $_.Exception.Message)
  exit 1
}
`

export const WINDOWS_DESKTOP_WORKER_SCRIPT = BOOTSTRAP + WINDOWS_ACCESSIBILITY_SCRIPT + String.raw`
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $r = $null
  try {
    if ($line.Length -gt 32768) { throw 'Desktop request exceeded bounds.' }
    $r = $line | ConvertFrom-Json
` + DISPATCH + String.raw`
    $result.id = $r.id
  } catch {
    $result = @{id=$r.id; ok=$false; error=$_.Exception.Message}
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
}
`

// Set encoding before the first read; resetting Console.In afterwards can
// discard request bytes already buffered while reading the fixed bootstrap.
export const WINDOWS_DESKTOP_WORKER_COMMAND = ENCODING + String.raw`
& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))
`
