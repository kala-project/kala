#!/bin/sh
set -eu

# The keeper is a separately operated, long-lived container whose private PID
# namespace the original Executor joined before the effect was admitted.
anchor=${KALA_ARENA_EXECUTOR_PID_ANCHOR:?set the original Executor PID-namespace keeper container ID}
image=${KALA_ARENA_OPERATOR_IMAGE:?set a locally cached, immutable Node image digest}
network=${KALA_ARENA_OPERATOR_NETWORK:?set the isolated PG network}
workspace=${KALA_ARENA_WORKSPACE_HOST:?set the original Executor workspace absolute host path}
secret=${KALA_ARENA_OPERATOR_URL_FILE:?set the owner-only operator URL file}
operator=${KALA_ARENA_OPERATOR_ID:?set the dedicated tenant operator LOGIN}
expected_ns=${KALA_ARENA_EXPECTED_PID_NAMESPACE:?set the original Executor receipt PID namespace}
case "$expected_ns" in pid:\[*\]) ;; *) echo 'Invalid original PID namespace' >&2; exit 2;; esac
case "$anchor" in
  host)
    keeper_file=${KALA_ARENA_KEEPER_IDENTITY_FILE:?host-mode requires the original service keeper identity}
    project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
    node --input-type=module -e "const {pathToFileURL}=await import('node:url'); const {assertArenaKeeper}=await import(pathToFileURL(process.argv[2]).href); await assertArenaKeeper(process.argv[1])" \
      "$keeper_file" "$project_root/packages/executor/dist/src/arena-keeper.js" ||
      { echo 'Original host PID-namespace keeper is unavailable' >&2; exit 2; }
    pid_mode=host ;;
  *[!0-9a-f]*|'') echo 'Invalid keeper container ID' >&2; exit 2 ;;
  *) pid_mode="container:$anchor" ;;
esac
case "$image" in sha256:*|*@sha256:*) ;; *) echo 'Operator image must be immutable' >&2; exit 2;; esac
case "$workspace" in /*) ;; *) echo 'Workspace must be absolute' >&2; exit 2;; esac
case "$secret" in /*) ;; *) echo 'Operator credential must be an absolute file path' >&2; exit 2;; esac
case "${1:-}" in
  inspect) program=arena-effect-inspect.js ;;
  reconcile) program=arena-effect-reconcile.js ;;
  *) echo 'Usage: run-arena-operator.sh inspect|reconcile <exact CLI arguments>' >&2; exit 2 ;;
esac
shift
test "$(stat -c %u "$secret")" = "$(id -u)" || { echo 'Operator file owner mismatch' >&2; exit 2; }
test "$(stat -c %a "$secret")" = 600 || { echo 'Operator file must be 0600' >&2; exit 2; }
test -f "$secret" && test ! -L "$secret" && test -d "$workspace" ||
  { echo 'Operator file or workspace unavailable' >&2; exit 2; }
if [ "$anchor" != host ]; then
  test "$(docker container inspect -f '{{.State.Running}}' "$anchor")" = true &&
    test -z "$(docker container inspect -f '{{.HostConfig.PidMode}}' "$anchor")" ||
    { echo 'Original private PID namespace keeper is unavailable' >&2; exit 2; }
fi
docker image inspect "$image" >/dev/null
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
exec docker run --pull never --rm --pid "$pid_mode" --network "$network" \
  --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --read-only --pids-limit 64 \
  --mount "type=bind,src=$project_root/node_modules,dst=/app/node_modules,readonly" \
  --mount "type=bind,src=$project_root/packages/host/dist,dst=/app/packages/host/dist,readonly" \
  --mount "type=bind,src=$project_root/packages/host/node_modules,dst=/app/packages/host/node_modules,readonly" \
  --mount "type=bind,src=$project_root/packages/host/package.json,dst=/app/packages/host/package.json,readonly" \
  --mount "type=bind,src=$project_root/packages/executor/dist,dst=/app/packages/executor/dist,readonly" \
  --mount "type=bind,src=$project_root/packages/executor/node_modules,dst=/app/packages/executor/node_modules,readonly" \
  --mount "type=bind,src=$project_root/packages/executor/package.json,dst=/app/packages/executor/package.json,readonly" \
  --mount "type=bind,src=$project_root/packages/kernel/dist,dst=/app/packages/kernel/dist,readonly" \
  --mount "type=bind,src=$project_root/packages/kernel/node_modules,dst=/app/packages/kernel/node_modules,readonly" \
  --mount "type=bind,src=$project_root/packages/kernel/package.json,dst=/app/packages/kernel/package.json,readonly" \
  --mount "type=bind,src=$project_root/packages/shared/dist,dst=/app/packages/shared/dist,readonly" \
  --mount "type=bind,src=$project_root/packages/shared/node_modules,dst=/app/packages/shared/node_modules,readonly" \
  --mount "type=bind,src=$project_root/packages/shared/package.json,dst=/app/packages/shared/package.json,readonly" \
  --mount "type=bind,src=$workspace,dst=$workspace,readonly" \
  --mount "type=bind,src=$secret,dst=/run/arena-operator-url,readonly" \
  -e KALA_ARENA_RECONCILE_OPERATOR_URL_FILE=/run/arena-operator-url \
  -e "KALA_ARENA_OPERATOR_ID=$operator" \
  -e "KALA_ARENA_EXPECTED_PID_NAMESPACE=$expected_ns" \
  --workdir /app/packages/host --entrypoint node "$image" "dist/bin/$program" "$@"
