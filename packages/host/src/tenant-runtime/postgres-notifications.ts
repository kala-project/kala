export interface PostgresNotificationClient {
  connect(): Promise<void>
  query(text: string): Promise<unknown>
  end(): Promise<void>
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): unknown
  on(event: 'error' | 'end', listener: () => void): unknown
}

/** A dedicated connection keeps LISTEN outside transactions and the query pool. */
export async function listenPostgresNotifications(
  createClient: () => PostgresNotificationClient,
  channel: string,
  listener: (payload?: string) => void,
): Promise<() => Promise<void>> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(channel)) throw new TypeError('invalid PostgreSQL notification channel')
  let closed = false
  let client: PostgresNotificationClient | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const stop = async () => {
    closed = true
    if (retry) clearTimeout(retry)
    const previous = client
    client = undefined
    await previous?.end().catch(() => undefined)
  }
  const connect = async (initial = false): Promise<void> => {
    if (closed) return
    const next = createClient()
    client = next
    let lost = false
    const recover = () => {
      if (closed || lost || client !== next) return
      lost = true
      client = undefined
      void next.end().catch(() => undefined)
      retry = setTimeout(() => { void connect() }, 1_000)
      retry.unref?.()
    }
    next.on('error', recover)
    next.on('end', recover)
    next.on('notification', (message) => {
      if (!closed && client === next && message.channel === channel) listener(message.payload ?? '')
    })
    try {
      await next.connect()
      await next.query(`LISTEN "${channel}"`)
      // LISTEN cannot replay a gap. Rehydrate after every successful connection.
      if (!closed && client === next) listener()
    } catch (error) {
      recover()
      if (initial) { await stop(); throw error }
    }
  }
  await connect(true)
  return stop
}
