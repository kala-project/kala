#!/usr/bin/env python3
"""Operator-owned FUSE lifecycle broker; no database or tenant credentials."""
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve(strict=True)
driver = Path(sys.argv[2]).resolve(strict=True)
assert root.is_dir() and stat.S_IMODE(root.stat().st_mode) == 0o700
assert driver.is_file() and os.access(driver, os.X_OK)
os.umask(0o077)
active = {}
handled = {}
stopping = False


def clear_disconnected_mounts():
    pattern = re.compile(re.escape(str(root)) + r'/[a-f0-9]{64}/home/session-state/[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}')
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields, filesystem = line.split(' - ', 1)
        mountpoint = fields.split()[4]
        if pattern.fullmatch(mountpoint) and filesystem.split()[0].startswith('fuse'):
            subprocess.run(['fusermount3', '-uz', mountpoint], check=True, timeout=30)
            print(json.dumps({'event': 'native_mount_restart_detached', 'mountpoint': mountpoint}), flush=True)


def stop(_signal, _frame):
    global stopping
    stopping = True


def checked(path, directory=False):
    info = path.lstat()
    assert not stat.S_ISLNK(info.st_mode)
    assert stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    assert info.st_uid == root.stat().st_uid
    assert not info.st_mode & 0o077
    return info


def unmount(key):
    item = active.get(key)
    if not item:
        return
    process, mountpoint, log = item
    if os.path.ismount(mountpoint):
        subprocess.run(['fusermount3', '-uz', str(mountpoint)], check=True, timeout=30)
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=15)
    log.close()
    del active[key]


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
clear_disconnected_mounts()
try:
    while not stopping:
        for directory in root.iterdir():
            if not re.fullmatch('[a-f0-9]{64}', directory.name):
                continue
            request = None
            try:
                checked(directory, True)
                request_path = directory / 'request.json'
                if not request_path.exists():
                    continue
                assert checked(request_path).st_size <= 1024
                request = json.loads(request_path.read_text())
                request_id = request['requestId']
                assert re.fullmatch('[a-f0-9-]{36}', request_id)
                if handled.get(directory.name) == request_id:
                    continue
                session = request['sessionId']
                assert re.fullmatch('[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}', session)
                home = directory / 'home'
                parent = home / 'session-state'
                mountpoint = parent / session
                for path in [home, parent, directory / 'bridge']:
                    checked(path, True)
                if request['action'] == 'unmount':
                    unmount(directory.name)
                elif request['action'] == 'mount':
                    assert directory.name not in active
                    checked(mountpoint, True)
                    assert not os.path.ismount(mountpoint) and not any(mountpoint.iterdir())
                    bridge = directory / 'bridge/native.sock'
                    assert stat.S_ISSOCK(bridge.lstat().st_mode)
                    assert len(str(bridge).encode()) < 108
                    log = (directory / 'fuse.log').open('ab')
                    uid = root.stat().st_uid
                    gid = root.stat().st_gid
                    # A lost FUSE mount must expose an inaccessible directory, never a writable local fallback.
                    os.chmod(mountpoint, 0)
                    process = subprocess.Popen([str(driver), str(bridge), str(mountpoint),
                        '-f', '-s', '-o', f'allow_other,default_permissions,uid={uid},gid={gid}'],
                        stdout=log, stderr=subprocess.STDOUT)
                    active[directory.name] = (process, mountpoint, log)
                    deadline = time.monotonic() + 20
                    while not os.path.ismount(mountpoint):
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError('FUSE mount did not become ready')
                        time.sleep(0.05)
                else:
                    raise ValueError('Unknown native mount action')
                response = {'requestId': request_id, 'ok': True}
            except Exception as error:
                print(json.dumps({'event': 'native_mount_broker_error', 'directory': directory.name,
                                  'error': type(error).__name__, 'message': str(error)}), flush=True)
                if not isinstance(request, dict) or 'requestId' not in request:
                    continue
                request_id = request['requestId']
                response = {'requestId': request_id, 'ok': False}
            temporary = directory / 'response.tmp'
            temporary.write_text(json.dumps(response))
            os.chown(temporary, root.stat().st_uid, root.stat().st_gid)
            temporary.replace(directory / 'response.json')
            handled[directory.name] = request_id
        for key in list(active):
            process, mountpoint, log = active[key]
            alive = False
            try:
                with socket.socket(socket.AF_UNIX) as probe:
                    probe.settimeout(1)
                    probe.connect(str(root / key / 'bridge/native.sock'))
                    alive = process.poll() is None
            except OSError:
                pass
            if not alive:
                print(json.dumps({'event': 'native_mount_backend_lost', 'directory': key}), flush=True)
                unmount(key)
        time.sleep(0.1)
finally:
    for key in list(active):
        unmount(key)
