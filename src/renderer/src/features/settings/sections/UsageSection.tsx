/**
 * Usage: how many tokens this install has spent, in total and by period.
 *
 * ## What this page is for
 *
 * The student is paying per token, and OpenRouter's dashboard is a separate
 * website with a separate login that reports in their own periods. This is the
 * same number, in the app, in the periods they actually think in.
 *
 * ## Why deleting a chat does not change these figures
 *
 * Because the figures are not read off the transcript. Every finished turn adds
 * to a `usage_daily` ledger that has no foreign key to anything deletable, and
 * this page sums that. The obvious implementation — `SUM(tokens_in) FROM
 * messages` — would shrink every time a chat is deleted, which is a figure that
 * goes *down* after tidying up and is therefore not a spending record at all.
 *
 * ## Why a turn that was stopped is not in here
 *
 * A cancelled turn never receives its usage chunk, so there is no number to
 * record. It is left out rather than written as zero: a day where every turn was
 * stopped should read zero, not "we do not know".
 */
import { useEffect } from 'react'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { useSettingsStore } from '@/store/settingsStore'
import { formatTokens } from '@/lib/format'

export function UsageSection(): React.JSX.Element {
  const usage = useSettingsStore((state) => state.usage)
  const loading = useSettingsStore((state) => state.usageLoading)
  const loadUsage = useSettingsStore((state) => state.loadUsage)

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  const nothing = usage === null || usage.total.turns === 0

  return (
    <SettingsPanel
      title="Usage"
      description="Tokens sent to the model and tokens it sent back. Counts every finished answer since ISHKAPON was installed, on this device."
    >
      {loading && usage === null ? (
        <p className="settings__loading">Reading the ledger…</p>
      ) : null}

      {nothing && !loading ? (
        <div className="usage__empty">
          <p className="usage__empty-lead">Nothing counted yet.</p>
          <p className="usage__empty-hint">
            These totals come from a ledger that fills in as answers complete, so they start at
            zero on a fresh install. They are not a reconstruction of earlier chats, and deleting a
            chat never reduces them.
          </p>
        </div>
      ) : null}

      {usage !== null && !nothing ? (
        <>
          <div className="usage__totals">
            <Total label="Total in" value={formatTokens(usage.total.tokensIn)} />
            <Total label="Total out" value={formatTokens(usage.total.tokensOut)} />
            <Total label="Answers" value={String(usage.total.turns)} />
          </div>

          <table className="usage__table">
            <caption className="usage__caption">
              Tokens by period. The week starts on Monday.
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col" className="usage__num">
                  In
                </th>
                <th scope="col" className="usage__num">
                  Out
                </th>
                <th scope="col" className="usage__num">
                  Answers
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.periods.map((period) => (
                <tr key={period.key} data-empty={period.totals.turns === 0}>
                  <th scope="row">{period.label}</th>
                  <td className="usage__num">{formatTokens(period.totals.tokensIn)}</td>
                  <td className="usage__num">{formatTokens(period.totals.tokensOut)}</td>
                  <td className="usage__num">{period.totals.turns}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="settings__note">
            <p className="settings__note-line">
              <strong>Deleting a chat does not change these numbers.</strong> They come from a
              separate ledger, not from the transcripts.
            </p>
            {usage.firstDay === null ? null : (
              <p className="settings__note-hint">
                Counting since {usage.firstDay}
                {usage.lastDay !== null && usage.lastDay !== usage.firstDay
                  ? `, last activity ${usage.lastDay}.`
                  : '.'}
              </p>
            )}
          </div>
        </>
      ) : null}
    </SettingsPanel>
  )
}

function Total({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="usage__total">
      <span className="usage__total-value">{value}</span>
      <span className="usage__total-label">{label}</span>
    </div>
  )
}
