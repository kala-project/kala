#!/usr/bin/env python3
"""Produce a new PID-bounded Compose bundle; never deploy or resolve secrets."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

import yaml

from execution_profile import PID_LIMITS


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def regular_bytes(path: Path) -> bytes:
    if path != path.resolve() or not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_size > 2_000_000:
        raise ValueError('Publication input must be a canonical regular file of bounded size')
    return path.read_bytes()


class TemplateLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if len(set(keys)) != len(keys):
            raise ValueError('Publication templates must not contain duplicate mapping keys')
        return super().construct_mapping(node, deep=deep)


def load_template(content: bytes) -> dict:
    try:
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(content)):
            raise ValueError('Raw publication templates must not use YAML aliases')
        return yaml.load(content, Loader=TemplateLoader)
    except yaml.YAMLError:
        raise ValueError('Invalid private publication template') from None


def finalize_document(document: dict) -> dict:
    if not isinstance(document, dict) or not isinstance(document.get('services'), dict):
        raise ValueError('Publication must contain a complete service mapping')
    services = document['services']
    if any(not isinstance(service, dict) for service in services.values()):
        raise ValueError('Publication must contain service mappings')
    core = {'runtime', 'gateway', 'dashboard', 'postgres', 'silo'}
    telemetry = {'observability-dashboard', 'otel-collector', 'observability-readiness'}
    if set(services) not in (core, core | {'ingress'}, core | telemetry, core | telemetry | {'ingress'}):
        raise ValueError('Publication must retain a reviewed complete Dedicated graph')
    if services['gateway'].get('environment', {}).get('KALA_DEDICATED_EXECUTION_PROFILE') != 'bounded-v2':
        raise ValueError('Only a raw bounded-v2 template can be finalized')
    for service in services.values():
        limits = service.get('deploy', {}).get('resources', {}).get('limits')
        if not isinstance(limits, dict) or not {'cpus', 'memory'} <= set(limits):
            raise ValueError('Raw template must retain explicit resource limits')
        if 'pids_limit' in service or 'pids' in limits:
            raise ValueError('Raw template must not already contain PID overrides')
    result = copy.deepcopy(document)
    for name, service in result['services'].items():
        service['pids_limit'] = PID_LIMITS[name]
        service['deploy']['resources']['limits']['pids'] = PID_LIMITS[name]
    if any(service['pids_limit'] != PID_LIMITS[name] for name, service in result['services'].items()):
        raise ValueError('Aliased services cannot share conflicting PID budgets')
    return result


def receipt_path(compose: Path) -> Path:
    return compose.with_name(compose.name + '.publication.json')


def create_private(path: Path, content: bytes) -> None:
    # Hard-link a fully fsynced same-directory temporary file: atomic, no clobber.
    descriptor, temporary = tempfile.mkstemp(prefix='.publication-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        os.unlink(temporary)


def finalize(source: Path, output: Path) -> dict:
    source, output = source.absolute(), output.absolute()
    if output.parent != source.parent or output == source or output != output.resolve():
        raise ValueError('Finalized output must be a new file beside its unchanged template')
    receipt = receipt_path(output)
    if output.exists() or output.is_symlink() or receipt.exists() or receipt.is_symlink():
        raise ValueError('Publication output or receipt already exists; choose a fresh destination')
    original = regular_bytes(source)
    document = load_template(original)
    finalized = yaml.safe_dump(finalize_document(document), sort_keys=False).encode()
    record = {'schemaVersion': 1, 'profile': 'bounded-v2', 'sourceFile': source.name,
        'sourceSha256': digest(original), 'outputSha256': digest(finalized),
        'pidLimits': {name: PID_LIMITS[name] for name in sorted(document['services'])},
        'scope': 'PID-only publication; not deployment or runtime acceptance'}
    create_private(output, finalized)
    create_private(receipt, (json.dumps(record, sort_keys=True, indent=2) + '\n').encode())
    return record


def verify_receipt(compose: Path) -> None:
    output = regular_bytes(compose)
    record = json.loads(regular_bytes(receipt_path(compose)))
    if not isinstance(record, dict):
        raise ValueError('Publication receipt must be an object')
    source_name = record.get('sourceFile')
    if (record.get('schemaVersion') != 1 or record.get('profile') != 'bounded-v2'
            or not isinstance(source_name, str) or Path(source_name).name != source_name
            or source_name in ('.', '..', compose.name) or record.get('outputSha256') != digest(output)):
        raise ValueError('Finalized publication receipt does not match the reviewed output')
    source = regular_bytes(compose.parent / source_name)
    expected = finalize_document(load_template(source))
    if (record.get('sourceSha256') != digest(source) or load_template(output) != expected
            or record.get('pidLimits') != {name: PID_LIMITS[name] for name in expected['services']}):
        raise ValueError('Publication template/output was changed after PID-only finalization')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        finalize(args.source, args.output)
    except (ValueError, KeyError, TypeError, OSError, yaml.YAMLError):
        parser.exit(1, 'Dedicated publication rejected; private inputs withheld; existing outputs are never overwritten\n')
    print('Dedicated bounded-v2 publication completed; fill private parameters and run topology admission before deployment')
