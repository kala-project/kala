// The grace period is for operator renewal, not continued Runtime/API access.
// Missing, not-yet-started, and ended contracts all deny new authorization.
// Keep this predicate shared by human, service-account and Executor ingress.
export const ACTIVE_CONTRACT_SQL = `EXISTS (
  SELECT 1 FROM contract_entitlements c
  WHERE c.organization_id = o.id AND c.starts_at <= now() AND c.ends_at > now()
)`
