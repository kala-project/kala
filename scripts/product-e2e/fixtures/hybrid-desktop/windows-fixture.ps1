param([Parameter(Mandatory=$true)][string]$Root, [switch]$AllowIsolatedDesktopTest)
$ErrorActionPreference = 'Stop'
if (-not $AllowIsolatedDesktopTest -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
  throw 'Explicit disposable interactive-desktop acknowledgement is required.'
}
$Root = [IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $Root -PathType Container) -or [IO.Path]::GetFileName($Root) -notlike 'kala-clean-hybrid-*') {
  throw 'Use an existing dedicated kala-clean-hybrid-* fixture directory.'
}
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
public static class KalaHybridFixture {
  public static void Run(string root) {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    var utf8 = new UTF8Encoding(false);
    using (var form = new Form {Text="Kala hybrid acceptance", Size=new Size(640,360), StartPosition=FormStartPosition.CenterScreen})
    using (var timer = new Timer {Interval=1200000}) {
      var entry = new TextBox {AccessibleName="Kala text", Location=new Point(24,24), Size=new Size(550,32)};
      var save = new Button {Text="Save semantic", Location=new Point(24,80), Size=new Size(200,40)};
      var disabled = new Button {Text="Disabled semantic", Enabled=false, Location=new Point(24,140), Size=new Size(200,40)};
      int count = 0;
      save.Click += (sender,args) => {
        count++;
        File.WriteAllText(Path.Combine(root,"saved.txt"),entry.Text,utf8);
        File.WriteAllText(Path.Combine(root,"count.txt"),count.ToString(),utf8);
      };
      form.Controls.AddRange(new Control[] {entry,save,disabled});
      timer.Tick += (sender,args) => form.Close();
      form.Shown += (sender,args) => {
        form.Activate();
        File.WriteAllText(Path.Combine(root,"ready"),"ready",utf8);
      };
      timer.Start();
      Application.Run(form);
    }
  }
}
'@
[KalaHybridFixture]::Run($Root)
