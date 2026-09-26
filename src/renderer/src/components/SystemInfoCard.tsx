import type { AppInfo } from '@shared/types'

interface SystemInfoCardProps {
  info: AppInfo | null
  onRefresh: () => Promise<void>
}

const ROW_LABELS: Array<[keyof AppInfo, string]> = [
  ['name', 'App'],
  ['version', 'Version'],
  ['electronVersion', 'Electron'],
  ['chromeVersion', 'Chromium'],
  ['nodeVersion', 'Node'],
  ['platform', 'Platform'],
  ['arch', 'Architecture'],
  ['locale', 'Locale']
]

export default function SystemInfoCard({
  info,
  onRefresh
}: SystemInfoCardProps): React.JSX.Element {
  return (
    <article className="card">
      <div className="card__head">
        <h2 className="card__title">System</h2>
        <button className="btn btn--ghost" type="button" onClick={() => void onRefresh()}>
          Refresh
        </button>
      </div>

      <dl className="stats">
        {ROW_LABELS.map(([key, label]) => (
          <div className="stats__row" key={key}>
            <dt className="stats__label">{label}</dt>
            <dd className="stats__value">{info ? String(info[key]) : '—'}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
