// Uses only the distribution's AT-SPI bindings; never downloads Python packages.
export const LINUX_ACCESSIBILITY_SCRIPT = String.raw`
import json, sys, time, uuid
try:
    import pyatspi
except ImportError:
    sys.stderr.write("Desktop semantics require the OS-vendor python3-pyatspi package in the logged-in desktop session.")
    sys.exit(1)
refs = {}
snapshot = None
root = None
expires = 0
def active_window():
    desktop = pyatspi.Registry.getDesktop(0)
    desktop.clearCache()
    candidates = []
    for app_index in range(min(desktop.childCount, 128)):
        app = desktop.getChildAtIndex(app_index)
        app.clearCache()
        for window_index in range(min(app.childCount, 128)):
            window = app.getChildAtIndex(window_index)
            window.clearCache()
            state = window.getState()
            # Window managers can expose an ACTIVE decoration with no controls.
            if state.contains(pyatspi.STATE_ACTIVE) and state.contains(pyatspi.STATE_SHOWING) and window.childCount:
                candidates.append(window)
    if len(candidates) != 1:
        raise RuntimeError("No unambiguous active accessible application window. Focus an application or use a screenshot.")
    return candidates[0]
def actions(node):
    result = []
    interfaces = pyatspi.listInterfaces(node)
    if "EditableText" in interfaces and node.getRole() != pyatspi.ROLE_PASSWORD_TEXT:
        result.append("setValue")
    if "Action" in interfaces and node.queryAction().nActions:
        result.append("invoke")
    if node.parent and "Selection" in pyatspi.listInterfaces(node.parent):
        result.append("select")
    return result
def observe(query=None):
    global refs, snapshot, root, expires
    refs = {}
    root = active_window()
    snapshot = str(uuid.uuid4())
    expires = time.monotonic() + 30
    queue = [root]
    elements = []
    visited = 0
    omitted = False
    while queue and len(elements) < 64 and visited < 512:
        node = queue.pop(0)
        node.clearCache()
        visited += 1
        state = node.getState()
        if state.contains(pyatspi.STATE_DEFUNCT):
            continue
        remaining = max(0, 512 - visited - len(queue))
        if node.childCount > remaining:
            omitted = True
        for i in range(min(node.childCount, remaining)):
            queue.append(node.getChildAtIndex(i))
        if not state.contains(pyatspi.STATE_SHOWING):
            continue
        supported = actions(node)
        name = node.name or ""
        if not name and not supported:
            continue
        if query and query.casefold() not in name.casefold():
            continue
        ref = "e" + str(len(elements) + 1)
        role = node.getRoleName()
        refs[ref] = (node, name, role, supported)
        elements.append(dict(ref=ref, role=role[:80], name=name[:160],
            enabled=state.contains(pyatspi.STATE_ENABLED), actions=supported))
    return dict(backend="desktop", snapshotId=snapshot, targetId="active-window",
        title=(root.name or "")[:160], elements=elements, truncated=bool(queue) or omitted)
def semantic(request):
    global refs, snapshot
    if request["operation"] == "observe":
        return observe(request.get("query"))
    if request["snapshotId"] != snapshot or time.monotonic() >= expires or active_window() != root:
        raise RuntimeError("Stale desktop refs. Observe the active window again.")
    for index, action in enumerate(request["actions"]):
        try:
            if active_window() != root or time.monotonic() >= expires:
                raise RuntimeError("Active window changed. Observe again.")
            node, name, role, supported = refs[action["ref"]]
            node.clearCache()
            state = node.getState()
            if state.contains(pyatspi.STATE_DEFUNCT) or not state.contains(pyatspi.STATE_ENABLED) or not state.contains(pyatspi.STATE_SHOWING) or node.name != name or node.getRoleName() != role:
                raise RuntimeError("Desktop control changed or is unavailable")
            kind = action["action"]
            if kind not in supported:
                raise RuntimeError("Unsupported semantic action for this ref")
            if kind == "setValue":
                if not node.queryEditableText().setTextContents(action["value"]):
                    raise RuntimeError("Application rejected the text")
            elif kind == "select":
                if not node.parent.querySelection().selectChild(node.getIndexInParent()):
                    raise RuntimeError("Application rejected the selection")
            elif not node.queryAction().doAction(0):
                raise RuntimeError("Application rejected the action")
        except Exception as error:
            refs = {}
            snapshot = None
            raise RuntimeError("Desktop batch stopped at action %d; %d later actions skipped. %s" %
                (index + 1, len(request["actions"]) - index - 1, error))
    return observe()
for line in sys.stdin:
    request = None
    try:
        if len(line) > 32768:
            raise RuntimeError("Desktop request exceeded bounds")
        request = json.loads(line)
        if request["operation"] == "invalidate":
            refs = {}
            snapshot = None
            result = {}
        else:
            result = dict(observation=semantic(request["request"]))
        result.update(ok=True, id=request["id"])
    except Exception as error:
        result = dict(ok=False, id=request.get("id") if request else None, error=str(error)[:2048])
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")), flush=True)
`
