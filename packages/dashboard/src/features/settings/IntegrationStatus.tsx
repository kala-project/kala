import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { IntegrationObservation } from '@agent-kernel/shared'
import { Button } from '../../components/ui/button.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { useSettingsRequest } from './configuration-request.js'
import { CopyButton, SettingsRecordField } from './controls.js'

export function IntegrationStatus(props: { cacheNamespace: string; organizationId?: string; hosted: boolean }): JSX.Element {
  const { t } = useTranslation()
  const request = useSettingsRequest()
  const query = useQuery({
    queryKey: ['settings-integrations', props.cacheNamespace, props.organizationId ?? '', props.hosted],
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const read = async (path: string, component: 'runtime' | 'gateway'): Promise<IntegrationObservation[]> => {
        const response = await request(path, { signal, cache: 'no-store' })
        if (!response.ok) throw new Error('integration_observation_unavailable')
        const body = await response.json() as { organizationId?: string; integrationStatus?: IntegrationObservation[] }
        if (component === 'gateway' && body.organizationId !== props.organizationId
          || !Array.isArray(body.integrationStatus) || body.integrationStatus.some(item => item.component !== component
            || !['secrets', 'artifacts', 'telemetry', 'error-reporting', 'ticketing', 'webhooks'].includes(item.id)
            || ![true, false, null].includes(item.configured) || !['healthy', 'unavailable', 'unknown', 'not-applicable'].includes(item.health)
            || typeof item.sourceRef !== 'string' || typeof item.observedAt !== 'string')) {
          throw new Error('integration_observation_scope_mismatch')
        }
        return body.integrationStatus
      }
      const runtime = read('/settings/sections/integrations', 'runtime')
      const gateway = props.hosted ? read('/organization/settings/integrations', 'gateway') : Promise.resolve([])
      return (await Promise.all([runtime, gateway])).flat()
    },
  })
  const labels = { secrets: 'secrets', artifacts: 'artifacts', telemetry: 'telemetry', 'error-reporting': 'errorReporting',
    ticketing: 'ticketing', webhooks: 'webhooks' }
  return <section className="space-y-3 rounded border border-border/60 p-4">
    <div className="flex items-center gap-1"><h3 className="font-semibold">{t('admin.adapters')}</h3><HelpHint label={t('admin.adapters')}>{t('unifiedSettings.integrations.meaning')}</HelpHint>{query.data ? <div className="ml-auto"><CopyButton value={JSON.stringify(query.data, null, 2)} label={t('unifiedSettings.copyDiagnostics')} /></div> : null}</div>
    {query.isPending ? <p role="status">{t('common.loading')}</p> : query.isError
      ? <p role="alert">{t('unifiedSettings.unknown')}</p>
      : <dl className="grid gap-3 text-sm sm:grid-cols-2">{query.data.map(item => <div key={`${item.component}:${item.id}`} className="min-w-0 rounded-lg border border-border/50 bg-card/60 p-3">
        <dt className="flex flex-wrap items-center justify-between gap-2 font-medium"><span>{t(`admin.labels.${labels[item.id]}`)}</span><span className="rounded bg-muted px-2 py-1 text-xs font-normal capitalize text-muted-foreground">{item.component}</span></dt>
        <dd><dl className="mt-3 space-y-2">
          <SettingsRecordField label={t('unifiedSettings.integrations.configuration')}>{t(`unifiedSettings.integrations.${item.configured === null ? 'unknown' : item.configured ? 'configured' : 'absent'}`)}</SettingsRecordField>
          <SettingsRecordField label={t('unifiedSettings.integrations.healthLabel')}><span className={item.health === 'unavailable' ? 'text-destructive' : undefined}>{t(`unifiedSettings.integrations.health.${item.health}`)}</span></SettingsRecordField>
        </dl></dd>
      </div>)}</dl>}
    <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.reload')}</Button>
  </section>
}
