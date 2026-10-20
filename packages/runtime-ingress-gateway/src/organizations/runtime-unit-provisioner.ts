import { requestRuntime } from '../edge/server.js'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import type { RuntimeProvisioningOriginResolver } from '../runtime-origin/postgres-runtime-origin-resolver.js'

export type RuntimeHostResponse = { status: number; body: Buffer }
export type RuntimeHostRequest = (body: unknown) => Promise<RuntimeHostResponse>

export function createRuntimeHostProvisioningClient(options: {
  origin: string
  runtimeProvisioningOriginResolver?: RuntimeProvisioningOriginResolver
  ingressSecret: string
  tls?: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer; servername?: string }
}): RuntimeHostRequest {
  return async (body) => {
    const unitId = typeof body === 'object' && body !== null && typeof (body as { unitId?: unknown }).unitId === 'string'
      ? (body as { unitId: string }).unitId
      : undefined
    if (!unitId) throw new Error('Tenant provisioning requires an authoritative runtime unit')
    const origin = options.runtimeProvisioningOriginResolver
      ? await options.runtimeProvisioningOriginResolver.resolveProvisioningOrigin(unitId)
      : options.origin
    if (!origin) throw new Error('Tenant provisioning runtime origin is unavailable')
    return requestRuntime(
      origin,
      '/internal/runtime-units',
      'POST',
      { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': options.ingressSecret },
      Buffer.from(JSON.stringify(body)),
      options.tls,
    )
  }
}

type Placement = {
  organization_id: string
  placement_organization_id: string
  generation: number
  desired_state: 'ready' | 'suspended' | 'deleted'
  last_operation_id: string
}

const BIND_OPERATION_PREFIX = 'host-bind-organization:'

/** Materializes runtime units only from the authoritative Postgres organization placement. */
export class RuntimeUnitProvisioner {
  constructor(private readonly database: ControlPlaneDatabase, private readonly requestHost: RuntimeHostRequest) {}

  async provision(unitId: string): Promise<void> {
    let placement = await this.readPlacement(this.database, unitId)
    let response = await this.requestHost(commandFor(unitId, placement))
    if (isSuccess(response)) return

    if (response.status === 409 && responseCode(response) === 'organization_binding_upgrade_required') {
      placement = await this.prepareBindingUpgrade(unitId)
      response = await this.requestHost(commandFor(unitId, placement))
      if (isSuccess(response)) return
    }
    throw hostFailure(response)
  }

  private async prepareBindingUpgrade(unitId: string): Promise<Placement> {
    return this.database.transaction(async (transaction) => {
      const placement = await this.readPlacement(transaction, unitId, true)
      if (isBindingOperation(unitId, placement.generation, placement.last_operation_id)) return placement
      const generation = placement.generation + 1
      if (!Number.isSafeInteger(generation)) throw new Error(`Runtime unit ${unitId} generation cannot be advanced safely`)
      const operationId = bindingOperationId(unitId, generation)
      const updated = await transaction.query<Placement>(`UPDATE runtime_unit_placements
        SET generation=$2,last_operation_id=$3,updated_at=now()
        WHERE runtime_unit_id=$1 AND organization_id=$4 AND generation=$5
        RETURNING organization_id AS placement_organization_id,generation,desired_state,last_operation_id`,
      [unitId, generation, operationId, placement.organization_id, placement.generation])
      if (updated.rowCount !== 1 || !updated.rows[0]) throw new Error(`Runtime unit ${unitId} binding upgrade lost its placement lock`)
      // Read through the same validator: UPDATE RETURNING also reports BIGINT as a string.
      return this.readPlacement(transaction, unitId)
    })
  }

  private async readPlacement(executor: SqlExecutor, unitId: string, forUpdate = false): Promise<Placement> {
    const result = await executor.query<Placement>(`SELECT o.id AS organization_id,p.organization_id AS placement_organization_id,p.generation,p.desired_state,p.last_operation_id
      FROM organizations o JOIN runtime_unit_placements p ON p.runtime_unit_id=o.runtime_unit_id
      WHERE o.runtime_unit_id=$1${forUpdate ? ' FOR UPDATE OF p' : ''}`, [unitId])
    if (result.rowCount !== 1 || !result.rows[0]) throw new Error(`Runtime unit ${unitId} must map to exactly one authoritative organization placement`)
    const placement = result.rows[0]
    if (placement.organization_id !== placement.placement_organization_id) throw new Error(`Runtime unit ${unitId} has a cross-organization placement mismatch`)
    // PostgreSQL BIGINT values are strings by default in node-postgres.
    const generation = typeof placement.generation === 'string' ? Number(placement.generation) : placement.generation
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(`Runtime unit ${unitId} has an invalid placement generation`)
    if (!['ready', 'suspended', 'deleted'].includes(placement.desired_state)) throw new Error(`Runtime unit ${unitId} has an invalid desired state`)
    return { ...placement, generation }
  }
}

function commandFor(unitId: string, placement: Placement): unknown {
  const bindingUpgrade = isBindingOperation(unitId, placement.generation, placement.last_operation_id)
  return {
    unitId,
    organizationId: placement.organization_id,
    operationId: bindingUpgrade ? placement.last_operation_id : `host-materialize:${unitId}:${placement.generation}:${placement.desired_state}`,
    generation: placement.generation,
    action: bindingUpgrade ? 'bind-organization' : actionFor(placement.desired_state),
    ...(bindingUpgrade ? { desiredState: placement.desired_state } : {}),
  }
}

function actionFor(state: Placement['desired_state']): 'provision' | 'suspend' | 'delete' {
  if (state === 'suspended') return 'suspend'
  if (state === 'deleted') return 'delete'
  return 'provision'
}

function bindingOperationId(unitId: string, generation: number): string {
  return `${BIND_OPERATION_PREFIX}${unitId}:${generation}`
}

function isBindingOperation(unitId: string, generation: number, operationId: string): boolean {
  return operationId === bindingOperationId(unitId, generation)
}

function isSuccess(response: RuntimeHostResponse): boolean {
  return response.status >= 200 && response.status < 300
}

function responseCode(response: RuntimeHostResponse): string | undefined {
  try {
    const code = (JSON.parse(response.body.toString('utf8')) as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

function hostFailure(response: RuntimeHostResponse): Error {
  return new Error(`Tenant provisioning failed: ${response.status} ${response.body.toString('utf8')}`)
}
