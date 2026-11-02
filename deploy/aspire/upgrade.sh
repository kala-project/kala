#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
operator="$(cd "$(dirname "$0")" && pwd)/lifecycle_operator.py"
case "${1:-}" in
  preflight) shift; exec python3 "$operator" upgrade-preflight "$@" ;;
  apply) shift; exec python3 "$operator" upgrade "$@" ;;
  *) echo "usage: $0 {preflight|apply} ..." >&2; exit 2 ;;
esac
