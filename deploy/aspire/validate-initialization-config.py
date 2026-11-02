#!/usr/bin/env python3
"""Validate resolved Compose against protected initialization files without printing secrets."""
import json
import os
import re
import stat
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path(os.environ['KALA_ASPIRE_SECRETS_DIR']).resolve()

def secret(name: str) -> str:
    path = root / name
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or metadata.st_mode & 0o077:
        raise ValueError(f'{name} must be a regular file inaccessible to group and other users')
    value = path.read_text().strip()
    if not value:
        raise ValueError(f'{name} is empty')
    return value

def password(url_name: str) -> str:
    value = urlsplit(secret(url_name))
    if value.scheme not in {'postgres', 'postgresql'} or value.password is None:
        raise ValueError(f'{url_name} is not a PostgreSQL URL with a password')
    return unquote(value.password)

try:
    services = json.load(sys.stdin)['services']
    observability = 'otel-collector' in services
    checks = {
        ('gateway', 'KALA_INGRESS_DATABASE_URL'): secret('gateway_database_url'),
        ('gateway', 'KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING'): secret('runtime_reader_database_url'),
        ('runtime', 'KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING'): secret('runtime_database_url'),
        ('runtime', 'KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID'): secret('runtime_s3_access_key'),
        ('runtime', 'KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY'): secret('runtime_s3_secret_key'),
        ('silo', 'MINIO_ROOT_USER'): secret('silo_root_access_key'),
        ('silo', 'MINIO_ROOT_PASSWORD'): secret('silo_root_secret_key'),
        ('postgres', 'POSTGRES_PASSWORD'): password('postgres_admin_url'),
    }
    if observability:
        checks.update({
            ('otel-collector', 'KALA_OBSERVABILITY_POSTGRES_PASSWORD'): secret('observability_postgres_password'),
            ('otel-collector', 'KALA_OBSERVABILITY_SILO_METRICS_TOKEN'): secret('observability_silo_metrics_token'),
        })
    for (service, name), expected in checks.items():
        if services.get(service, {}).get('environment', {}).get(name) != expected:
            raise ValueError(f'{service} {name} does not match its protected initialization file')
    if secret('silo_root_access_key') == secret('runtime_s3_access_key') \
            or secret('silo_root_secret_key') == secret('runtime_s3_secret_key'):
        raise ValueError('SILO root and Runtime credentials must be distinct')
    if observability:
        pg_password = secret('observability_postgres_password')
        existing_passwords = [password(name) for name in (
            'postgres_admin_url', 'control_owner_url', 'gateway_database_url',
            'runtime_owner_url', 'runtime_database_url', 'runtime_reader_database_url')]
        if len(pg_password.encode()) < 32 or pg_password in existing_passwords:
            raise ValueError('observability PostgreSQL password must be at least 32 bytes and distinct from all role credentials')
        collector = services['otel-collector']['environment']
        silo_token = secret('observability_silo_metrics_token')
        telemetry_credentials = [
            pg_password, silo_token,
            services['observability-dashboard']['environment'].get('Dashboard__Frontend__BrowserToken'),
            services['observability-dashboard']['environment'].get('Dashboard__Otlp__PrimaryApiKey'),
            collector.get('KALA_OTEL_INGEST_TOKEN'),
        ]
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', silo_token):
            raise ValueError('observability SILO metrics token must be a signed JWT')
        if any(not isinstance(value, str) or len(value.encode()) < 32 for value in telemetry_credentials) \
                or len(set(telemetry_credentials)) != len(telemetry_credentials):
            raise ValueError('all observability credentials must be strong and distinct')
    installation = secret('installation_id')
    configured = Path(services['runtime']['environment']['KALA_INSTALLATION_ID_FILE'])
    mounts = services['runtime'].get('volumes', [])
    source = next((Path(m['source']) for m in mounts if Path(m.get('target', '')) == configured), None)
    if source is None or source.read_text().strip() != installation:
        raise ValueError('published Runtime installation ID mount does not match initialization')
    runtime = services['runtime']
    key_path = runtime['environment']['KALA_RUNTIME_EXPERIMENTAL_STATE_MASTER_KEY_FILE']
    key_source = next((Path(m['source']) for m in mounts if m.get('target') == key_path), None)
    key = (root / 'runtime_state_master_key').read_bytes()
    if len(key) != 32 or key_source is None or key_source.read_bytes() != key:
        raise ValueError('published Runtime state key must match the protected 32-byte initialization key')
except (KeyError, OSError, ValueError, json.JSONDecodeError) as error:
    print(f'Initialization configuration rejected: {error}', file=sys.stderr)
    sys.exit(1)
print('Initialization configuration accepted (secret values withheld)')
