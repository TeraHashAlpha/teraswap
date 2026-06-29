/**
 * Playwright globalSetup: bundle the REAL <ModeTabs/> + the app's REAL compiled Tailwind CSS into a
 * static harness loaded via file:// — no dev server, no env/secrets, deterministic in CI. Mirrors the
 * proven e2e/category-chips/build.mjs harness. [chore/mobile-ux-polish]
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, '.harness')

export default async function globalSetup() {
  mkdirSync(out, { recursive: true })

  // Two harness pages share the same compiled Tailwind: the <ModeTabs/> tab-bar page (mount.tsx →
  // bundle.js / index.html) and the props-only #236 DCA Positions dashboard page
  // (mount-dca.tsx → bundle-dca.js / dca.html). [chore/mobile-ux-polish-2]
  const esbuildOpts = {
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    // src/lib/constants.ts (pulled in transitively by the DCA components) reads process.env.* at
    // module top-level. There is no process in the browser, so shim an empty env — the env-derived
    // constants fall back to their defaults, which is exactly right for a presentational harness.
    banner: { js: 'globalThis.process=globalThis.process||{env:{}};' },
    logLevel: 'silent',
  }
  await build({ ...esbuildOpts, entryPoints: [join(here, 'mount.tsx')], outfile: join(out, 'bundle.js') })
  await build({ ...esbuildOpts, entryPoints: [join(here, 'mount-dca.tsx')], outfile: join(out, 'bundle-dca.js') })

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

  const html = (bundle) =>
    '<!doctype html><html class="dark"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="./styles.css"></head>' +
    `<body><div id="root"></div><script src="./${bundle}"></script></body></html>`
  writeFileSync(join(out, 'index.html'), html('bundle.js'))
  writeFileSync(join(out, 'dca.html'), html('bundle-dca.js'))
}

// [chore/mobile-ux-polish-2] Also runnable standalone (`node e2e/mobile/build.mjs`) so CI can build the
// harness as an EXPLICIT step before Playwright — belt-and-suspenders, not relying solely on the
// Playwright globalSetup. (globalSetup still calls the same default export; the build is idempotent.)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  globalSetup().catch((e) => { console.error(e); process.exit(1) })
}
