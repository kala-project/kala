param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$ExpectedComputerName,
  [switch]$AllowIsolatedDesktopTest,
  [int]$LifetimeSeconds=1200
)
$ErrorActionPreference='Stop'
if (-not $AllowIsolatedDesktopTest -or $env:OS -ne 'Windows_NT' -or $env:COMPUTERNAME -ine $ExpectedComputerName) { throw 'Explicit isolated Windows target confirmation is required.' }
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'The GUI fixture requires the logged-in user session, never Session 0.' }
if ($LifetimeSeconds -lt 30 -or $LifetimeSeconds -gt 1800) { throw 'Fixture lifetime must be 30..1800 seconds.' }
$Root=[IO.Path]::GetFullPath($Root)
$marker=Get-Content -LiteralPath (Join-Path $Root '.kala-desktop-acceptance.json') -Raw|ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($marker.purpose -cne 'kala-isolated-desktop-v1' -or $marker.computer -ine $ExpectedComputerName -or $marker.ownerSid -cne $sid) { throw 'Private isolated fixture marker does not match this user and machine.' }
$acl=Get-Acl -LiteralPath $Root
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid) { throw 'Fixture root must belong to the logged-in user.' }
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -cne $sid -and $rule.IdentityReference.Value -cne 'S-1-5-18') { throw 'Fixture evidence must be private to this user and SYSTEM.' }
}
$groups=(& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh)-join "`n"
$integrity=[Text.RegularExpressions.Regex]::Match($groups,'S-1-16-\d+').Value
if ($integrity -cne 'S-1-16-8192') { throw 'Launch the fixture with a Limited / Interactive task, not an elevated token.' }
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public static class KalaIsolatedDesktopFixture {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static readonly Encoding Utf8=new UTF8Encoding(false);
  static readonly StringBuilder pending=new StringBuilder();
  static string root;
  static long generation;
  static void Write(string suffix,string text) { File.WriteAllText(Path.Combine(root,"cu-win-native."+suffix),text,Utf8); }
  static void Log(string text) { pending.Append(++generation).Append(' ').Append(text).Append("\r\n"); }
  static void Flush() {
    if(pending.Length==0) return;
    File.AppendAllText(Path.Combine(root,"cu-win-native.events"),pending.ToString(),Utf8);
    pending.Clear();
  }
  static bool Down(int key) { return (GetAsyncKeyState(key)&0x8000)!=0; }
  static string State() {
    string buttons="",mods="",keys="";
    if(Down(1)) buttons+="Left,";
    if(Down(2)) buttons+="Right,";
    if(Down(4)) buttons+="Middle,";
    if(Down(16)) mods+="Shift,";
    if(Down(17)) mods+="Control,";
    if(Down(18)) mods+="Alt,";
    if(Down(91)||Down(92)) mods+="Win,";
    if(Down(13)) keys+="Enter,";
    if(Down(27)) keys+="Escape,";
    if(Down(65)) keys+="A,";
    if(Down(66)) keys+="B,";
    return "buttons="+(buttons.Length==0?"None":buttons.TrimEnd(','))+
      " modifiers="+(mods.Length==0?"None":mods.TrimEnd(','))+
      " keys="+(keys.Length==0?"None":keys.TrimEnd(','))+" generation="+generation;
  }
  sealed class Surface:Control {
    public Surface() {
      SetStyle(ControlStyles.StandardClick|ControlStyles.StandardDoubleClick|ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer,true);
      TabStop=true; BackColor=Color.White; Font=new Font("Segoe UI",12);
    }
    protected override void OnPaint(PaintEventArgs e) {
      base.OnPaint(e);
      e.Graphics.DrawString("Physical mouse / drag / vertical and horizontal wheel target",Font,Brushes.Black,8,8);
      e.Graphics.DrawRectangle(Pens.DarkBlue,1,1,Width-3,Height-3);
    }
    protected override void OnMouseDown(MouseEventArgs e) { Focus(); Log("mouse-down "+e.Button+" clicks="+e.Clicks+" x="+e.X+" y="+e.Y); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { Log("mouse-up "+e.Button+" x="+e.X+" y="+e.Y); base.OnMouseUp(e); }
    protected override void OnMouseDoubleClick(MouseEventArgs e) { Log("mouse-double "+e.Button+" clicks="+e.Clicks); base.OnMouseDoubleClick(e); }
    protected override void OnMouseMove(MouseEventArgs e) { Log("mouse-move buttons="+Control.MouseButtons+" x="+e.X+" y="+e.Y); base.OnMouseMove(e); }
    protected override void OnMouseWheel(MouseEventArgs e) { Log("wheel vertical delta="+e.Delta); base.OnMouseWheel(e); }
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x020E) Log("wheel horizontal delta="+(short)((m.WParam.ToInt64()>>16)&0xffff));
      base.WndProc(ref m);
    }
    protected override bool IsInputKey(Keys key) { return key==Keys.Enter || key==Keys.Escape || base.IsInputKey(key); }
  }
  public static void Run(string output,int lifetime,string integrity) {
    root=output;
    try {
      SetProcessDpiAwarenessContext(new IntPtr(-4));
      if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("Cannot establish physical-pixel coordinates.");
    } catch(EntryPointNotFoundException) {
      if(!SetProcessDPIAware()) throw new Exception("Cannot establish DPI awareness.");
    }
    if(Screen.PrimaryScreen.Bounds.Width<940 || Screen.PrimaryScreen.Bounds.Height<700) throw new Exception("Set the isolated display to at least 940x700.");
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    using(var form=new Form()) {
      form.Text="KALA-COMPUTER-ACCEPTANCE"; form.StartPosition=FormStartPosition.Manual;
      form.FormBorderStyle=FormBorderStyle.None; form.AutoScaleMode=AutoScaleMode.None;
      form.Location=new Point(20,20); form.ClientSize=new Size(900,650);
      form.BackColor=Color.FromArgb(230,238,248); form.TopMost=true; form.KeyPreview=true;
      var label=new Label { Text="KALA - genuine isolated Windows desktop acceptance",Location=new Point(20,16),AutoSize=true,Font=new Font("Segoe UI",14) };
      var text=new TextBox { Name="ExactUnicode",Location=new Point(40,90),Size=new Size(800,160),Multiline=true,AcceptsReturn=true,AcceptsTab=true,ScrollBars=ScrollBars.Vertical,Font=new Font("Segoe UI",14) };
      var surface=new Surface { Location=new Point(40,320),Size=new Size(800,260) };
      var close=new Button { Text="Close fixture",Location=new Point(740,600),Size=new Size(120,32) };
      close.Click+=(s,e)=>form.Close();
      form.Controls.Add(label); form.Controls.Add(text); form.Controls.Add(surface); form.Controls.Add(close);
      var textTimer=new Timer { Interval=40 };
      text.MouseDown+=(s,e)=>Log("text-pointer-down "+e.Button+" focused="+text.Focused);
      text.MouseUp+=(s,e)=>Log("text-pointer-up "+e.Button+" focused="+text.Focused);
      text.Enter+=(s,e)=>Log("text-focus-enter"); text.Leave+=(s,e)=>Log("text-focus-leave");
      text.TextChanged+=(s,e)=>{ textTimer.Stop(); textTimer.Start(); };
      textTimer.Tick+=(s,e)=>{ textTimer.Stop(); Write("text",text.Text); Log("text-changed units="+text.Text.Length); };
      form.KeyDown+=(s,e)=>{
        Log("key-down "+e.KeyCode+" modifiers="+e.Modifiers);
        if(e.KeyCode==Keys.Enter) { Write("enter","Enter"); e.SuppressKeyPress=true; }
        if(e.KeyCode==Keys.Escape) { Write("escape","Escape"); e.SuppressKeyPress=true; }
      };
      form.KeyUp+=(s,e)=>Log("key-up "+e.KeyCode+" modifiers="+e.Modifiers);
      var stateTimer=new Timer { Interval=80 };
      stateTimer.Tick+=(s,e)=>{ Write("state",State()); Flush(); };
      var lifetimeTimer=new Timer { Interval=lifetime*1000 };
      lifetimeTimer.Tick+=(s,e)=>form.Close();
      form.Shown+=(s,e)=>{
        var p=text.PointToScreen(new Point(40,30)); var q=surface.PointToScreen(new Point(190,90));
        Write("ready","ready session="+Process.GetCurrentProcess().SessionId+" pid="+Process.GetCurrentProcess().Id+
          " textX="+p.X+" textY="+p.Y+" pointerX="+q.X+" pointerY="+q.Y+" units=UTF-16 integritySid="+integrity);
        Write("text",""); Write("state",State()); stateTimer.Start(); lifetimeTimer.Start(); text.Focus(); form.Activate();
      };
      form.FormClosed+=(s,e)=>{ textTimer.Stop(); stateTimer.Stop(); lifetimeTimer.Stop(); Flush(); Write("closed","closed "+State()); };
      Application.Run(form);
      textTimer.Dispose(); stateTimer.Dispose(); lifetimeTimer.Dispose();
    }
  }
}
'@
[KalaIsolatedDesktopFixture]::Run($Root,$LifetimeSeconds,$integrity)
