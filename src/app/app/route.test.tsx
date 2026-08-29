/**
 * /app is a permanent alias of /swap. The shipped route module must
 * return HTTP 308 to /swap — the redirect is the entry, not a test double.
 */

import { describe, it, expect } from 'vitest'
import { GET } from './route'

describe('/app route', () => {
  it('issues a permanent redirect to /swap', () => {
    const res = GET(new Request('https://www.teraswap.app/app'))
    expect(res.status).toBe(308)
    const location = res.headers.get('location')
    expect(location).toBeTruthy()
    expect(new URL(location!).pathname).toBe('/swap')
  })
})
