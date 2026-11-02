#!/usr/bin/env python3
"""Root-only, single-host cold lifecycle operator for Dedicated Aspire.

This deliberately does not drain or replay external Executor effects. A backup is
only a byte-preserving archive made after every service in the reviewed graph stops.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

SERVICES = {"ingress", "gateway", "runtime", "dashboard", "postgres", "silo"}
EXTERNAL_SERVICES = SERVICES - {"ingress"}
OBSERVABILITY = {"observability-dashboard", "otel-collector", "observability-readiness"}
ALL_SERVICES = SERVICES | OBSERVABILITY
EXTERNAL_ALL_SERVICES = EXTERNAL_SERVICES | OBSERVABILITY
ACCEPTED_SHAPES = (SERVICES, ALL_SERVICES, EXTERNAL_SERVICES, EXTERNAL_ALL_SERVICES)
APP_SERVICES = ("gateway", "runtime", "dashboard")
IMAGE = re.compile(r"^[^\s]+@sha256:[0-9a-fA-F]{64}$")
ACTIVE = {"running", "restarting", "paused"}
POLICY_SCHEMA = 1
ARTIFACT_SCHEMA = 3
BUNDLED_ARTIFACT_SCHEMA = 2
LEGACY_ARTIFACT_SCHEMA = 1
BUNDLED_ARCHIVE_ROOTS = {"postgres", "silo", "recovery", "caddy-data", "caddy-config"}
EXTERNAL_ARCHIVE_ROOTS = {"postgres", "silo", "recovery"}
ARCHIVE_ROOTS = BUNDLED_ARCHIVE_ROOTS
LEGACY_ARCHIVE_ROOTS = EXTERNAL_ARCHIVE_ROOTS
VOLUME_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


class OperatorError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise OperatorError(message)


def require_root() -> None:
    if os.geteuid() != 0:
        fail("run as the root operator; lifecycle artifacts and locks are privileged")
    os.umask(0o077)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def durable_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_regular(path: Path, label: str) -> Path:
    try:
        info = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error.strerror}")
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        fail(f"{label} must be a regular non-symlink file")
    if info.st_uid != 0 or info.st_mode & 0o077:
        fail(f"{label} must be root-owned and inaccessible to group/other users")
    return path.resolve(strict=True)


def safe_root(path: Path, label: str, *, empty: bool = False, root_owned: bool = True) -> Path:
    try:
        info = path.lstat()
        canonical = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error.strerror}")
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or canonical == Path(canonical.anchor):
        fail(f"{label} must be an existing canonical non-symlink directory, not filesystem root")
    if str(canonical) != str(path).rstrip("/"):
        fail(f"{label} must be supplied as its canonical path")
    if (root_owned and info.st_uid != 0) or info.st_mode & 0o077:
        owner = "root-owned and " if root_owned else ""
        fail(f"{label} must be {owner}inaccessible to group/other users")
    if empty and any(canonical.iterdir()):
        fail(f"{label} must be fresh and empty; existing content is never overwritten")
    return canonical


def disjoint(paths: list[Path], label: str) -> None:
    for index, left in enumerate(paths):
        for right in paths[index + 1 :]:
            if left == right or left in right.parents or right in left.parents:
                fail(f"{label} must be pairwise disjoint, not equal or nested")


@contextlib.contextmanager
def host_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.stat().st_uid != 0 or path.parent.stat().st_mode & 0o077:
        fail("lock directory must be root-owned and private")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("another Dedicated lifecycle operation holds the host lock")
        os.ftruncate(fd, 0)
        os.write(fd, f"pid={os.getpid()} started={int(time.time())}\n".encode())
        os.fsync(fd)
        yield
    finally:
        os.close(fd)


def run(command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        fail("bounded lifecycle subprocess timed out; services remain in an operator-inspection state")
    if result.returncode:
        # Deliberately suppress command output: Compose diagnostics may include resolved secrets.
        fail(f"lifecycle subprocess failed with exit status {result.returncode}; diagnostics withheld to protect secrets")
    return result


def compose_command(compose: Path, env: Path) -> list[str]:
    return ["docker", "compose", "--project-directory", str(compose.parent),
            "--env-file", str(env), "-f", str(compose)]


def verify_topology(compose: Path, env: Path) -> None:
    checker = Path(__file__).with_name("verify-published-compose.py")
    run([sys.executable, str(checker), str(compose), str(env)], timeout=90)


def compose_config(compose: Path, env: Path) -> dict[str, Any]:
    result = run(compose_command(compose, env) + ["config", "--format", "json"], timeout=90)
    try:
        config = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        fail("Docker Compose returned an invalid configuration document")
    services = config.get("services")
    if not isinstance(services, dict) or set(services) not in ACCEPTED_SHAPES:
        fail("resolved Compose graph must match a reviewed Dedicated service shape")
    ingress_mode(config)
    return config


def ingress_mode(config: dict[str, Any]) -> str:
    """Infer ingress custody from the reviewed graph and its mandatory external marker."""
    services = config.get("services")
    if not isinstance(services, dict) or set(services) not in ACCEPTED_SHAPES:
        fail("resolved Compose graph must match a reviewed Dedicated service shape")
    environment = services.get("gateway", {}).get("environment", {})
    if not isinstance(environment, dict):
        fail("gateway environment must be a resolved mapping")
    marker = environment.get("KALA_DEDICATED_INGRESS_MODE")
    graph_mode = "bundled-caddy" if "ingress" in services else "external"
    if graph_mode == "external" and marker != "external":
        fail("external ingress graph requires KALA_DEDICATED_INGRESS_MODE=external")
    if graph_mode == "bundled-caddy" and marker not in (None, "bundled-caddy"):
        fail("bundled ingress graph has an inconsistent dedicated ingress mode marker")
    if graph_mode == "external":
        if config.get("volumes") not in (None, {}):
            fail("external ingress graph may not declare named application volumes")
        if any(mount.get("type") == "volume" for service in services.values()
               for mount in service.get("volumes", [])):
            fail("external ingress graph may not mount named application volumes")
    return graph_mode


def require_external_fence(mode: str, args: argparse.Namespace) -> None:
    if mode == "external" and not getattr(args, "acknowledge_external_ingress_fenced", False):
        fail("external ingress lifecycle mutation requires explicit --acknowledge-external-ingress-fenced")


def artifact_ingress_mode(manifest: dict[str, Any]) -> str:
    schema = manifest.get("schemaVersion")
    if schema == ARTIFACT_SCHEMA:
        mode = manifest.get("ingressMode")
        expected = {"bundled-caddy": "included-in-app-backup", "external": "external-not-in-app-backup"}
        if mode not in expected or manifest.get("ingressIdentityCustody") != expected[mode]:
            fail("artifact v3 has inconsistent ingress mode or identity custody")
        return mode
    if schema in (BUNDLED_ARTIFACT_SCHEMA, LEGACY_ARTIFACT_SCHEMA):
        return "bundled-caddy"
    fail("unsupported backup manifest")


def require_matching_ingress_modes(archived: str, source: str, target: str) -> None:
    if len({archived, source, target}) != 1:
        fail("restore refuses cross-mode ingress custody; use a separate operator cutover and trust ceremony")


def image_map(config: dict[str, Any]) -> dict[str, str]:
    images = {name: service.get("image", "") for name, service in config["services"].items()}
    if any(not IMAGE.fullmatch(image) for image in images.values()):
        fail("all lifecycle images must use immutable name@sha256 provenance")
    return dict(sorted(images.items()))


def bind_source(config: dict[str, Any], service: str, target: str) -> Path:
    found = [mount.get("source") for mount in config["services"][service].get("volumes", [])
             if mount.get("type") == "bind" and mount.get("target") == target]
    if len(found) != 1 or not isinstance(found[0], str):
        fail(f"{service} must have exactly one reviewed bind mount at {target}")
    return Path(found[0]).resolve(strict=True)


def data_roots(config: dict[str, Any]) -> tuple[Path, Path]:
    return (bind_source(config, "postgres", "/var/lib/postgresql/data"),
            bind_source(config, "silo", "/data"))


def caddy_volume_specs(config: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Return the two reviewed Compose-owned ingress volumes without touching Docker."""
    project = config.get("name")
    declarations = config.get("volumes")
    if not isinstance(project, str) or not VOLUME_NAME.fullmatch(project) or not isinstance(declarations, dict):
        fail("resolved Compose must name one safe project and its Caddy volumes")
    expected_targets = {"caddy-data": "/data", "caddy-config": "/config"}
    found: dict[str, dict[str, str]] = {}
    ingress_mounts = config["services"]["ingress"].get("volumes", [])
    for prefix, target in expected_targets.items():
        matches = [mount for mount in ingress_mounts
                   if mount.get("type") == "volume" and mount.get("target") == target]
        if len(matches) != 1 or not isinstance(matches[0].get("source"), str):
            fail(f"ingress must have exactly one reviewed named volume at {target}")
        logical = matches[0]["source"]
        declaration = declarations.get(logical)
        if not VOLUME_NAME.fullmatch(logical) or not isinstance(declaration, dict):
            fail("Caddy volume source must be one normalized declared Compose volume")
        actual = declaration.get("name")
        driver = declaration.get("driver", "local")
        if not isinstance(actual, str) or not VOLUME_NAME.fullmatch(actual):
            fail("Caddy volume must resolve to a safe Docker volume name")
        if driver != "local" or declaration.get("driver_opts") or declaration.get("external"):
            fail("Caddy volumes must be non-external local-driver volumes without driver options")
        found[prefix] = {"project": project, "logicalName": logical, "volumeName": actual,
                         "target": target, "driver": "local"}
    if len({item["logicalName"] for item in found.values()}) != 2 \
            or len({item["volumeName"] for item in found.values()}) != 2:
        fail("Caddy data and config must use two distinct named volumes")
    if set(declarations) != {item["logicalName"] for item in found.values()}:
        fail("resolved Compose may declare only the two reviewed Caddy named volumes")
    allowed = {(item["logicalName"], item["target"]) for item in found.values()}
    for service_name, service in config["services"].items():
        for mount in service.get("volumes", []):
            if mount.get("type") == "volume" and (service_name != "ingress" or
                    (mount.get("source"), mount.get("target")) not in allowed):
                fail("named volumes may only mount at the two reviewed ingress Caddy targets")
    return found


def require_local_docker() -> Path:
    """Prove host-path volume access corresponds to a local Unix-socket daemon."""
    explicit = os.environ.get("DOCKER_HOST")
    result = run(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], timeout=30)
    try:
        context_host = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("Docker context endpoint is invalid")
    host = explicit or context_host
    if not isinstance(host, str) or not host.startswith("unix://"):
        fail("host filesystem lifecycle operations require a local Docker Unix-socket context")
    socket_path = Path(host[len("unix://"):])
    if not socket_path.is_absolute() or ".." in socket_path.parts:
        fail("Docker Unix socket path must be absolute and normalized")
    try:
        socket_info = socket_path.stat()
    except OSError as error:
        fail(f"Docker Unix socket is unavailable: {error.strerror}")
    if not stat.S_ISSOCK(socket_info.st_mode):
        fail("Docker endpoint is not a local Unix socket")
    result = run(["docker", "info", "--format", "{{json .DockerRootDir}}"], timeout=30)
    try:
        root_value = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("Docker root directory response is invalid")
    if not isinstance(root_value, str) or not Path(root_value).is_absolute():
        fail("local Docker daemon did not report an absolute data root")
    return Path(root_value).resolve(strict=True)


def inspect_volume(name: str) -> dict[str, Any]:
    result = run(["docker", "volume", "inspect", name, "--format", "{{json .}}"], timeout=30)
    try:
        document = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("Docker returned invalid named-volume metadata")
    if not isinstance(document, dict):
        fail("Docker returned malformed named-volume metadata")
    return document


def volume_exists(name: str) -> bool:
    try:
        result = subprocess.run(["docker", "volume", "inspect", name], text=True, capture_output=True,
                                timeout=30, check=False)
    except subprocess.TimeoutExpired:
        fail("bounded Docker volume preflight timed out")
    if result.returncode not in (0, 1):
        fail("Docker volume preflight failed; diagnostics withheld")
    return result.returncode == 0


def validated_volume_root(document: dict[str, Any], spec: dict[str, str], docker_root: Path) -> Path:
    labels = document.get("Labels")
    options = document.get("Options")
    if document.get("Name") != spec["volumeName"] or document.get("Driver") != "local" \
            or document.get("Scope") != "local" or options not in (None, {}) or not isinstance(labels, dict):
        fail("Caddy volume is not the exact local-driver volume declared by Compose")
    if labels.get("com.docker.compose.project") != spec["project"] \
            or labels.get("com.docker.compose.volume") != spec["logicalName"]:
        fail("Caddy volume does not belong to the exact reviewed Compose project/source")
    mountpoint = document.get("Mountpoint")
    if not isinstance(mountpoint, str):
        fail("Caddy volume has no local mountpoint")
    path = Path(mountpoint)
    try:
        info = path.lstat(); canonical = path.resolve(strict=True)
    except OSError as error:
        fail(f"Caddy volume mountpoint is unavailable: {error.strerror}")
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or canonical == Path(canonical.anchor) \
            or docker_root not in canonical.parents:
        fail("Caddy volume mountpoint is not a safe local Docker directory")
    return canonical


def source_caddy_roots(compose: Path, env: Path, config: dict[str, Any], docker_root: Path) \
        -> tuple[dict[str, Path], dict[str, dict[str, str]]]:
    specs = caddy_volume_specs(config)
    ingress_id = container_ids(compose, env, ("ingress",))["ingress"]
    inspected = run(["docker", "inspect", "--format", "{{json .Mounts}}", ingress_id], timeout=30)
    try:
        mounts = json.loads(inspected.stdout)
    except json.JSONDecodeError:
        fail("cannot verify deployed ingress mounts")
    if not isinstance(mounts, list):
        fail("deployed ingress mount metadata is malformed")
    roots: dict[str, Path] = {}
    for prefix, spec in specs.items():
        matches = [mount for mount in mounts if mount.get("Destination") == spec["target"]]
        if len(matches) != 1 or matches[0].get("Type") != "volume" \
                or matches[0].get("Name") != spec["volumeName"] or matches[0].get("Driver") != "local":
            fail("deployed ingress Caddy mount differs from the reviewed Compose volume")
        document = inspect_volume(spec["volumeName"])
        root = validated_volume_root(document, spec, docker_root)
        if Path(matches[0].get("Source", "")).resolve(strict=False) != root:
            fail("deployed ingress mountpoint differs from Docker volume provenance")
        roots[prefix] = root
    return roots, specs


def parse_ps(value: str) -> dict[str, dict[str, Any]]:
    value = value.strip()
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        rows = parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        try:
            rows = [json.loads(line) for line in value.splitlines() if line.strip()]
        except json.JSONDecodeError:
            fail("Docker Compose returned invalid service status JSON")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            fail("Docker Compose returned malformed service status")
        name = row.get("Service") or row.get("service")
        if name in ALL_SERVICES:
            result[name] = row
    return result


def service_state(row: dict[str, Any]) -> str:
    state = str(row.get("State") or row.get("state") or "unknown").lower()
    status = str(row.get("Status") or row.get("status") or "").lower()
    if "restarting" in status:
        return "restarting"
    if "paused" in status:
        return "paused"
    return state


def statuses(compose: Path, env: Path) -> dict[str, dict[str, Any]]:
    result = run(compose_command(compose, env) + ["ps", "--all", "--format", "json"], timeout=60)
    return parse_ps(result.stdout)


def assert_inactive(compose: Path, env: Path, names: set[str]) -> None:
    active = sorted(name for name, row in statuses(compose, env).items()
                    if name in names and service_state(row) in ACTIVE)
    if active:
        fail("writer isolation failed; active/restarting/paused services remain: " + ", ".join(active))


def container_ids(compose: Path, env: Path, names: tuple[str, ...]) -> dict[str, str]:
    found: dict[str, str] = {}
    for name in names:
        result = run(compose_command(compose, env) + ["ps", "--all", "-q", name], timeout=30)
        ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if len(ids) != 1:
            fail(f"{name} must have exactly one inspectable container before backup")
        found[name] = ids[0]
    return found


def verify_clean_data_stop(ids: dict[str, str]) -> None:
    for name, container_id in ids.items():
        result = run(["docker", "inspect", "--format", "{{json .State}}", container_id], timeout=30)
        try:
            state = json.loads(result.stdout)
        except json.JSONDecodeError:
            fail(f"cannot verify {name} shutdown state")
        if state.get("Running") or state.get("Paused") or state.get("Restarting"):
            fail(f"{name} did not stop")
        if state.get("OOMKilled") or state.get("ExitCode") != 0:
            fail(f"{name} did not shut down cleanly (non-zero/OOM state); no backup was completed")


def cold_stop(compose: Path, env: Path, timeout: int, services: set[str] = SERVICES) -> None:
    base = compose_command(compose, env)
    stopped: set[str] = set()
    if "ingress" in services:
        run(base + ["stop", "-t", str(timeout), "ingress"], timeout=timeout + 30)
        assert_inactive(compose, env, {"ingress"})
        stopped.add("ingress")
    run(base + ["stop", "-t", str(timeout), *APP_SERVICES], timeout=timeout + 30)
    stopped.update(APP_SERVICES)
    assert_inactive(compose, env, stopped)
    observation = sorted(services & OBSERVABILITY)
    if observation:
        run(base + ["stop", "-t", str(timeout), *observation], timeout=timeout + 30)
        assert_inactive(compose, env, set(observation))
    ids = container_ids(compose, env, ("postgres", "silo"))
    run(base + ["stop", "-t", str(timeout), "postgres", "silo"], timeout=timeout + 30)
    assert_inactive(compose, env, services)
    verify_clean_data_stop(ids)


def safe_relative(root: Path, relative: str, label: str) -> Path:
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts or any(part in ("", ".", "..") for part in pure.parts):
        fail(f"{label} must be a normalized relative path inside the recovery root")
    candidate = root.joinpath(*pure.parts)
    # The private, root-owned recovery root encloses container-UID-owned keys.
    info = candidate.lstat()
    if not stat.S_ISREG(info.st_mode) or candidate.is_symlink() or info.st_mode & 0o077:
        fail(f"{label} must be a private regular non-symlink file")
    canonical = candidate.resolve(strict=True)
    if root not in canonical.parents:
        fail(f"{label} escapes the recovery root")
    return canonical


def validate_tree(root: Path, label: str) -> None:
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in dirs + files:
            path = current_path / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                if os.path.isabs(target):
                    fail(f"{label} contains an absolute symbolic link")
                resolved = (path.parent / target).resolve(strict=False)
                if resolved != root and root not in resolved.parents:
                    fail(f"{label} contains a symbolic link escaping its root")
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                fail(f"{label} contains an unsupported special file")


def tar_tree(tar: tarfile.TarFile, root: Path, prefix: str, entries: list[dict[str, Any]]) -> None:
    validate_tree(root, prefix)
    paths = [root]
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs.sort(); files.sort()
        paths.extend(Path(current) / name for name in dirs + files)
    for path in paths:
        relative = path.relative_to(root)
        name = prefix if not relative.parts else f"{prefix}/{relative.as_posix()}"
        before = path.lstat()
        info = tarfile.TarInfo(name)
        info.mode = stat.S_IMODE(before.st_mode)
        info.uid, info.gid = before.st_uid, before.st_gid
        info.mtime = int(before.st_mtime)
        record: dict[str, Any] = {"name": name, "mode": info.mode, "uid": info.uid, "gid": info.gid}
        if stat.S_ISDIR(before.st_mode):
            info.type = tarfile.DIRTYPE
            record["type"] = "directory"
            tar.addfile(info)
        elif stat.S_ISLNK(before.st_mode):
            info.type = tarfile.SYMTYPE
            info.linkname = os.readlink(path)
            record.update(type="symlink", linkTarget=info.linkname)
            tar.addfile(info)
        elif stat.S_ISREG(before.st_mode):
            info.type = tarfile.REGTYPE
            info.size = before.st_size
            digest = hashlib.sha256()
            class HashingReader:
                def __init__(self, source: Any) -> None:
                    self.source = source
                def read(self, size: int = -1) -> bytes:
                    chunk = self.source.read(size)
                    digest.update(chunk)
                    return chunk
            with path.open("rb") as source:
                tar.addfile(info, HashingReader(source))
            after = path.lstat()
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != \
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                fail(f"{prefix} changed while archived; incomplete artifact retained")
            record.update(type="file", size=before.st_size, sha256=digest.hexdigest())
        else:
            fail(f"{prefix} contains an unsupported special file")
        entries.append(record)


def create_artifact(destination: Path, roots: dict[str, Path], metadata: dict[str, Any]) -> dict[str, Any]:
    mode = metadata.get("ingressMode")
    expected_roots = (BUNDLED_ARCHIVE_ROOTS if mode == "bundled-caddy" else
                      EXTERNAL_ARCHIVE_ROOTS if mode == "external" else None)
    if expected_roots is None or set(roots) != expected_roots:
        fail("artifact v3 roots must exactly match its declared ingress mode")
    provenance = metadata.get("sourceVolumeProvenance")
    if mode == "bundled-caddy" and (not isinstance(provenance, dict) or set(provenance) != {"caddy-data", "caddy-config"}):
        fail("bundled artifact v3 requires provenance for both Caddy volumes")
    if mode == "external" and provenance is not None:
        fail("external artifact v3 must not claim Caddy volume provenance")
    expected_custody = "included-in-app-backup" if mode == "bundled-caddy" else "external-not-in-app-backup"
    if metadata.get("ingressIdentityCustody") != expected_custody:
        fail("artifact v3 must explicitly describe ingress identity custody")
    metadata = {**metadata, "sourceRoots": {name: str(path) for name, path in roots.items()}}
    incomplete = destination.with_name(destination.name + ".incomplete")
    if destination.exists() or incomplete.exists():
        fail("backup destination or its incomplete state already exists; artifacts are never overwritten")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.parent.stat().st_mode & 0o077:
        fail("backup parent directory must be private")
    incomplete.mkdir(mode=0o700)
    payload = incomplete / "payload.tar"
    entries: list[dict[str, Any]] = []
    with payload.open("xb") as stream:
        os.chmod(payload, 0o600)
        with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for prefix, root in roots.items():
                tar_tree(tar, root, prefix, entries)
        stream.flush(); os.fsync(stream.fileno())
    manifest = {"schemaVersion": ARTIFACT_SCHEMA, "kind": "kala-dedicated-cold-backup",
                "createdUnix": int(time.time()), **metadata,
                "payloadSha256": sha256_file(payload), "entries": entries,
                "externalEffects": "unknown-no-replay"}
    encoded = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
    durable_write(incomplete / "manifest.json", encoded)
    durable_write(incomplete / "COMPLETED", (sha256_bytes(encoded) + "\n").encode())
    fsync_dir(incomplete)
    os.rename(incomplete, destination)
    fsync_dir(destination.parent)
    return manifest


# Fingerprint only authority-bearing credentials/config; host paths and public
# origin may legitimately change on restore. Values never enter the manifest.
AUTHORITY_ENV = {
    "postgres": ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"),
    "silo": ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"),
    "runtime": ("KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING",
                "KALA_RUNTIME_EXPERIMENTAL_S3_ACCESS_KEY_ID", "KALA_RUNTIME_EXPERIMENTAL_S3_SECRET_ACCESS_KEY",
                "KALA_RUNTIME_EXPERIMENTAL_S3_BUCKET", "KALA_RUNTIME_EXPERIMENTAL_S3_ENDPOINT",
                "KALA_INGRESS_SHARED_SECRET"),
    "gateway": ("KALA_INGRESS_DATABASE_URL", "KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING",
                "KALA_INGRESS_SESSION_SECRET", "KALA_INGRESS_SHARED_SECRET"),
}


def authority_configuration_sha256(config: dict[str, Any]) -> str:
    values = {}
    authority_env = dict(AUTHORITY_ENV)
    if "otel-collector" in config.get("services", {}):
        # New telemetry lifecycle operations fail closed. Old non-telemetry
        # records retain their original fingerprint; legacy telemetry graphs
        # lacking these authorities must be explicitly republished first.
        authority_env["otel-collector"] = ("KALA_OBSERVABILITY_POSTGRES_PASSWORD",
                                            "KALA_OBSERVABILITY_SILO_METRICS_TOKEN")
    for service, keys in authority_env.items():
        environment = config["services"][service].get("environment", {})
        if any(not isinstance(environment.get(key), str) or not environment[key] for key in keys):
            fail("authority credentials must use the reviewed explicit Dedicated configuration")
        values[service] = {key: environment[key] for key in keys}
    return sha256_bytes(json.dumps(values, sort_keys=True, separators=(",", ":")).encode())


def verify_deployed_configuration(compose: Path, env: Path, config: dict[str, Any]) -> None:
    """A staged .env is not proof of what actually wrote the archived authorities."""
    ids = container_ids(compose, env, tuple(sorted(config["services"])))
    fingerprinted_services = set(AUTHORITY_ENV)
    if "otel-collector" in config["services"]:
        fingerprinted_services.add("otel-collector")
    actual = {"services": {name: {"environment": {}} for name in fingerprinted_services}}
    for name, container_id in ids.items():
        inspected = run(["docker", "inspect", "--format", '{"image":{{json .Config.Image}},"env":{{json .Config.Env}}}', container_id], timeout=30)
        document = json.loads(inspected.stdout)
        if document.get("image") != config["services"][name]["image"]:
            fail("deployed images differ from the reviewed backup configuration")
        if name in fingerprinted_services:
            actual["services"][name]["environment"] = dict(item.split("=", 1) for item in document.get("env", []) if "=" in item)
    if authority_configuration_sha256(actual) != authority_configuration_sha256(config):
        fail("deployed authority credentials differ from the protected recovery configuration")


def validate_recovery_material(config: dict[str, Any], compose: Path, env: Path,
                               recovery: Path, installation: Path, state_key: Path) -> None:
    """Prove this bundle contains the actual mounted materials, not lookalike files."""
    for path in (compose, env):
        if recovery not in path.parents:
            fail("Compose and its protected parameter file must be inside the recovery root")
    if bind_source(config, "runtime", "/run/kala-secrets/installation-id") != installation \
            or bind_source(config, "gateway", "/run/kala-secrets/installation-id") != installation \
            or bind_source(config, "runtime", "/run/kala-secrets/runtime-state-master-key") != state_key:
        fail("recovery identity/key must be the exact files mounted by the running installation")
    authorities = set(data_roots(config))
    for service in config["services"].values():
        for mount in service.get("volumes", []):
            if mount.get("type") != "bind":
                continue
            source = Path(mount["source"]).resolve(strict=True)
            if source not in authorities and recovery not in source.parents:
                fail("every configuration/secret bind must be enclosed by the recovery root")


def perform_backup(args: argparse.Namespace) -> dict[str, Any]:
    # Reject preventable destination errors before fencing a running product.
    # create_artifact rechecks permissions immediately before writing as well.
    safe_root(Path(args.artifact).absolute().parent, "backup parent directory")
    compose = private_regular(Path(args.compose), "Compose file")
    env = private_regular(Path(args.env), "Compose parameter file")
    recovery = safe_root(Path(args.recovery_root), "recovery material root")
    installation = safe_relative(recovery, args.installation_id_relative, "installation identity")
    state_key = safe_relative(recovery, args.state_key_relative, "state master key")
    verify_topology(compose, env)
    config = compose_config(compose, env)
    mode = ingress_mode(config)
    require_external_fence(mode, args)
    docker_root = require_local_docker()
    postgres, silo = data_roots(config)
    postgres = safe_root(postgres, "PostgreSQL data root", root_owned=False)
    silo = safe_root(silo, "SILO data root", root_owned=False)
    caddy_roots: dict[str, Path] = {}
    caddy_specs: dict[str, dict[str, str]] | None = None
    if mode == "bundled-caddy":
        caddy_roots, caddy_specs = source_caddy_roots(compose, env, config, docker_root)
    all_roots = {"postgres": postgres, "silo": silo, "recovery": recovery, **caddy_roots}
    disjoint(list(all_roots.values()), "data, Caddy and recovery roots")
    artifact = Path(args.artifact).absolute()
    if artifact.exists() or artifact.with_name(artifact.name + ".incomplete").exists():
        fail("backup artifact or incomplete state already exists")
    canonical_artifact = artifact.resolve(strict=False)
    for root in all_roots.values():
        if canonical_artifact == root or root in canonical_artifact.parents or canonical_artifact in root.parents:
            fail("backup artifact must be disjoint from all archived roots")
    pg_path = postgres / "PG_VERSION"
    pg_info = pg_path.lstat()
    if not stat.S_ISREG(pg_info.st_mode) or pg_path.is_symlink():
        fail("PostgreSQL PG_VERSION must be a regular non-symlink file")
    pg_version = pg_path.read_text().strip()
    if not re.fullmatch(r"[1-9][0-9]*", pg_version):
        fail("PostgreSQL PG_VERSION is invalid")
    validate_recovery_material(config, compose, env, recovery, installation, state_key)
    verify_deployed_configuration(compose, env, config)
    cold_stop(compose, env, args.stop_timeout, set(config["services"]))
    metadata: dict[str, Any] = {
        "images": image_map(config), "postgresMajor": pg_version,
        "ingressMode": mode,
        "ingressIdentityCustody": ("included-in-app-backup" if mode == "bundled-caddy" else
                                   "external-not-in-app-backup"),
        "authorityConfigurationSha256": authority_configuration_sha256(config),
        "parameterFileRelative": env.relative_to(recovery).as_posix(),
        "parameterFileSha256": sha256_file(env),
        "installationIdSha256": sha256_file(installation), "stateMasterKeySha256": sha256_file(state_key),
        "sourceRoots": {name: str(path) for name, path in all_roots.items()},
    }
    if caddy_specs is not None:
        metadata["sourceVolumeProvenance"] = caddy_specs
    return create_artifact(Path(args.artifact), all_roots, metadata)


def backup(args: argparse.Namespace) -> dict[str, Any]:
    manifest = perform_backup(args)
    return {"event": "cold_backup_completed_stopped", "artifact": str(Path(args.artifact)),
            "entryCount": len(manifest["entries"]), "postgresMajor": manifest["postgresMajor"],
            "externalEffects": "unknown-no-replay"}


def read_artifact(path: Path, acknowledge_legacy: bool = False) -> tuple[dict[str, Any], Path]:
    root = safe_root(path, "backup artifact")
    manifest_path = private_regular(root / "manifest.json", "backup manifest")
    payload = private_regular(root / "payload.tar", "backup payload")
    completed = private_regular(root / "COMPLETED", "backup completion marker")
    encoded = manifest_path.read_bytes()
    if completed.read_text().strip() != sha256_bytes(encoded):
        fail("backup completion marker does not authenticate the manifest")
    try:
        manifest = json.loads(encoded)
    except json.JSONDecodeError:
        fail("backup manifest is invalid JSON")
    schema = manifest.get("schemaVersion")
    if schema not in (ARTIFACT_SCHEMA, BUNDLED_ARTIFACT_SCHEMA, LEGACY_ARTIFACT_SCHEMA) \
            or manifest.get("kind") != "kala-dedicated-cold-backup":
        fail("unsupported backup manifest")
    if schema == LEGACY_ARTIFACT_SCHEMA and not acknowledge_legacy:
        fail("legacy artifact v1 omitted Caddy identity; use --acknowledge-ingress-identity-reissue only for an accepted trust reset")
    artifact_ingress_mode(manifest)
    if manifest.get("payloadSha256") != sha256_file(payload):
        fail("backup payload checksum mismatch")
    return manifest, payload


def load_policy(path: Path) -> dict[str, Any]:
    policy_path = private_regular(path, "reviewed compatibility policy")
    try:
        policy = json.loads(policy_path.read_text())
    except json.JSONDecodeError:
        fail("compatibility policy is invalid JSON")
    required = {"schemaVersion", "reviewId", "predecessorImages", "targetImages", "postgresMajor", "migrationMode"}
    if set(policy) != required or policy["schemaVersion"] != POLICY_SCHEMA or not isinstance(policy["reviewId"], str) \
            or not policy["reviewId"].strip():
        fail("compatibility policy has an unsupported shape")
    if policy["migrationMode"] != "none":
        fail("this operator refuses schema migration; only an independently reviewed existing Dedicated migration path may add support")
    for key in ("predecessorImages", "targetImages"):
        images = policy[key]
        if not isinstance(images, dict) or set(images) not in ACCEPTED_SHAPES or any(not IMAGE.fullmatch(v) for v in images.values()):
            fail(f"compatibility policy {key} must pin exactly one reviewed graph of immutable images")
    if not re.fullmatch(r"[1-9][0-9]*", str(policy["postgresMajor"])):
        fail("compatibility policy PostgreSQL major is invalid")
    return policy


def normalized_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        fail("archive contains a traversal or non-normalized member")
    if path.parts[0] not in ARCHIVE_ROOTS:
        fail("archive contains an unknown top-level member")
    return path


def validate_archive(manifest: dict[str, Any], payload: Path) -> tuple[list[tarfile.TarInfo], dict[str, dict[str, Any]]]:
    schema = manifest.get("schemaVersion")
    mode = artifact_ingress_mode(manifest)
    expected_roots = (EXTERNAL_ARCHIVE_ROOTS if schema == LEGACY_ARTIFACT_SCHEMA else
                      BUNDLED_ARCHIVE_ROOTS if mode == "bundled-caddy" else EXTERNAL_ARCHIVE_ROOTS)
    source_roots = manifest.get("sourceRoots")
    if not isinstance(source_roots, dict) or set(source_roots) != expected_roots \
            or any(not isinstance(value, str) or not Path(value).is_absolute() or str(Path(value)) != value
                   for value in source_roots.values()):
        fail("backup source-root provenance does not exactly match its artifact schema")
    provenance = manifest.get("sourceVolumeProvenance")
    if schema in (ARTIFACT_SCHEMA, BUNDLED_ARTIFACT_SCHEMA) and mode == "bundled-caddy":
        if not isinstance(provenance, dict) or set(provenance) != {"caddy-data", "caddy-config"}:
            fail("artifact v2 lacks complete Caddy source-volume provenance")
        for prefix, spec in provenance.items():
            if not isinstance(spec, dict) or set(spec) != {"project", "logicalName", "volumeName", "target", "driver"} \
                    or spec.get("driver") != "local" or spec.get("target") != ({"caddy-data": "/data", "caddy-config": "/config"})[prefix] \
                    or any(not isinstance(spec.get(key), str) or not VOLUME_NAME.fullmatch(spec[key])
                           for key in ("project", "logicalName", "volumeName")):
                fail("bundled artifact Caddy source-volume provenance is malformed")
    elif provenance is not None:
        fail("artifact without bundled Caddy state has unexpected volume provenance")
    records = manifest.get("entries")
    if not isinstance(records, list):
        fail("backup manifest has no entry inventory")
    by_name = {record.get("name"): record for record in records if isinstance(record, dict)}
    if len(by_name) != len(records) or None in by_name:
        fail("backup manifest has duplicate or malformed entries")
    prefixes = {PurePosixPath(name).parts[0] for name in by_name if isinstance(name, str) and PurePosixPath(name).parts}
    if prefixes != expected_roots or any(by_name.get(root, {}).get("type") != "directory" for root in expected_roots):
        fail("backup archive does not contain every required schema root")
    with tarfile.open(payload, "r:") as tar:
        members = tar.getmembers()
        if {member.name for member in members} != set(by_name) or len(members) != len(by_name):
            fail("archive inventory differs from the durable manifest")
        for member in members:
            path = normalized_member(member.name)
            record = by_name[member.name]
            kind = "directory" if member.isdir() else "file" if member.isfile() else "symlink" if member.issym() else "unsupported"
            if kind != record.get("type") or member.mode != record.get("mode") or member.uid != record.get("uid") or member.gid != record.get("gid"):
                fail("archive metadata differs from the durable manifest")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or record.get("linkTarget") != member.linkname:
                    fail("archive contains an unsafe symbolic link")
                resolved = PurePosixPath(os.path.normpath(str(path.parent / target)))
                if not resolved.parts or resolved.parts[0] != path.parts[0] or ".." in resolved.parts:
                    fail("archive symbolic link escapes its source root")
            elif member.isfile():
                stream = tar.extractfile(member)
                if stream is None:
                    fail("archive regular file is unreadable")
                digest = hashlib.sha256()
                size = 0
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
                if size != record.get("size") or digest.hexdigest() != record.get("sha256"):
                    fail("archive file checksum mismatch")
            elif not member.isdir():
                fail("archive contains an unsupported link or special file")
    return members, by_name


def extract_archive(payload: Path, destinations: dict[str, Path], records: dict[str, dict[str, Any]]) -> None:
    directory_metadata: list[tuple[Path, dict[str, Any]]] = []
    with tarfile.open(payload, "r:") as tar:
        for member in tar.getmembers():
            pure = normalized_member(member.name)
            root = destinations[pure.parts[0]]
            relative = pure.parts[1:]
            target = root.joinpath(*relative) if relative else root
            record = records[member.name]
            if member.isdir():
                if relative:
                    target.mkdir(mode=0o700)
                directory_metadata.append((target, record))
            elif member.isfile():
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                source = tar.extractfile(member)
                assert source is not None
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(target, flags, 0o600)
                with os.fdopen(fd, "wb") as output:
                    shutil.copyfileobj(source, output)
                    output.flush(); os.fsync(output.fileno())
                os.chown(target, record["uid"], record["gid"], follow_symlinks=False)
                os.chmod(target, record["mode"], follow_symlinks=False)
            elif member.issym():
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                os.symlink(member.linkname, target)
                os.chown(target, record["uid"], record["gid"], follow_symlinks=False)
    for target, record in reversed(directory_metadata):
        os.chown(target, record["uid"], record["gid"], follow_symlinks=False)
        os.chmod(target, record["mode"], follow_symlinks=False)
    for root in destinations.values():
        fsync_dir(root)


def create_fresh_caddy_volumes(specs: dict[str, dict[str, str]], docker_root: Path) -> dict[str, Path]:
    roots: dict[str, Path] = {}
    for prefix, spec in specs.items():
        creation_token = secrets.token_hex(32)
        run(["docker", "volume", "create", "--driver", "local",
             "--label", f"com.docker.compose.project={spec['project']}",
             "--label", f"com.docker.compose.volume={spec['logicalName']}",
             "--label", "com.docker.compose.version=kala-lifecycle-operator-v2",
             "--label", f"com.kala.lifecycle.fresh-restore={creation_token}",
             spec["volumeName"]], timeout=30)
        document = inspect_volume(spec["volumeName"])
        if document.get("Labels", {}).get("com.kala.lifecycle.fresh-restore") != creation_token:
            fail("Caddy volume creation raced with an existing volume; partial new destinations were retained")
        root = validated_volume_root(document, spec, docker_root)
        if any(root.iterdir()):
            fail("newly created Caddy volume is not empty; partial new destinations were retained")
        roots[prefix] = root
    return roots


def restore(args: argparse.Namespace) -> dict[str, Any]:
    if not args.acknowledge_source_fenced:
        fail("restore requires explicit --acknowledge-source-fenced")
    acknowledge_legacy = getattr(args, "acknowledge_ingress_identity_reissue", False)
    source_compose = private_regular(Path(args.source_compose), "source Compose file")
    source_env = private_regular(Path(args.source_env), "source Compose parameter file")
    manifest, payload = read_artifact(Path(args.artifact), acknowledge_legacy)
    policy = load_policy(Path(args.policy))
    target_compose = private_regular(Path(args.target_compose), "restore target Compose file")
    target_env = private_regular(Path(args.target_env), "restore target Compose parameter file")
    source_config = compose_config(source_compose, source_env)
    target_config = compose_config(target_compose, target_env)
    mode = artifact_ingress_mode(manifest)
    require_matching_ingress_modes(mode, ingress_mode(source_config), ingress_mode(target_config))
    require_external_fence(mode, args)
    create_caddy = getattr(args, "create_fresh_caddy_volumes", False)
    if mode == "bundled-caddy" and not create_caddy:
        fail("bundled restore requires explicit --create-fresh-caddy-volumes")
    if mode == "external" and create_caddy:
        fail("external restore rejects --create-fresh-caddy-volumes because TLS identity is outside app custody")
    docker_root = require_local_docker()
    assert_inactive(source_compose, source_env, set(source_config["services"]))
    assert_inactive(target_compose, target_env, set(target_config["services"]))
    if manifest.get("images") != policy["predecessorImages"] or str(manifest.get("postgresMajor")) != str(policy["postgresMajor"]):
        fail("backup provenance is not an exact compatible predecessor in the reviewed policy")
    if image_map(target_config) != policy["targetImages"]:
        fail("restore target images do not exactly match the reviewed compatibility policy")
    if authority_configuration_sha256(target_config) != manifest.get("authorityConfigurationSha256"):
        fail("restore target authority credentials differ from the protected backup configuration")
    members, records = validate_archive(manifest, payload)
    parameter_relative = manifest.get("parameterFileRelative")
    if not isinstance(parameter_relative, str):
        fail("backup lacks the required parameter-file provenance")
    parameter_path = normalized_member("recovery/" + parameter_relative)
    parameter_record = records.get(parameter_path.as_posix(), {})
    if parameter_record.get("type") != "file" or parameter_record.get("sha256") != manifest.get("parameterFileSha256"):
        fail("backup parameter-file provenance differs from its protected inventory")
    del members
    destinations = {
        "postgres": safe_root(Path(args.postgres_destination), "fresh PostgreSQL destination", empty=True),
        "silo": safe_root(Path(args.silo_destination), "fresh SILO destination", empty=True),
        "recovery": safe_root(Path(args.recovery_destination), "fresh recovery-material destination", empty=True),
    }
    disjoint(list(destinations.values()), "restore destinations")
    if data_roots(target_config) != (destinations["postgres"], destinations["silo"]):
        fail("restore target Compose must bind the explicit fresh PostgreSQL and SILO destinations")
    source_roots = [Path(value) for value in manifest["sourceRoots"].values()]
    for destination in destinations.values():
        for source in source_roots:
            if destination == source or destination in source.parents or source in destination.parents:
                fail("restore destination must be disjoint from every old source root")
    if mode == "bundled-caddy":
        target_specs = caddy_volume_specs(target_config)
        if manifest["schemaVersion"] in (ARTIFACT_SCHEMA, BUNDLED_ARTIFACT_SCHEMA):
            source_names = {item["volumeName"] for item in manifest["sourceVolumeProvenance"].values()}
            if source_names & {item["volumeName"] for item in target_specs.values()}:
                fail("restore target must use two new Caddy volume names, never a source volume")
        for spec in target_specs.values():
            if volume_exists(spec["volumeName"]):
                fail("restore target Caddy volume already exists; only automatic fresh creation is authorized")
        # Every non-mutating preflight above completes before either volume is created or any archive byte is extracted.
        destinations.update(create_fresh_caddy_volumes(target_specs, docker_root))
    disjoint(list(destinations.values()), "restore destinations")
    extract_archive(payload, destinations, records)
    if (destinations["postgres"] / "PG_VERSION").read_text().strip() != str(policy["postgresMajor"]):
        fail("restored PostgreSQL major differs from reviewed compatibility policy")
    # The shared topology validator reads restored bind files, so this is a postcondition rather than a preflight.
    verify_topology(target_compose, target_env)
    installation = bind_source(target_config, "runtime", "/run/kala-secrets/installation-id")
    state_key = bind_source(target_config, "runtime", "/run/kala-secrets/runtime-state-master-key")
    deployment = bind_source(target_config, "runtime", "/etc/kala/deployment.json")
    if any(path != destinations["recovery"] and destinations["recovery"] not in path.parents
           for path in (installation, state_key, deployment)):
        fail("restore target identity, state key and deployment configuration must come from the restored recovery root")
    if sha256_file(installation) != manifest.get("installationIdSha256") or sha256_file(state_key) != manifest.get("stateMasterKeySha256"):
        fail("restored data/secrets identity differs from the backup manifest")
    legacy = manifest["schemaVersion"] == LEGACY_ARTIFACT_SCHEMA
    identity = ("external-not-restored" if mode == "external" else
                "reissue-required-legacy-v1" if legacy else "preserved-from-artifact")
    return {"event": "cold_restore_completed_stopped", "reviewId": policy["reviewId"],
            "targetImages": policy["targetImages"], "externalEffects": "unknown-no-replay",
            "ingressIdentity": identity,
            "warning": ("legacy v1 restored without Caddy state; redistribute trust before start" if legacy else
                        "restored services were not started; keep old source fenced")}


def preflight_pair(current_compose: Path, current_env: Path, target_compose: Path, target_env: Path,
                   policy: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    verify_topology(current_compose, current_env); verify_topology(target_compose, target_env)
    current = compose_config(current_compose, current_env); target = compose_config(target_compose, target_env)
    if image_map(current) != policy["predecessorImages"] or image_map(target) != policy["targetImages"]:
        fail("current/target images do not exactly match the reviewed predecessor policy")
    if authority_configuration_sha256(current) != authority_configuration_sha256(target):
        fail("upgrade cannot rotate PG/SILO/session/shared credentials; use a separately verified provider-specific ceremony")
    if data_roots(current) != data_roots(target):
        fail("in-place upgrade target must use the exact existing PostgreSQL and SILO roots")
    current_mode = ingress_mode(current)
    if current_mode != ingress_mode(target):
        fail("in-place upgrade refuses cross-mode ingress custody")
    if current_mode == "bundled-caddy" and caddy_volume_specs(current) != caddy_volume_specs(target):
        fail("in-place upgrade target must retain the exact existing Caddy data and config volumes")
    pg_version = (data_roots(current)[0] / "PG_VERSION").read_text().strip()
    if pg_version != str(policy["postgresMajor"]):
        fail("existing PostgreSQL major differs from reviewed policy")
    for service, mount in (("runtime", "/etc/kala/deployment.json"), ("runtime", "/run/kala-secrets/runtime-state-master-key"),
                           ("runtime", "/run/kala-secrets/installation-id"), ("gateway", "/etc/kala/deployment.json"),
                           ("gateway", "/run/kala-secrets/installation-id")):
        if bind_source(current, service, mount) != bind_source(target, service, mount):
            fail("upgrade target must retain the exact protected deployment identity/configuration mounts")
    return current, target


def upgrade_preflight(args: argparse.Namespace) -> dict[str, Any]:
    policy = load_policy(Path(args.policy))
    current_compose = private_regular(Path(args.current_compose), "current Compose file")
    current_env = private_regular(Path(args.current_env), "current Compose parameter file")
    target_compose = private_regular(Path(args.target_compose), "target Compose file")
    target_env = private_regular(Path(args.target_env), "target Compose parameter file")
    preflight_pair(current_compose, current_env, target_compose, target_env, policy)
    return {"event": "upgrade_preflight_accepted", "reviewId": policy["reviewId"],
            "migrationMode": "none", "warning": "maintenance and a completed cold backup are still required"}


def upgrade(args: argparse.Namespace) -> dict[str, Any]:
    if not args.acknowledge_maintenance_and_unknown_effects:
        fail("upgrade requires explicit maintenance/unknown-external-effects acknowledgement")
    policy = load_policy(Path(args.policy))
    current_compose = private_regular(Path(args.current_compose), "current Compose file")
    current_env = private_regular(Path(args.current_env), "current Compose parameter file")
    target_compose = private_regular(Path(args.target_compose), "target Compose file")
    target_env = private_regular(Path(args.target_env), "target Compose parameter file")
    current_config, target_config = preflight_pair(current_compose, current_env, target_compose, target_env, policy)
    require_external_fence(ingress_mode(current_config), args)
    if current_compose.parent != target_compose.parent:
        assert_inactive(target_compose, target_env, set(target_config["services"]))
    backup_args = argparse.Namespace(compose=str(current_compose), env=str(current_env), recovery_root=args.recovery_root,
        installation_id_relative=args.installation_id_relative, state_key_relative=args.state_key_relative,
        artifact=args.artifact, stop_timeout=args.stop_timeout,
        acknowledge_external_ingress_fenced=getattr(args, "acknowledge_external_ingress_fenced", False))
    manifest = perform_backup(backup_args)
    if manifest.get("images") != policy["predecessorImages"]:
        fail("completed maintenance backup provenance changed after preflight")
    try:
        run(compose_command(target_compose, target_env) + ["up", "-d", "--wait", "--wait-timeout", str(args.start_timeout)],
            timeout=args.start_timeout + 60)
    except OperatorError:
        fail("target startup failed after a completed backup; no automatic rollback/replay was attempted")
    return {"event": "upgrade_completed", "reviewId": policy["reviewId"], "backupArtifact": str(Path(args.artifact)),
            "externalEffects": "unknown-no-replay"}


def status(args: argparse.Namespace) -> dict[str, Any]:
    compose = private_regular(Path(args.compose), "Compose file")
    env = private_regular(Path(args.env), "Compose parameter file")
    config = compose_config(compose, env)
    rows = statuses(compose, env)
    result: dict[str, Any] = {"event": "dedicated_lifecycle_status", "ingressMode": ingress_mode(config),
        "services": {}, "storage": {},
        "warning": "point-in-time operator diagnostics, not continuous alerting or external-effect settlement"}
    for name in sorted(config["services"]):
        row = rows.get(name, {})
        entry: dict[str, Any] = {"state": service_state(row)}
        container_id = row.get("ID", "")
        if isinstance(container_id, str) and re.fullmatch(r"[0-9a-f]{12,64}", container_id):
            inspected = run(["docker", "inspect", "--format", '{"state":{{json .State}},"restartCount":{{.RestartCount}}}', container_id], timeout=30)
            document = json.loads(inspected.stdout)
            state = document["state"]
            entry.update(exitCode=state.get("ExitCode"), oomKilled=state.get("OOMKilled"),
                         restartCount=document.get("restartCount"), health=state.get("Health", {}).get("Status", "none"))
        result["services"][name] = entry
    for name, root in zip(("postgres", "silo"), data_roots(config)):
        usage = os.statvfs(root)
        result["storage"][name] = {"availableBytes": usage.f_bavail * usage.f_frsize,
                                   "totalBytes": usage.f_blocks * usage.f_frsize,
                                   "availableInodes": usage.f_favail, "totalInodes": usage.f_files}
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            memory[key + "Bytes"] = int(value.strip().split()[0]) * 1024
    result["hostMemory"] = memory
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Dedicated cold backup/recovery and reviewed no-migration upgrade operator")
    result.add_argument("--lock-file", default="/run/kala-dedicated/lifecycle.lock")
    sub = result.add_subparsers(dest="command", required=True)
    def compose_args(item: argparse.ArgumentParser, prefix: str = "") -> None:
        item.add_argument(f"--{prefix}compose", required=True); item.add_argument(f"--{prefix}env", required=True)
    stat_parser = sub.add_parser("status"); compose_args(stat_parser)
    backup_parser = sub.add_parser("backup"); compose_args(backup_parser)
    for item in (backup_parser,):
        item.add_argument("--recovery-root", required=True); item.add_argument("--installation-id-relative", required=True)
        item.add_argument("--state-key-relative", required=True); item.add_argument("--artifact", required=True)
        item.add_argument("--stop-timeout", type=int, default=120, choices=range(10, 901), metavar="10..900")
        item.add_argument("--acknowledge-external-ingress-fenced", action="store_true")
    restore_parser = sub.add_parser("restore"); compose_args(restore_parser, "source-"); compose_args(restore_parser, "target-")
    restore_parser.add_argument("--artifact", required=True); restore_parser.add_argument("--policy", required=True)
    restore_parser.add_argument("--postgres-destination", required=True); restore_parser.add_argument("--silo-destination", required=True)
    restore_parser.add_argument("--recovery-destination", required=True); restore_parser.add_argument("--acknowledge-source-fenced", action="store_true")
    restore_parser.add_argument("--create-fresh-caddy-volumes", action="store_true")
    restore_parser.add_argument("--acknowledge-ingress-identity-reissue", action="store_true")
    restore_parser.add_argument("--acknowledge-external-ingress-fenced", action="store_true")
    preflight = sub.add_parser("upgrade-preflight")
    upgrade_parser = sub.add_parser("upgrade")
    for item in (preflight, upgrade_parser):
        compose_args(item, "current-"); compose_args(item, "target-"); item.add_argument("--policy", required=True)
    upgrade_parser.add_argument("--recovery-root", required=True); upgrade_parser.add_argument("--installation-id-relative", required=True)
    upgrade_parser.add_argument("--state-key-relative", required=True); upgrade_parser.add_argument("--artifact", required=True)
    upgrade_parser.add_argument("--stop-timeout", type=int, default=120, choices=range(10, 901), metavar="10..900")
    upgrade_parser.add_argument("--start-timeout", type=int, default=300, choices=range(10, 901), metavar="10..900")
    upgrade_parser.add_argument("--acknowledge-maintenance-and-unknown-effects", action="store_true")
    upgrade_parser.add_argument("--acknowledge-external-ingress-fenced", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    require_root()
    functions = {"status": status, "backup": backup, "restore": restore,
                 "upgrade-preflight": upgrade_preflight, "upgrade": upgrade}
    try:
        with host_lock(Path(args.lock_file)):
            output = functions[args.command](args)
        print(json.dumps(output, sort_keys=True))
    except OperatorError as error:
        print(f"Dedicated lifecycle refused: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
