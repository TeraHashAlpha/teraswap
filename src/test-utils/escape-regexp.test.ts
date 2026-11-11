import { describe, it, expect } from 'vitest'
import { escapeRegExp } from './escape-regexp'

describe('escapeRegExp [fix/v1-maintenance C5]', () => {
  const META = '\\^$.*+?()[]{}|/'
  it('escapes the backslash and every metacharacter: the result matches the input literally', () => {
    expect(new RegExp(`^${escapeRegExp(META)}$`).test(META)).toBe(true)
    for (const ch of META) expect(new RegExp(`^${escapeRegExp(ch)}$`).test(ch)).toBe(true)
  })
  it('a literal backslash is escaped (not left to escape the next character)', () => {
    expect(escapeRegExp('a\\b')).toBe('a\\\\b')
    expect(new RegExp(`^${escapeRegExp('a\\.b')}$`).test('a\\.b')).toBe(true)
    expect(new RegExp(`^${escapeRegExp('a\\.b')}$`).test('a\\xb')).toBe(false)
  })
  it('does not treat the input as a pattern', () => {
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false)
    expect(new RegExp(`^${escapeRegExp('(x|y)+')}$`).test('x')).toBe(false)
  })
  it('leaves plain text untouched', () => {
    expect(escapeRegExp('Hello world 42')).toBe('Hello world 42')
  })
})
