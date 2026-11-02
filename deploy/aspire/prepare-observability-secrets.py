#!/usr/bin/env python3
"""Root operator: prepare metrics-only credentials before Aspire publication.

Uses the reviewed SILO mc offline with no network. Never emits credential values.
Existing credentials are preserved, not silently rotated.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
from urllib.parse import quote


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('monitoring inputs must be root-owned private regular non-symlink files')
    value = path.read_text().strip()
    if not value:
        raise ValueError('monitoring input is empty')
    return value


def persist(path, value):
    # O_EXCL/O_NOFOLLOW: a retry never overwrites existing authority credentials.
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('protected_secrets_directory', type=Path)
    parser.add_argument('--mc-image', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('run as root operator')
    root = args.protected_secrets_directory
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('protected secret directory must be root-owned private and non-symlink')
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-fA-F]{64}', args.mc_image):
        raise ValueError('mc image must be a reviewed immutable digest')
    pg = root / 'observability_postgres_password'
    silo = root / 'observability_silo_metrics_token'
    if pg.exists() or pg.is_symlink():
        if len(private_file(pg).encode()) < 32:
            raise ValueError('existing observer password is too short')
    else:
        persist(pg, secrets.token_urlsafe(32))
    if silo.exists() or silo.is_symlink():
        token = private_file(silo)
    else:
        access = private_file(root / 'silo_root_access_key')
        secret = private_file(root / 'silo_root_secret_key')
        alias = f'http://{quote(access, safe="")}:{quote(secret, safe="")}@127.0.0.1:1'
        result = subprocess.run([
            'docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/sh', args.mc_image,
            '-c', 'read -r MC_HOST_kala; export MC_HOST_kala; mc admin prometheus generate kala --api-version v2 --json',
        ], input=alias + '\n', capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise ValueError('official offline mc metrics-token generation failed; output withheld')
        token = json.loads(result.stdout)['bearerToken']
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
            raise ValueError('mc did not return a signed metrics JWT')
        persist(silo, token)
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
        raise ValueError('existing metrics token is not a signed JWT')
    print('Monitoring credential files prepared; existing credentials preserved; no values emitted')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # Do not echo arbitrary subprocess/JSON input, URLs or credential values.
        print('Monitoring credential preparation failed; inspect protected inputs and reviewed mc image', file=sys.stderr)
        sys.exit(1)
