import { PageHeader } from '../components/primitives.js'

/**
 * Placeholder for a section that exists in the navigation but is not built yet.
 * Shown explicitly rather than as an empty screen, so the app never implies
 * functionality it does not have.
 */
export function PlannedPage({
  title,
  phase,
  description
}: {
  title: string
  phase: string
  description: string
}) {
  return (
    <>
      <PageHeader title={title} />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-dashed border-line bg-surface px-6 py-8 text-center">
          <div className="inline-flex rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
            Planned for {phase}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">{description}</p>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Not implemented yet. The build is following the phased plan so each stage can be verified
            against real data before the next one is layered on.
          </p>
        </div>
      </div>
    </>
  )
}
