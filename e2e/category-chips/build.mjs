/**
 * Playwright globalSetup: bundle the REAL <CategoryChips/> (real drag/wheel/fade JS)
 * + the app's REAL compiled Tailwind CSS into a static harness loaded via file://.
 * No dev server, no component-test runner — just esbuild + the tailwind CLI, so it's
 * deterministic in CI. [chore/category-scroll-fix]
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

  // 1. Bundle the real component + mount entry into a single IIFE.
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

  // 2. Compile the REAL Tailwind utilities the app ships (same config + content).
  // Invoke the LOCAL tailwind binary directly (NOT `npx`, which can block on an
  // install prompt when run without a TTY, e.g. under Playwright globalSetup).
  const tailwindBin = join(
    root,
    'node_modules',
    '.bin',
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

  // 3. Static harness page.
  writeFileSync(
    join(out, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="./styles.css"></head>' +
      '<body><div id="root"></div><script src="./bundle.js"></script></body></html>',
  )
}
