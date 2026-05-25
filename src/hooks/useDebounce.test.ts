// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] useDebounce — generic value debouncer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebounce } from './useDebounce'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebounce', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('hello', 200))
    expect(result.current).toBe('hello')
  })

  it('emits the new value only after delayMs has elapsed', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebounce(value, 200),
      { initialProps: { value: 'a' } },
    )
    rerender({ value: 'b' })
    expect(result.current).toBe('a') // still initial — timer not elapsed
    act(() => { vi.advanceTimersByTime(199) })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('b')
  })

  it('rapid changes collapse to only the last emission', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebounce(value, 300),
      { initialProps: { value: 'a' } },
    )
    rerender({ value: 'b' })
    act(() => { vi.advanceTimersByTime(100) })
    rerender({ value: 'c' })
    act(() => { vi.advanceTimersByTime(100) })
    rerender({ value: 'd' })
    // The most recent update started its own 300ms timer.
    act(() => { vi.advanceTimersByTime(299) })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('d')
  })

  it('changing delayMs resets the timer (clearTimeout on cleanup)', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) => useDebounce(value, delay),
      { initialProps: { value: 'a', delay: 200 } },
    )
    rerender({ value: 'b', delay: 200 })
    act(() => { vi.advanceTimersByTime(150) })
    // Bump the delay — should clear the in-flight timer and start a new one.
    rerender({ value: 'b', delay: 500 })
    act(() => { vi.advanceTimersByTime(150) }) // 150ms of new 500ms timer
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(350) })
    expect(result.current).toBe('b')
  })

  it('works with numeric values (generic typing)', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useDebounce(value, 100),
      { initialProps: { value: 1 } },
    )
    rerender({ value: 42 })
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current).toBe(42)
  })
})
