#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  echo "usage: $0 <docker-compose.yaml> <published.env> <protected-secrets-directory> [--initialize-only|--resume-initialized]" >&2
  exit 2
}
[[ $# -eq 3 || $# -eq 4 ]] || usage
[[ ${4:-} == "" || ${4:-} == "--initialize-only" || ${4:-} == "--resume-initialized" ]] || usage
(( EUID == 0 )) || { echo 'Run Dedicated initialization as the root operator; protected files are root-owned' >&2; exit 1; }
compose_file=$(realpath "$1")
env_file=$(realpath "$2")
export KALA_ASPIRE_SECRETS_DIR
KALA_ASPIRE_SECRETS_DIR=$(realpath "$3")
export KALA_ASPIRE_INIT_DIR
KALA_ASPIRE_INIT_DIR=$(cd "$(dirname "$0")" && pwd)
operation_mode=${4:-}
start_timeout=${KALA_ASPIRE_START_TIMEOUT_SECONDS:-180}
[[ $start_timeout =~ ^[1-9][0-9]{0,2}$ ]] && (( start_timeout >= 1 && start_timeout <= 900 )) || {
  echo 'KALA_ASPIRE_START_TIMEOUT_SECONDS must be between 1 and 900' >&2; exit 2;
}
[[ -f $compose_file && -f $env_file && -d $KALA_ASPIRE_SECRETS_DIR ]] || usage
[[ ${KALA_MC_IMAGE:-} =~ ^[^[:space:]]+@sha256:[0-9a-fA-F]{64}$ ]] || {
  echo 'KALA_MC_IMAGE must be a reviewed immutable mc-capable name@sha256 digest' >&2; exit 2;
}
[[ -n ${KALA_DEDICATED_ORGANIZATION_NAME:-} ]] || {
  echo 'KALA_DEDICATED_ORGANIZATION_NAME is required' >&2; exit 2;
}

[[ $(stat -c '%u' "$KALA_ASPIRE_SECRETS_DIR") == 0 ]] || {
  echo 'Protected initialization directory must be root-owned' >&2; exit 1;
}
secret_directory_mode=$(stat -c '%a' "$KALA_ASPIRE_SECRETS_DIR")
(( (8#$secret_directory_mode & 077) == 0 )) || {
  echo 'Protected initialization directory must not be accessible by group or other users' >&2; exit 1;
}

required=(postgres_admin_url control_owner_url gateway_database_url runtime_owner_url runtime_database_url
  runtime_reader_database_url silo_root_access_key silo_root_secret_key runtime_s3_access_key runtime_s3_secret_key
  installation_id runtime_state_master_key owner_password)
for name in "${required[@]}"; do
  path=$KALA_ASPIRE_SECRETS_DIR/$name
  [[ -f $path && ! -L $path ]] || { echo "$name must be a regular non-symlink file" >&2; exit 1; }
  [[ $(stat -c '%u' "$path") == 0 ]] || {
    echo "$name must be root-owned for capability-restricted initialization jobs" >&2; exit 1;
  }
  file_mode=$(stat -c '%a' "$path")
  (( (8#$file_mode & 077) == 0 )) || { echo "$name must not be accessible by group or other users" >&2; exit 1; }
done

project_directory=$(dirname "$compose_file")
compose=(docker compose --project-directory "$project_directory" --env-file "$env_file" -f "$compose_file")
compose_init=(docker compose --project-directory "$project_directory" --env-file "$env_file" -f "$compose_file" -f "$KALA_ASPIRE_INIT_DIR/compose.initialize.yaml")
secret_mount="$KALA_ASPIRE_SECRETS_DIR:/run/kala-init-secrets:ro"
operator_mount="$KALA_ASPIRE_INIT_DIR:/operator:ro"

python3 "$KALA_ASPIRE_INIT_DIR/verify-published-compose.py" "$compose_file" "$env_file"
"${compose[@]}" config --format json | python3 "$KALA_ASPIRE_INIT_DIR/validate-initialization-config.py"
# Inspection failure is not proof that writers are stopped. Restarting/paused
# containers also retain a possible writer and must be stopped explicitly.
for state in running restarting paused; do
  active=$("${compose[@]}" ps --status "$state" --services)
  if grep -Eq '^(ingress|gateway|runtime|dashboard)$' <<<"$active"; then
    echo 'Application containers may still be active; stop/isolate them before initialization or continuation' >&2
    exit 1
  fi
done

# Only authorities start before claims and schemas are ready.
"${compose[@]}" up -d --wait --wait-timeout "$start_timeout" --no-deps postgres silo

if [[ $operation_mode != --resume-initialized ]]; then
"${compose[@]}" run --rm --no-deps --user 0:0 \
  -v "$secret_mount" -v "$operator_mount" \
  runtime /operator/initialize-postgres.mjs

# mc root authority exists only in this disposable provisioning container. The
# pinned PGSTY SILO image also includes its matching mc; Runtime receives the scoped identity.
"${compose_init[@]}" run --rm --no-deps silo-provision

# Claim all three empty authorities before creating application schemas. Partial claims intentionally fail closed.
"${compose[@]}" run --rm --no-deps --user 0:0 -v "$secret_mount" \
  -e KALA_INSTALLATION_ID_FILE=/run/kala-init-secrets/installation_id \
  -e KALA_FRESH_CLAIM_CONTROL_DATABASE_URL_FILE=/run/kala-init-secrets/control_owner_url \
  -e KALA_FRESH_CLAIM_RUNTIME_DATABASE_URL_FILE=/run/kala-init-secrets/runtime_owner_url \
  -e KALA_FRESH_CLAIM_STATE_MASTER_KEY_FILE=/run/kala-init-secrets/runtime_state_master_key \
  -e KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE=/run/kala-init-secrets/runtime_s3_access_key \
  -e KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE=/run/kala-init-secrets/runtime_s3_secret_key \
  -e KALA_FRESH_CLAIM_S3_ENDPOINT=http://silo:9000 \
  -e KALA_FRESH_CLAIM_S3_REGION=us-east-1 \
  -e KALA_FRESH_CLAIM_S3_BUCKET=kala-runtime \
  -e KALA_FRESH_CLAIM_S3_FORCE_PATH_STYLE=true \
  runtime packages/host/dist/bin/kala-fresh-storage-claim.js

# These real image CLIs migrate as owner and grant only steady-state DML/read privileges.
"${compose[@]}" run --rm --no-deps --user 0:0 -v "$secret_mount" \
  -e KALA_INGRESS_DATABASE_URL= \
  -e KALA_INGRESS_DATABASE_URL_FILE=/run/kala-init-secrets/control_owner_url \
  -e KALA_INGRESS_REQUIRE_EXISTING_DATABASE=1 \
  -e KALA_INGRESS_CONTROL_WRITER_ROLE=kala_gateway \
  -e KALA_INGRESS_MIGRATIONS_DIR=/app/packages/runtime-ingress-gateway/migrations \
  gateway packages/runtime-ingress-gateway/dist/src/bin/init-control-plane.js

"${compose[@]}" run --rm --no-deps --user 0:0 -v "$secret_mount" \
  -e KALA_POSTGRES_MIGRATION_CONNECTION_STRING_FILE=/run/kala-init-secrets/runtime_owner_url \
  runtime packages/host/dist/bin/kala-postgres-migrate.js \
  --runtime-role kala_runtime --gateway-runtime-reader-role kala_runtime_reader

fi

# Atomic and deliberately non-idempotent: a retry after an ambiguous result must be investigated, never auto-accepted.
owner_args=(
  run --rm --no-deps --user 0:0 -v "$secret_mount"
  -e KALA_INGRESS_DATABASE_URL=
  -e KALA_INGRESS_DATABASE_URL_FILE=/run/kala-init-secrets/control_owner_url
  -e KALA_DEDICATED_OWNER_PASSWORD_FILE=/run/kala-init-secrets/owner_password
  -e "KALA_DEDICATED_ORGANIZATION_NAME=$KALA_DEDICATED_ORGANIZATION_NAME"
)
if [[ -n ${KALA_DEDICATED_OWNER_EMAIL:-} ]]; then
  owner_args+=( -e "KALA_DEDICATED_OWNER_EMAIL=$KALA_DEDICATED_OWNER_EMAIL" )
fi
owner_args+=(gateway packages/runtime-ingress-gateway/dist/src/bin/bootstrap-dedicated-owner.js)
if [[ $operation_mode == --resume-initialized ]]; then
  owner_args+=(--verify-existing)
fi
"${compose[@]}" "${owner_args[@]}"

if [[ $operation_mode == --initialize-only ]]; then
  echo 'Initialization completed; application services were not started'
else
  "${compose[@]}" up -d --wait --wait-timeout "$start_timeout"
  echo 'Dedicated Aspire initialization verified and all six services are healthy (not full Agent/TLS acceptance)'
fi
