#!/usr/bin/env tsx
/**
 * [fix/token-sync-cron-landing] CLI: prints the added/removed/changed summary between the
 * git-committed version of one chain's catalog file and the current working-tree version
 * (i.e. what `npm run tokens:sync` just produced, before it's committed). Used by the
 * token-catalog-refresh cron to put real counts in each per-chain PR body.
 *
 *   npx tsx scripts/token-catalog/report-diff.ts <chainId>
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CatalogRow } from './lib/types'
import { diffCatalogs, formatDiffSummary } from './lib/diff-report'

const chainId = Number(process.argv[2])
if (!Number.isInteger(chainId)) {
  console.error('usage: report-diff.ts <chainId>')
  process.exit(2)
}

const file = path.join('src', 'config', 'generated', `token-catalog.${chainId}.json`)

function readTokens(json: string): CatalogRow[] {
  return (JSON.parse(json).tokens ?? []) as CatalogRow[]
}

let before: CatalogRow[] = []
try {
  const committed = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
  before = readTokens(committed)
} catch {
  before = [] // new file — everything in `after` is "added"
}

const after = fs.existsSync(file) ? readTokens(fs.readFileSync(file, 'utf8')) : []

console.log(formatDiffSummary(chainId, diffCatalogs(before, after)))
