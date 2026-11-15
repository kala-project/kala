export const SESSION_DELETION_FIELD = '__kalaSessionDeletion'

export function sessionSummarySchemaStatements(schema: string): readonly string[] {
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.kala_session_summary(source_document jsonb)
      RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      SET search_path = pg_catalog, pg_temp AS $summary$
      WITH decoded AS MATERIALIZED (
        SELECT source_document || '{}'::jsonb AS document
        WHERE source_document <> 'null'::jsonb
      )
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'sessionId', document->'sessionId',
        'agentRuntime', document->'agentRuntime',
        'executionMode', document->'executionMode',
        'agentRuntimeVersion', document->'agentRuntimeVersion',
        'createdAt', document->'createdAt',
        'lastEventAt', document->'lastEventAt',
        'parentSessionId', document->'parentSessionId',
        'organizationId', document->'organizationId',
        'workspaceId', document->'workspaceId',
        'workspaceName', document->'workspaceName',
        'firstUserMessage', left(document->>'firstUserMessage', 120),
        'label', document->'label',
        'goal', document->'goal',
        '${SESSION_DELETION_FIELD}', document->'${SESSION_DELETION_FIELD}',
        'preferences', COALESCE(document->'preferences', '{}'::jsonb),
        'state', jsonb_strip_nulls(jsonb_build_object(
          'cursor', document#>'{state,cursor}',
          'status', document#>'{state,status}',
          'cwd', document#>'{state,cwd}'
        ))
      )) FROM decoded
      $summary$`,
    `ALTER TABLE ${schema}.tenant_session_latest_projection
      ADD COLUMN IF NOT EXISTS summary_document jsonb
      GENERATED ALWAYS AS (${schema}.kala_session_summary(document)) STORED`,
  ]
}
