export type RuntimeIngressControlPlaneMode =
  | { kind: 'postgres'; databaseUrl: string }
  | { kind: 'json'; directoryPath: string }

export async function resolveRuntimeIngressControlPlaneMode(
  env: NodeJS.ProcessEnv,
  readSecret: (name: string) => Promise<string>,
): Promise<RuntimeIngressControlPlaneMode> {
  const databaseUrl = env.KALA_INGRESS_DATABASE_URL_FILE?.trim() || env.KALA_INGRESS_DATABASE_URL_REF?.trim()
    ? await readSecret('KALA_INGRESS_DATABASE_URL')
    : env.KALA_INGRESS_DATABASE_URL?.trim()
  if (databaseUrl) return { kind: 'postgres', databaseUrl }
  if (env.NODE_ENV === 'production') throw new Error('KALA_INGRESS_DATABASE_URL is required in production; JSON control stores are migration-only')
  return { kind: 'json', directoryPath: await readSecret('KALA_INGRESS_UNIT_DIRECTORY') }
}
