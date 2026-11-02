#!/usr/bin/env python3
"""Fail closed on accidental exposure or application-data mounts in Aspire output.

Run before replacing placeholder values or deploying. This is a topology check,
not a health, image provenance, credential-policy or recovery acceptance test.
Never echo resolved Compose: it may contain credentials from the .env file.
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from execution_profile import PID_LIMITS

EXPECTED = {'ingress', 'gateway', 'runtime', 'dashboard', 'postgres', 'silo'}
OBSERVABILITY = {'observability-dashboard', 'otel-collector', 'observability-readiness'}
EXTERNAL = EXPECTED - {'ingress'}
ACCEPTED_SHAPES = (EXPECTED, EXPECTED | OBSERVABILITY, EXTERNAL, EXTERNAL | OBSERVABILITY)
IMAGE = re.compile(r'^[^\s]+@sha256:[0-9a-fA-F]{64}$')


def memory_bytes(value) -> int:
    if isinstance(value, bool):
        raise ValueError('bounded-v1 requires positive finite resource limits')
    match = re.fullmatch(r'([0-9]+)([bkmg]?)(?:i?b)?', str(value).lower())
    amount = int(match[1]) * 1024 ** 'bkmg'.index(match[2] or 'b') if match else 0
    if not 0 < amount < 2**63:
        raise ValueError('bounded-v1 requires positive finite resource limits')
    return amount


def check_execution_profile(services: dict) -> str:
    profile = services['gateway'].get('environment', {}).get('KALA_DEDICATED_EXECUTION_PROFILE')
    if profile is None:
        return 'legacy-unmarked'
    if profile not in ('bounded-v1', 'bounded-v2'):
        raise ValueError('Unknown Dedicated execution profile')
    for name, service in services.items():
        if profile == 'bounded-v2' and (type(service.get('pids_limit')) is not int or service['pids_limit'] != PID_LIMITS.get(name)):
            raise ValueError('bounded-v2 requires finalized container PID budgets; raw templates are not deployable')
        limits = service.get('deploy', {}).get('resources', {}).get('limits', {})
        if profile == 'bounded-v2' and (type(limits.get('pids')) is not int or limits['pids'] != PID_LIMITS[name]
                or 'nproc' in service.get('ulimits', {})):
            raise ValueError('bounded-v2 requires consistent cgroup PID budgets, never shared-UID nproc')
        try:
            cpu = float(limits.get('cpus', 0))
        except (ValueError, TypeError):
            cpu = 0
        if isinstance(limits.get('cpus'), bool) or not math.isfinite(cpu) or cpu <= 0:
            raise ValueError('bounded-v1 requires positive finite resource limits')
        memory_bytes(limits.get('memory', 0))
        logging = service.get('logging', {})
        expected = ('1m', '1') if name == 'observability-readiness' else ('10m', '3')
        if logging.get('driver') != 'json-file' or (logging.get('options', {}).get('max-size'), str(logging.get('options', {}).get('max-file'))) != expected:
            raise ValueError('bounded-v1 requires bounded Docker logs')
        if (service.get('privileged') or service.get('cap_add') or service.get('devices') or service.get('device_cgroup_rules')
                or service.get('use_api_socket') or any(service.get(key) == 'host' for key in ('pid', 'ipc', 'network_mode'))):
            raise ValueError('bounded-v1 refuses elevated privileges and host namespaces')
    for name in ('runtime', 'gateway', 'dashboard'):
        service = services[name]
        if (service.get('user') != '65532:65532' or service.get('read_only') is not True
                or set(service.get('cap_drop', [])) != {'ALL'}
                or service.get('security_opt') not in (['no-new-privileges:true'], ['no-new-privileges'])):
            raise ValueError('bounded-v1 application isolation must not be weakened')
        expected = {'/tmp': 64 * 1024**2}
        if name == 'runtime':
            expected['/app/packages/host/.runtime-tmp'] = 512 * 1024**2
        actual = {}
        for entry in service.get('tmpfs', []):
            path, separator, options = entry.partition(':')
            flags = options.split(',')
            if not separator or path in actual or not {'rw', 'noexec', 'nosuid', 'nodev'} <= set(flags) or {'exec', 'suid', 'dev'} & set(flags):
                raise ValueError('bounded-v1 scratch must remain bounded and noexec/nosuid/nodev')
            settings = dict(flag.split('=', 1) for flag in flags if '=' in flag)
            if (len(flags) != len(set(flags)) or len(settings) != sum('=' in flag for flag in flags)
                    or not set(flags) - set(flag for flag in flags if '=' in flag) <= {'rw', 'noexec', 'nosuid', 'nodev'}
                    or set(settings) - {'size', 'uid', 'gid', 'mode'}):
                raise ValueError('bounded-v1 refuses ambiguous scratch options')
            if path not in expected or memory_bytes(settings.get('size', 0)) > expected[path]:
                raise ValueError('bounded-v1 scratch path or capacity is unreviewed')
            if path == '/app/packages/host/.runtime-tmp' and any(settings.get(key) != value for key, value in {'uid': '65532', 'gid': '65532', 'mode': '0700'}.items()):
                raise ValueError('bounded-v1 Runtime scratch must be private to the application UID')
            if path == '/tmp' and settings != {'size': settings.get('size'), 'mode': '1777'}:
                raise ValueError('bounded-v1 temporary directory must retain the reviewed permissions')
            actual[path] = True
        if set(actual) != set(expected):
            raise ValueError('bounded-v1 requires the reviewed disposable scratch mounts')
    environment = services['runtime'].get('environment', {})
    if (environment.get('COPILOT_CLI_PATH') != '/app/copilot-runtime/copilot-runtime'
            or environment.get('TMPDIR') != '/app/packages/host/.runtime-tmp'
            or environment.get('KALA_RUNTIME_HOST_DATA_ROOT') != '/app/packages/host/.runtime-tmp/kala'):
        raise ValueError('bounded-v1 Runtime must use immutable SDK code and reviewed scratch')
    return profile


def check(compose: Path, env: Path) -> str:
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
        raise ValueError('Published graph must contain exactly a reviewed five/six-service or eight/nine-resource shape')
    external = 'ingress' not in service_names
    marker = services['gateway'].get('environment', {}).get('KALA_DEDICATED_INGRESS_MODE')
    if (external and marker != 'external') or (not external and marker not in (None, 'bundled-caddy')):
        raise ValueError('Ingress graph and KALA_DEDICATED_INGRESS_MODE marker must agree')
    origin_text = services['gateway'].get('environment', {}).get('KALA_PUBLIC_URLS', '')
    origin = urlsplit(origin_text)
    if (not origin_text or any(c.isspace() for c in origin_text) or origin.scheme != 'https' or not origin.hostname
            or origin.username is not None or origin.password is not None or origin.path not in ('', '/') or origin.query or origin.fragment):
        raise ValueError('Dedicated requires one HTTPS public Origin even when TLS is externally managed')
    _ = origin.port  # Reject malformed/out-of-range explicit ports without printing the input.
    if external and (json.loads(result.stdout).get('volumes') or any(
            mount.get('type') == 'volume' for service in services.values() for mount in service.get('volumes', []))):
        raise ValueError('External ingress must not declare or mount named application/certificate volumes')
    # Runtime identity is deliberately separate from app/data/telemetry credentials.
    runtime_auth = services['runtime'].get('environment', {})
    auth_mode = runtime_auth.get('KALA_DEDICATED_COPILOT_AUTH_MODE')
    if auth_mode is not None:
        token = runtime_auth.get('COPILOT_GITHUB_TOKEN')
        if auth_mode != 'github-token' or not isinstance(token, str) or not token.strip():
            raise ValueError('Selected Copilot authentication requires an explicit Runtime GitHub token')
        if runtime_auth.get('GH_TOKEN') or runtime_auth.get('GITHUB_TOKEN'):
            raise ValueError('Selected Copilot authentication refuses ambiguous fallback credentials')
    for name, service in services.items():
        if name != 'runtime' and any(service.get('environment', {}).get(key) for key in ('COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN')):
            raise ValueError('Copilot credentials may be supplied only to Runtime')
    observability = OBSERVABILITY <= service_names
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
        elif name == 'gateway' and external:
            if (len(ports) != 1 or ports[0].get('target') != 13001
                    or ports[0].get('protocol') != 'tcp' or ports[0].get('host_ip') != '127.0.0.1'):
                raise ValueError('External Gateway handoff must be one IPv4 loopback-only HTTP port')
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
    descriptor = json.loads(Path(runtime_files['/etc/kala/deployment.json']).read_text())
    if (not isinstance(descriptor, dict) or descriptor.get('schemaVersion') != 1
            or descriptor.get('architecture') != 'platform' or descriptor.get('tenancy') != 'single-tenant'
            or descriptor.get('runtimeProfile') != 'full'):
        raise ValueError('Operator mode descriptor must retain the Dedicated storage/tenancy/profile contract')
    if observability:
        dashboard_files = checked_files('observability-dashboard', {'/etc/kala-observability/dashboard.settings.json'})
        collector_targets = {'/etc/otelcol-contrib/config.yaml'}
        if not external:
            collector_targets.add('/etc/otelcol-contrib/caddy.yaml')
        collector_files = checked_files('otel-collector', collector_targets)
        expected_command = ['--config=/etc/otelcol-contrib/config.yaml']
        if not external:
            expected_command.append('--config=/etc/otelcol-contrib/caddy.yaml')
        if services['otel-collector'].get('command') != expected_command:
            raise ValueError('Collector must load only the reviewed ingress-mode-specific configurations')
        if not external:
            addon = Path(collector_files['/etc/otelcol-contrib/caddy.yaml']).read_text()
            for required in ('metrics/ingress:', 'ingress:8082', 'sample_limit: 256', 'labelkeep', 'service.name'):
                if required not in addon:
                    raise ValueError('Bundled Collector must collect bounded private Caddy aggregates')
        dashboard_settings = json.loads(Path(dashboard_files['/etc/kala-observability/dashboard.settings.json']).read_text())
        dashboard_config = dashboard_settings.get('Dashboard', {})
        if (dashboard_config.get('Frontend', {}).get('AuthMode') != 'BrowserToken'
                or dashboard_config.get('Otlp', {}).get('AuthMode') != 'ApiKey'
                or dashboard_config.get('Api', {}).get('AuthMode') != 'ApiKey'
                or 'observability-dashboard' not in dashboard_settings.get('AllowedHosts', '').split(';')):
            raise ValueError('Standalone Dashboard UI, OTLP, telemetry API, and Collector host must retain reviewed authentication')
        collector_config = Path(collector_files['/etc/otelcol-contrib/config.yaml']).read_text()
        for required in ('bearertokenauth/ingest', 'memory_limiter', 'send_batch_max_size:',
                         'queue_size:', 'max_elapsed_time:', 'x-otlp-api-key:', 'compression: none', 'encoding: proto',
                         'KALA_OBSERVABILITY_POSTGRES_PASSWORD', 'KALA_OBSERVABILITY_SILO_METRICS_TOKEN',
                         'metrics/postgres:', 'metrics/silo:', 'metric_relabel_configs:', 'sample_limit: 512'):
            if required not in collector_config:
                raise ValueError('Collector must retain authenticated bounded in-memory pipelines')
        if not re.search(r'(?m)^\s*username:\s*["\']?kala_observer["\']?\s*$', collector_config) \
                or any(not re.search(r'(?m)^\s*-\s*' + database + r'\s*$', collector_config)
                       for database in ('postgres', 'runlab_control', 'kala_runtime')):
            raise ValueError('Collector PostgreSQL receiver must use kala_observer against the three fixed databases')
        for event in ('db.server.query_sample', 'db.server.top_query'):
            if not re.search(re.escape(event) + r':\s*\n\s*enabled:\s*false\b', collector_config):
                raise ValueError('Collector must explicitly disable SQL query samples and plans')
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
        expected_collector_environment = {
            'KALA_OTEL_INGEST_TOKEN', 'KALA_ASPIRE_DASHBOARD_OTLP_API_KEY',
            'KALA_OBSERVABILITY_POSTGRES_PASSWORD', 'KALA_OBSERVABILITY_SILO_METRICS_TOKEN',
        }
        tokens = [dashboard_environment.get('Dashboard__Frontend__BrowserToken'),
                  dashboard_environment.get('Dashboard__Otlp__PrimaryApiKey'),
                  services['runtime']['environment'].get('KALA_OTEL_EXPORTER_TOKEN')]
        postgres_password = collector_environment.get('KALA_OBSERVABILITY_POSTGRES_PASSWORD')
        silo_metrics_token = collector_environment.get('KALA_OBSERVABILITY_SILO_METRICS_TOKEN')
        credentials = tokens + [postgres_password, silo_metrics_token]
        role_passwords = []
        for service, name in (
                ('postgres', 'POSTGRES_PASSWORD'),
                ('gateway', 'KALA_INGRESS_DATABASE_URL'),
                ('gateway', 'KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING'),
                ('runtime', 'KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING')):
            value = services[service].get('environment', {}).get(name, '')
            parsed = urlsplit(value) if name != 'POSTGRES_PASSWORD' else None
            role_passwords.append(unquote(parsed.password) if parsed and parsed.password is not None else value)
        if (set(collector_environment) != expected_collector_environment
                or any(not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._~-]{32,1024}', token) for token in tokens)
                or not isinstance(postgres_password, str) or len(postgres_password.encode()) < 32
                or not isinstance(silo_metrics_token, str) or len(silo_metrics_token.encode()) < 32
                or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', silo_metrics_token)
                or len(set(credentials)) != len(credentials)
                or postgres_password in role_passwords
                or dashboard_environment.get('Dashboard__Api__PrimaryApiKey') != tokens[1]
                or collector_environment.get('KALA_ASPIRE_DASHBOARD_OTLP_API_KEY') != tokens[1]
                or collector_environment.get('KALA_OTEL_INGEST_TOKEN') != tokens[2]
                or services['gateway']['environment'].get('KALA_OTEL_EXPORTER_TOKEN') != tokens[2]):
            raise ValueError('Observability requires five distinct strong credentials, fixed monitor authority, and consistent endpoint bindings')
    if not external:
        ingress_mounts = services['ingress'].get('volumes', [])
        caddyfiles = [mount for mount in ingress_mounts if mount.get('target') == '/etc/caddy/Caddyfile']
        if len(caddyfiles) != 1 or caddyfiles[0].get('read_only') is not True \
                or not Path(caddyfiles[0].get('source', '')).is_file():
            raise ValueError('Bundled ingress must mount an existing read-only Caddy configuration file')
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
    profile = check_execution_profile(services)
    if profile == 'bounded-v2':
        from finalize_published_compose import verify_receipt
        try:
            verify_receipt(compose)
        except (ValueError, KeyError, TypeError, OSError):
            raise ValueError('bounded-v2 requires an intact PID-only publication bundle and receipt') from None
    return profile


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: verify-published-compose.py <docker-compose.yaml> <.env>')
        execution_profile = check(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f'Aspire Compose topology rejected: {error}', file=sys.stderr)
        sys.exit(1)
    print(f'Aspire Compose topology accepted; execution profile: {execution_profile}; runtime and recovery acceptance still required')
