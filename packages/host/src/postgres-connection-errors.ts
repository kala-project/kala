export interface PostgresConnectionErrorEvents {
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'connect', listener: (client: { on(event: 'error', listener: (error: Error) => void): unknown }) => void): unknown
}

export function observePostgresConnectionErrors(
  pool: PostgresConnectionErrorEvents,
  component: 'hot-state' | 'resource-ownership' | 'unit-materialization' | 'unit-placement',
): void {
  const report = (source: 'client' | 'pool'): void => {
    console.warn(JSON.stringify({ event: 'postgres_connection_lost', component, source }))
  }
  pool.on('error', () => report('pool'))
  // Pool error handlers cover idle clients only. A checked-out client can lose
  // its connection between awaited queries, outside any rejecting query promise.
  pool.on('connect', (client) => { client.on('error', () => report('client')) })
}
