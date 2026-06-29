/**
 * Playwright globalSetup: bundle the REAL <ModeTabs/> + the app's REAL compiled Tailwind CSS into a
 * static harness loaded via file:// — no dev server, no env/secrets, deterministic in CI. Mirrors the
 * proven e2e/category-chips/build.mjs harness. [chore/mobile-ux-polish]
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, '.harness')

export default async function globalSetup() {
  mkdirSync(out, { recursive: true })

  await build({
    entryPoints: [join(here, 'mount.tsx')],
    bundle: true,
    outfile: join(out, 'bundle.js'),
    format: 'iife',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })

  const tailwindBin = join(
    root, 'node_modules', '.bin',
    process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss',
  )
  execFileSync(
    tailwindBin,
    [
      '-i', join(root, 'src/app/globals.css'),
      '-o', join(out, 'styles.css'),
      '--config', join(root, 'tailwind.config.ts'),
      '--minify',
    ],
    { cwd: root, stdio: 'inherit' },
  )

  writeFileSync(
    join(out, 'index.html'),
    '<!doctype html><html class="dark"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="./styles.css"></head>' +
      '<body><div id="root"></div><script src="./bundle.js"></script></body></html>',
  )
}
