// Sobe o `tauri dev` na porta reservada (devUrl do tauri.conf.json). Se a porta já estiver
// ocupada por um dev server deste projeto, encerra o processo e sobe de novo. Se for outro serviço, falha.
import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve('.')
const conf = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'))
const port = Number(new URL(conf.build.devUrl).port)
if (!port) throw new Error('devUrl sem porta em src-tauri/tauri.conf.json')

function pidsOnPort() {
  let out = ''
  try { out = execSync('netstat -ano', { encoding: 'utf8' }) } catch { return [] }
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) pids.add(Number(cols[4]))
  }
  return [...pids].filter((pid) => pid > 0)
}

function commandLine(pid) {
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: 'utf8' },
    ).trim()
  } catch { return '' }
}

for (const pid of pidsOnPort()) {
  const cmd = commandLine(pid)
  if (!cmd.toLowerCase().includes(projectRoot.toLowerCase())) {
    console.error(`Porta ${port} ocupada por outro serviço (PID ${pid}): ${cmd || 'comando desconhecido'}`)
    process.exit(1)
  }
  console.log(`Porta ${port} em uso pelo dev server (PID ${pid}). Encerrando...`)
  execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
}

for (let i = 0; i < 20 && pidsOnPort().length; i++) await new Promise((r) => setTimeout(r, 250))

const child = spawn(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), 'dev'], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
