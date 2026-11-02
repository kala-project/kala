#!/usr/bin/env python3
"""Fail closed on accidental exposure or application-data mounts in Aspire output.

Run before replacing placeholder values or deploying. This is a topology check,
not a health, image provenance, credential-policy or recovery acceptance test.
Never echo resolved Compose: it may contain credentials from the .env file.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

EXPECTED = {'ingress', 'gateway', 'runtime', 'dashboard', 'postgres', 'silo'}
IMAGE = re.compile(r'^[^\s]+@sha256:[0-9a-fA-F]{64}$')


def check(compose: Path, env: Path) -> None:
    if not compose.is_file() or not env.is_file():
        raise ValueError('Compose file and parameter file are both required')
    result = subprocess.run(
        ['docker', 'compose', '--project-directory', str(compose.parent),
         '--env-file', str(env), '-f', str(compose), 'config', '--format', 'json'],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError('Docker Compose rejected generated configuration (diagnostics withheld to protect secrets)')
    services = json.loads(result.stdout)['services']
    if set(services) != EXPECTED:
        raise ValueError('Published graph must contain exactly six reviewed application/data services')
    for name, service in services.items():
        if not IMAGE.fullmatch(service.get('image', '')):
            raise ValueError(f'{name} must have an immutable image digest')
        if service.get('privileged') or service.get('network_mode') == 'host':
            raise ValueError(f'{name} has a forbidden host privilege/network setting')
        health = service.get('healthcheck', {})
        test = health.get('test', [])
        if (health.get('disable') or not isinstance(test, list) or len(test) < 2 or test[0] != 'CMD'
                or health.get('timeout') != '4s' or health.get('interval') != '5s'
                or health.get('retries') != 12 or health.get('start_period') != '20s'):
            raise ValueError(f'{name} must retain the reviewed bounded executable health check')
        ports = service.get('ports', [])
        if name == 'ingress':
            if len(ports) != 1 or ports[0].get('target') != 443 or ports[0].get('protocol') != 'tcp':
                raise ValueError('Ingress must be the sole HTTPS published endpoint')
        elif ports:
            raise ValueError(f'{name} unexpectedly publishes a host port')
    if services['dashboard'].get('volumes'):
        raise ValueError('Dashboard must not mount application data')
    def checked_files(name: str, targets: set[str]) -> dict[str, str]:
        mounts = services[name].get('volumes', [])
        if len(mounts) != len(targets) or {mount.get('target') for mount in mounts} != targets \
                or any(mount.get('read_only') is not True or mount.get('type') != 'bind'
                       or not Path(mount.get('source', '')).is_file() for mount in mounts):
            raise ValueError(f'{name} may mount only its reviewed existing read-only configuration files')
        return {mount['target']: mount['source'] for mount in mounts}
    runtime_files = checked_files('runtime', {
        '/etc/kala/deployment.json', '/run/kala-secrets/runtime-state-master-key',
        '/run/kala-secrets/installation-id'
    })
    gateway_files = checked_files('gateway', {
        '/etc/kala/deployment.json', '/run/kala-secrets/installation-id'
    })
    for target in gateway_files:
        if gateway_files[target] != runtime_files[target]:
            raise ValueError('Gateway and Runtime must use the same deployment configuration and installation ID')
    ingress_mounts = services['ingress'].get('volumes', [])
    caddyfiles = [mount for mount in ingress_mounts if mount.get('target') == '/etc/caddy/Caddyfile']
    if len(caddyfiles) != 1 or caddyfiles[0].get('read_only') is not True \
            or not Path(caddyfiles[0].get('source', '')).is_file():
        raise ValueError('Ingress must mount an existing read-only Caddy configuration file')
    data_sources = []
    for name, target in (('postgres', '/var/lib/postgresql/data'), ('silo', '/data')):
        mounts = services[name].get('volumes', [])
        if len(mounts) != 1 or mounts[0].get('target') != target or mounts[0].get('type') != 'bind':
            raise ValueError(f'{name} requires one protected host data mount')
        source = mounts[0].get('source', '')
        path = Path(source)
        try:
            canonical = path.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ValueError(f'{name} data mount must be an existing dedicated directory') from None
        if (not path.is_absolute() or not path.is_dir() or canonical == Path(canonical.anchor)
                or path.is_symlink() or str(canonical) != source.rstrip('/')):
            raise ValueError(f'{name} data mount must be an existing canonical non-symlink directory, not root')
        data_sources.append(canonical)
    a, b = data_sources
    if a == b or a in b.parents or b in a.parents:
        raise ValueError('PostgreSQL and SILO data directories must be disjoint, not equal or nested')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: verify-published-compose.py <docker-compose.yaml> <.env>')
        check(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f'Aspire Compose topology rejected: {error}', file=sys.stderr)
        sys.exit(1)
    print('Aspire Compose topology accepted; runtime and recovery acceptance still required')
