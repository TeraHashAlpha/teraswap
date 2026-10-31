import { useId, type ReactNode } from 'react'
import { cx } from './cx'
import './primitives.css'

export interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  disabled?: boolean
  className?: string
}

/**
 * Round 7 D3 toggle row (Force MEV Protection): the switch is kept, the row is unboxed — the label sits on the photo with a
 * hairline under it. One `role="switch"` button whose name is the label; the whole row is the 44 px hit area.
 */
export function Toggle({ checked, onChange, label, disabled = false, className }: ToggleProps) {
  const labelId = useId()
  return (
    <div className={cx('ts-v2-rule-b flex min-h-[44px] items-center justify-between gap-4 py-2', className)}>
      <span id={labelId} className={cx('text-[14px]', disabled ? 'text-v2-dim' : 'text-v2-text')}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="ts-v2-switch focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal disabled:cursor-not-allowed"
      >
        <span aria-hidden="true" className="ts-v2-switch__thumb" />
      </button>
    </div>
  )
}
