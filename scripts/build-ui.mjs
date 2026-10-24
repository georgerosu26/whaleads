// Builds the SPA into dist/ with Vite, unless dist/ is already newer than every input.
//
// Why: Workers Builds runs the build command (`npm run build`) and then `wrangler deploy`, which runs the
// `build.command` in wrangler.jsonc (also `npm run build`) again, and `wrangler dev` runs it on every start.
// The second and later runs find a fresh dist/ and return in milliseconds. Set FORCE_BUILD=1 to always rebuild.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const out = 'dist/index.html'
const inputs = ['ui', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'tsconfig.json', 'package-lock.json']

function newest(p) {
  if (!existsSync(p)) return 0
  const st = statSync(p)
  if (!st.isDirectory()) return st.mtimeMs
  let m = 0
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    m = Math.max(m, newest(join(p, e.name)))
  }
  return m
}

if (!process.env.FORCE_BUILD && existsSync(out)) {
  const built = statSync(out).mtimeMs
  const changed = Math.max(...inputs.map(newest))
  if (built >= changed) {
    console.log('build: dist/ is up to date, skipping (FORCE_BUILD=1 to rebuild)')
    process.exit(0)
  }
}
const r = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
