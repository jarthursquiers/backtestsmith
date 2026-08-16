import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, ButtonHTMLAttributes } from 'react'

/** Small shared UI vocabulary so pages stay about research, not markup. */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = ''
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line-soft px-4 py-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'neutral' | 'gain' | 'loss' | 'warn'
}) {
  const toneClass =
    tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : 'text-ink'
  return (
    <div className="rounded-md border border-line-soft bg-surface-2 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={`num mt-1 text-lg leading-tight ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'gain' | 'loss' | 'warn' | 'accent'
}) {
  const tones: Record<string, string> = {
    neutral: 'border-line bg-surface-2 text-ink-dim',
    gain: 'border-gain/30 bg-gain/10 text-gain',
    loss: 'border-loss/30 bg-loss/10 text-loss',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    accent: 'border-accent/30 bg-accent/10 text-accent'
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink-dim">{label}</span>
      {children}
      {hint && <span className="text-[10px] leading-relaxed text-ink-faint">{hint}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent/40 disabled:opacity-50'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${inputClass} ${className}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props
  return (
    <select {...rest} className={`${inputClass} ${className}`}>
      {children}
    </select>
  )
}

export function Button({
  variant = 'default',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const variants: Record<string, string> = {
    default: 'border-line bg-surface-2 text-ink hover:border-ink-faint hover:bg-line-soft',
    primary: 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25',
    ghost: 'border-transparent bg-transparent text-ink-dim hover:bg-surface-2 hover:text-ink',
    danger: 'border-loss/40 bg-loss/10 text-loss hover:bg-loss/20'
  }
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-line px-6 py-10 text-center">
      <p className="text-[12px] font-medium text-ink-dim">{title}</p>
      {children && <p className="max-w-md text-[11px] leading-relaxed text-ink-faint">{children}</p>}
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
      aria-hidden="true"
    />
  )
}

/** Inline error/success banner. */
export function Notice({ tone, children }: { tone: 'error' | 'success' | 'warn' | 'info'; children: ReactNode }) {
  const tones: Record<string, string> = {
    error: 'border-loss/30 bg-loss/10 text-loss',
    success: 'border-gain/30 bg-gain/10 text-gain',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    info: 'border-accent/30 bg-accent/10 text-accent'
  }
  return (
    <div className={`rounded-md border px-3 py-2 text-[11px] leading-relaxed ${tones[tone]}`}>{children}</div>
  )
}

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-line-soft px-6 py-4">
      <div>
        <h1 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-ink-faint">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
