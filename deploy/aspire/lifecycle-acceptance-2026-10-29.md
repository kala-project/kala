# Dedicated lifecycle acceptance — 2026-10-29

Result: **cold backup/restore passed with original Owner session and synthetic SQL/S3 data; release/upgrade gates remain open**.

The real six-service synthetic installation uses cached immutable application images from `c948fe30367ef2b863b5f3937ebccc0c676f84f1`, not the later telemetry/Owner-rotation application code. The external operator is the current working tree. No existing deployment, real identity, credentials or business Session was copied.

## Passed

- Fresh PG/SILO initialization and six actual services healthy.
- CA-verified Owner login before maintenance.
- Production cold backup stops all writers and cleanly stops data services; includes complete PG/SILO and protected mounted recovery configuration.
- Missing source-fenced acknowledgment and wrong PostgreSQL-major policy are refused.
- New backup manifests bind authority credentials and original parameter-file provenance; restored host paths may change without replacing those credentials.
- Production restore to three new empty disjoint roots preserves root-directory and descendant UID/GID/mode. No ownership workaround is required.
- Six restored services become healthy, **the original pre-backup opaque browser session remains valid**, and fresh CA-verified Owner login succeeds.
- Synthetic SQL sentinel and S3 object match their original SHA-256 values.
- Same-image, same-schema upgrade orchestration smoke completes after a production pre-upgrade backup. This is **not** distinct-predecessor release compatibility proof.

## Corrected driver diagnosis

The first child report blamed restored data-root permissions. Independent inspection found correct UID/GID/mode in the archive and in an unmodified production extraction. The continuation driver re-applied root ownership to its destination directories before retrying. A new clean-directory proof reproduced working Owner/SQL/S3 access **without chown**. This was a fixture defect, not a production extractor defect; the earlier workaround is not the accepted path. A focused root-only regression verifies that a uid-70 source root does not retain the root-owned empty destination's UID.

## Explicit boundaries

- Caddy named-volume PKI/ACME state is outside the payload. This isolated proof used newly issued internal certificates with the actual new CA and normal hostname/TLS verification; it did not bypass certificate checks. Trusted redistribution is required for internal CA reissue.
- The source application images are explicitly older than the new online telemetry/credential commands; this does not certify latest-image Agent/Executor work.
- A reviewed different predecessor-to-target release, failed-target recovery drill, PG-major migration, arbitrary schema migration, external-effect settlement and production signed releases remain unproved.
- Artifacts are private secret-bearing operator material, not public evidence. Only bounded sanitized outcomes and sentinel hashes are tracked. Test containers/networks/volumes are cleaned by exact project ownership.

See `lifecycle-acceptance-2026-10-29.json`, the operator guide, and the separate standalone telemetry proof.
