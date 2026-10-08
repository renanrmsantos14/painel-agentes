// Publica uma versão nova no GitHub Releases (renanrmsantos14/painel-agentes):
// incrementa o PATCH, compila o instalador assinado, gera latest.json e cria a release.
// A chave de assinatura fica fora do repositório: no CI vem do secret TAURI_SIGNING_PRIVATE_KEY,
// na máquina local de ~/.tauri/painel-agentes.key.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = 'renanrmsantos14/painel-agentes'
const keyPath = join(homedir(), '.tauri', 'painel-agentes.key')
const key = process.env.TAURI_SIGNING_PRIVATE_KEY || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : '')
if (!key) throw new Error(`Chave de assinatura não encontrada (secret TAURI_SIGNING_PRIVATE_KEY ou ${keyPath})`)

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: false })

run(process.execPath, ['scripts/bump-version.mjs'])
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build'], {
  TAURI_SIGNING_PRIVATE_KEY: key,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
})

const dir = resolve('src-tauri/target/release/bundle/nsis')
const exe = `Painel Agentes_${version}_x64-setup.exe`
const sig = readFileSync(join(dir, `${exe}.sig`), 'utf8').trim()
// Nome sem espaços no Releases, para a URL ficar estável.
const asset = `Painel-Agentes_${version}_x64-setup.exe`
const latest = {
  version,
  notes: `Painel Agentes v${version}`,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: sig, url: `https://github.com/${REPO}/releases/download/v${version}/${asset}` } },
}
writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest, null, 2))
copyFileSync(join(dir, exe), join(dir, asset))

run('gh', ['release', 'create', `v${version}`, join(dir, asset), join(dir, 'latest.json'),
  '--repo', REPO, '--title', `v${version}`, '--notes', `Painel Agentes v${version}`])
// Grava a versão publicada na base; o prefixo "release:" impede o workflow de disparar de novo.
run('git', ['add', 'package.json'])
run('git', ['commit', '-m', `release: v${version}`])
run('git', ['push', 'origin', 'HEAD:master'])
console.log(`Publicada v${version}`)
