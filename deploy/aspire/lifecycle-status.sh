#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
exec python3 "$(cd "$(dirname "$0")" && pwd)/lifecycle_operator.py" status "$@"
