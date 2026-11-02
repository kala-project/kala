"""Reviewed bounded-v2 container task budgets (threads count as tasks)."""

PID_LIMITS = {
    'runtime': 512,
    'gateway': 128,
    'dashboard': 64,
    'postgres': 256,
    'silo': 512,
    'ingress': 128,
    'observability-dashboard': 256,
    'otel-collector': 128,
    'observability-readiness': 32,
}
