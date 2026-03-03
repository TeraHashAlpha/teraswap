'use client'

import { useState, useEffect, useCallback } from 'react'

interface Props {
  /** ISO-8601 launch date, e.g. "2026-03-02T12:00:00Z" */
  launchDate: string
  /** Called when countdown hits zero — parent should swap to real app */
  onLaunched: () => void
  /** Go back to landing */
  onBack: () => void
}

interface TimeLeft {
  days: number
  hours: number
  minutes: number
  seconds: number
  total: number
}

function calcTimeLeft(target: number): TimeLeft {
  const total = Math.max(0, target - Date.now())
  return {
    days: Math.floor(total / (1000 * 60 * 60 * 24)),
    hours: Math.floor((total / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((total / (1000 * 60)) % 60),
    seconds: Math.floor((total / 1000) % 60),
    total,
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

export default function CountdownGate({ launchDate, onLaunched, onBack }: Props) {
  const target = new Date(launchDate).getTime()
  const [time, setTime] = useState<TimeLeft>(calcTimeLeft(target))
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const tick = () => {
      const t = calcTimeLeft(target)
      setTime(t)
      if (t.total <= 0) {
        clearInterval(id)
        onLaunched()
      }
    }
    const id = setInterval(tick, 1000)
    tick()
    return () => clearInterval(id)
  }, [target, onLaunched])

  // Avoid hydration mismatch — show skeleton until mounted
  if (!mounted) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-32 w-64 animate-pulse rounded-2xl bg-cream-08" />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 animate-fade-slide-in">
      {/* ── Glow effect behind countdown ── */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className="h-[400px] w-[400px] rounded-full opacity-15 blur-[120px]"
          style={{
            background: 'radial-gradient(circle, #C8B89A 0%, transparent 70%)',
          }}
        />
      </div>

      {/* ── Content ── */}
      <div className="relative z-10 flex flex-col items-center gap-8">
        {/* Badge */}
        <div className="flex items-center gap-2 rounded-full border border-cream-15 bg-cream-04 px-4 py-1.5">
          <span className="h-2 w-2 rounded-full bg-cream-gold animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-widest text-cream-65">
            Launching Soon
          </span>
        </div>

        {/* Headline */}
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight text-cream sm:text-5xl md:text-6xl">
            Almost There
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-cream-50 sm:text-base">
            TeraSwap is deployed and ready. The protocol will go live automatically when the countdown reaches zero.
          </p>
        </div>

        {/* ── Countdown blocks ── */}
        <div className="flex items-center gap-3 sm:gap-4">
          <CountdownBlock value={time.days} label="Days" />
          <Separator />
          <CountdownBlock value={time.hours} label="Hours" />
          <Separator />
          <CountdownBlock value={time.minutes} label="Min" />
          <Separator />
          <CountdownBlock value={time.seconds} label="Sec" />
        </div>

        {/* ── Progress bar ── */}
        <LaunchProgress launchDate={target} />

        {/* ── Back to landing ── */}
        <button
          onClick={onBack}
          className="mt-2 flex items-center gap-2 rounded-full border border-cream-08 bg-cream-04 px-5 py-2.5 text-xs font-medium text-cream-50 transition-all hover:border-cream-15 hover:bg-cream-08 hover:text-cream"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Explore TeraSwap
        </button>
      </div>
    </div>
  )
}

/* ── Countdown digit block ── */
function CountdownBlock({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex h-[72px] w-[64px] items-center justify-center rounded-xl border border-cream-15 bg-surface-secondary/80 shadow-lg shadow-black/20 backdrop-blur-sm sm:h-[88px] sm:w-[78px]">
        <span className="font-display text-3xl font-bold tabular-nums text-cream sm:text-4xl">
          {pad(value)}
        </span>
      </div>
      <span className="text-[10px] font-medium uppercase tracking-widest text-cream-35">
        {label}
      </span>
    </div>
  )
}

/* ── Colon separator ── */
function Separator() {
  return (
    <div className="flex flex-col gap-1.5 pb-6">
      <div className="h-1.5 w-1.5 rounded-full bg-cream-35" />
      <div className="h-1.5 w-1.5 rounded-full bg-cream-35" />
    </div>
  )
}

/* ── Progress bar showing how far along we are ── */
function LaunchProgress({ launchDate }: { launchDate: number }) {
  // Assume 2 days (48h) countdown window for the progress bar
  const COUNTDOWN_WINDOW = 48 * 60 * 60 * 1000
  const startDate = launchDate - COUNTDOWN_WINDOW
  const now = Date.now()
  const elapsed = now - startDate
  const progress = Math.min(100, Math.max(0, (elapsed / COUNTDOWN_WINDOW) * 100))

  return (
    <div className="flex w-full max-w-[320px] flex-col gap-2">
      <div className="h-1 overflow-hidden rounded-full bg-cream-08">
        <div
          className="h-full rounded-full transition-all duration-1000"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #C8B89A, #A89878)',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-cream-35">
        <span>Deployed</span>
        <span>Live</span>
      </div>
    </div>
  )
}
