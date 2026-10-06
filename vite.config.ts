import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const port = Number(new URL(conf.build.devUrl).port)

const buildDate = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date()).replace(',', '')

export default defineConfig({
  clearScreen: false,
  server: { port, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  build: { target: 'es2022' },
})
