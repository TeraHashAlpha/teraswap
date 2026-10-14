import { describe, it, expect } from 'vitest'
import { forLog } from './log-sanitize'

describe('forLog', () => {
  it('removes CR and LF so a log line cannot be forged', () => {
    expect(forLog('a\r\nb\nc\rd')).toBe('abcd')
    expect(forLog('x\n[ALERT] fake')).toBe('x[ALERT] fake')
  })

  it('never emits CR or LF, whatever the input', () => {
    const inputs = ['a\nb', 'a\r\nb', '\n\n\r', 'x\u2028y', { toString: () => 'o\r\nbj' }, new Error('e\nf')]
    for (const i of inputs) expect(forLog(i)).not.toMatch(/[\r\n]/)
  })

  it('strips tab, ESC and other C0 controls plus DEL', () => {
    expect(forLog('a\tb')).toBe('ab')
    expect(forLog('\x1b[31mred\x1b[0m')).toBe('[31mred[0m')
    expect(forLog('a\x00b\x07c\x7fd')).toBe('abcd')
  })

  it('truncates to max (default 200)', () => {
    expect(forLog('a'.repeat(500))).toHaveLength(200)
    expect(forLog('abcdef', 3)).toBe('abc')
    expect(forLog('abc', 3)).toBe('abc')
  })

  it('stringifies non-string input', () => {
    expect(forLog(42)).toBe('42')
    expect(forLog(null)).toBe('null')
    expect(forLog(undefined)).toBe('undefined')
    expect(forLog({ toString: () => 'o\nbj' })).toBe('obj')
    expect(forLog(new Error('boom\nx'))).toBe('Error: boomx')
  })

  it('leaves clean text untouched', () => {
    expect(forLog('swap:192.168.1.1 → ok — fine')).toBe('swap:192.168.1.1 → ok — fine')
  })
})
