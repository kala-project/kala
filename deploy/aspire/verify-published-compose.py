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
OBSERVABILITY = {'observability-dashboard', 'otel-collector', 'observability-readiness'}
ACCEPTED_SHAPES = (EXPECTED, EXPECTED | OBSERVABILITY)
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
    service_names = set(services)
    if service_names not in ACCEPTED_SHAPES:
        raise ValueError('Published graph must contain exactly the reviewed six-service or nine-service observability shape')
    observability = service_names == EXPECTED | OBSERVABILITY
    for name, service in services.items():
        if not IMAGE.fullmatch(service.get('image', '')):
            raise ValueError(f'{name} must have an immutable image digest')
        if service.get('privileged') or service.get('network_mode') == 'host':
            raise ValueError(f'{name} has a forbidden host privilege/network setting')
        health = service.get('healthcheck', {})
        test = health.get('test', [])
        if name not in OBSERVABILITY and (health.get('disable') or not isinstance(test, list) or len(test) < 2 or test[0] != 'CMD'
                or health.get('timeout') != '4s' or health.get('interval') != '5s'
                or health.get('retries') != 12 or health.get('start_period') != '20s'):
            raise ValueError(f'{name} must retain the reviewed bounded executable health check')
        ports = service.get('ports', [])
        if name == 'ingress':
            if len(ports) != 1 or ports[0].get('target') != 443 or ports[0].get('protocol') != 'tcp':
                raise ValueError('Ingress must retain one public HTTPS endpoint')
        elif name == 'observability-dashboard':
            if (len(ports) != 1 or ports[0].get('target') != 18888
                    or ports[0].get('protocol') != 'tcp' or ports[0].get('host_ip') != '127.0.0.1'):
                raise ValueError('Observability management must be the sole loopback-only management endpoint')
        elif ports:
            raise ValueError(f'{name} unexpectedly publishes a host port')
    if services['dashboard'].get('volumes'):
        raise ValueError('Dashboard must not mount application data')
    if observability:
        for name in OBSERVABILITY:
            if name != 'observability-readiness' and services[name].get('restart') != 'unless-stopped':
                raise ValueError(f'{name} must retain the long-running restart policy')
            logging = services[name].get('logging', {})
            options = logging.get('options', {})
            expected_logging = ('1m', '1') if name == 'observability-readiness' else ('10m', '3')
            if logging.get('driver') != 'json-file' or options.get('max-size') != expected_logging[0] or str(options.get('max-file')) != expected_logging[1]:
                raise ValueError(f'{name} must retain bounded Docker log rotation')
            limits = services[name].get('deploy', {}).get('resources', {}).get('limits', {})
            if not limits.get('cpus') or not limits.get('memory'):
                raise ValueError(f'{name} must retain CPU and memory limits')
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
    if observability:
        dashboard_files = checked_files('observability-dashboard', {'/etc/kala-observability/dashboard.settings.json'})
        collector_files = checked_files('otel-collector', {'/etc/otelcol-contrib/config.yaml'})
        dashboard_settings = json.loads(Path(dashboard_files['/etc/kala-observability/dashboard.settings.json']).read_text())
        dashboard_config = dashboard_settings.get('Dashboard', {})
        if (dashboard_config.get('Frontend', {}).get('AuthMode') != 'BrowserToken'
                or dashboard_config.get('Otlp', {}).get('AuthMode') != 'ApiKey'
                or dashboard_config.get('Api', {}).get('AuthMode') != 'ApiKey'
                or 'observability-dashboard' not in dashboard_settings.get('AllowedHosts', '').split(';')):
            raise ValueError('Standalone Dashboard UI, OTLP, telemetry API, and Collector host must retain reviewed authentication')
        collector_config = Path(collector_files['/etc/otelcol-contrib/config.yaml']).read_text()
        for required in ('bearertokenauth/ingest', 'memory_limiter', 'send_batch_max_size:',
                         'queue_size:', 'max_elapsed_time:', 'x-otlp-api-key:', 'compression: none', 'encoding: proto'):
            if required not in collector_config:
                raise ValueError('Collector must retain authenticated bounded in-memory pipelines')
        probe = services['observability-readiness']
        probe_command = ' '.join(str(value) for value in probe.get('command', []))
        if (probe.get('entrypoint') != ['/bin/sh'] or probe.get('restart', 'no') != 'no'
                or 'http://observability-dashboard:18888/health' not in probe_command
                or 'http://otel-collector:13133/' not in probe_command):
            raise ValueError('Observability readiness must be a finite native runtime probe')
        for name in ('gateway', 'runtime'):
            environment = services[name].get('environment', {})
            dependency = services[name].get('depends_on', {}).get('observability-readiness', {})
            if (environment.get('KALA_OTEL_ENABLED') != '1'
                    or environment.get('KALA_OTEL_EXPORTER_ENDPOINT') != 'http://otel-collector:4318'
                    or not environment.get('KALA_OTEL_EXPORTER_TOKEN')
                    or dependency.get('condition') != 'service_completed_successfully'):
                raise ValueError(f'{name} must wait for runtime-healthy protected Collector and Dashboard')
        dashboard_environment = services['observability-dashboard'].get('environment', {})
        if (dashboard_environment.get('ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS', '').lower() == 'true'
                or not dashboard_environment.get('Dashboard__Frontend__BrowserToken')
                or not dashboard_environment.get('Dashboard__Otlp__PrimaryApiKey')):
            raise ValueError('Standalone Dashboard must not allow anonymous UI or OTLP access')
        collector_environment = services['otel-collector'].get('environment', {})
        tokens = [dashboard_environment.get('Dashboard__Frontend__BrowserToken'),
                  dashboard_environment.get('Dashboard__Otlp__PrimaryApiKey'),
                  services['runtime']['environment'].get('KALA_OTEL_EXPORTER_TOKEN')]
        if (any(not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._~-]{32,1024}', token) for token in tokens)
                or len(set(tokens)) != 3
                or dashboard_environment.get('Dashboard__Api__PrimaryApiKey') != tokens[1]
                or collector_environment.get('KALA_ASPIRE_DASHBOARD_OTLP_API_KEY') != tokens[1]
                or collector_environment.get('KALA_OTEL_INGEST_TOKEN') != tokens[2]
                or services['gateway']['environment'].get('KALA_OTEL_EXPORTER_TOKEN') != tokens[2]):
            raise ValueError('Observability requires three distinct strong credentials with consistent endpoint bindings')
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
