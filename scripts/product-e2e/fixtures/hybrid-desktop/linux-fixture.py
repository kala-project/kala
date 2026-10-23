"""Disposable desktop fixture. Requires the distribution's GTK3 introspection."""
import os
import pathlib
import sys
import gi

if os.environ.get("KALA_HYBRID_ISOLATED") != "1":
    raise RuntimeError("Explicit disposable-desktop acknowledgement is required")
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

root = pathlib.Path(sys.argv[1]).resolve()
if not root.is_dir() or not root.name.startswith("kala-clean-hybrid-"):
    raise RuntimeError("Use an existing dedicated kala-clean-hybrid-* fixture directory")
window = Gtk.Window(title="Kala hybrid acceptance")
window.set_default_size(640, 360)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
box.set_border_width(24)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Kala text")
box.pack_start(entry, False, False, 0)
save = Gtk.Button(label="Save semantic")
count = 0
def save_text(_button):
    global count
    count += 1
    (root / "saved.txt").write_text(entry.get_text(), encoding="utf-8")
    (root / "count.txt").write_text(str(count), encoding="ascii")
save.connect("clicked", save_text)
box.pack_start(save, False, False, 0)
disabled = Gtk.Button(label="Disabled semantic")
disabled.set_sensitive(False)
box.pack_start(disabled, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
window.present()
GLib.timeout_add_seconds(1200, Gtk.main_quit)
(root / "ready").write_text("ready", encoding="ascii")
Gtk.main()
