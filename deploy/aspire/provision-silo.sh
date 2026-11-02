#!/bin/sh
set -eu
umask 077
root=/run/kala-init-secrets
read_secret() {
  test -f "$root/$1" && test ! -L "$root/$1" || { echo "$1 must be a regular file" >&2; exit 1; }
  value=$(cat "$root/$1")
  test -n "$value" || { echo "$1 is empty" >&2; exit 1; }
  printf %s "$value"
}
root_access=$(read_secret silo_root_access_key)
root_secret=$(read_secret silo_root_secret_key)
runtime_access=$(read_secret runtime_s3_access_key)
runtime_secret=$(read_secret runtime_s3_secret_key)
# One SILO instance and one Runtime bucket belong to this fresh Dedicated installation.
# Do not mount installation, PostgreSQL or state-key files in the mc container.
policy="kala-runtime"

# The temporary mc configuration is in the disposable container filesystem.
for attempt in $(seq 1 30); do
  if mc alias set local http://silo:9000 "$root_access" "$root_secret" >/dev/null 2>&1 \
      && mc ready local >/dev/null 2>&1; then break; fi
  test "$attempt" -lt 30 || { echo 'SILO did not become ready' >&2; exit 1; }
  sleep 2
done
mc mb --ignore-existing local/kala-runtime >/dev/null
mc version enable local/kala-runtime >/dev/null
mc anonymous set none local/kala-runtime >/dev/null
mc admin policy create local "$policy" /operator/runtime-s3-policy.json >/dev/null
mc admin user add local "$runtime_access" "$runtime_secret" >/dev/null
mc admin policy attach local "$policy" --user "$runtime_access" >/dev/null
printf '%s\n' '{"event":"aspire_silo_provisioned","bucket":"kala-runtime"}'
