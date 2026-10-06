// Diagnóstico: mede o custo dos comandos git da varredura de pendências, por repositório.
// Uso: node scripts/profile-pending.cjs (depois de `painel-agentes.exe --dump`).
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const items = require(path.resolve(__dirname, '../src-tauri/target/release/painel-pendencias.json'))
const g = (dir, args) => {
  const s = Date.now()
  try { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', maxBuffer: 1 << 28 }) } catch {}
  return Date.now() - s
}
const rows = []
for (const repo of [...new Set(items.map((p) => p.repoRoot))]) {
  const wts = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
  let status = 0
  for (const w of wts) status += g(w, ['status', '--porcelain'])
  const refs = g(repo, ['for-each-ref', 'refs/heads'])
  rows.push([status + refs, `status ${status}ms (${wts.length} wt) refs ${refs}ms`, path.basename(repo)])
}
rows.sort((a, b) => b[0] - a[0])
console.log(rows.slice(0, 10).map((r) => r.join(' | ')).join('\n'))
