// Registra a porta reservada deste projeto em ~/.codex/dev-ports.json (caminho absoluto -> porta).
const fs = require('node:fs')
const path = require('node:path')
const f = path.join(process.env.USERPROFILE, '.codex', 'dev-ports.json')
const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'))
const port = Number(new URL(conf.build.devUrl).port)
const root = path.resolve(__dirname, '..')
const j = JSON.parse(fs.readFileSync(f, 'utf8'))
for (const [k, v] of Object.entries(j)) if (v === port && k !== root) delete j[k]
j[root] = port
fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
console.log(`${root} -> ${port}`)
