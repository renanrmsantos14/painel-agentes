import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Versão de build (não é versão Git): cada build de publicação incrementa o PATCH.
// A data/hora do build é gravada pelo vite.config.ts (__BUILD_DATE__).
const packagePath = resolve('package.json')
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
const match = String(packageJson.version).match(/^(\d+)\.(\d+)\.(\d+)$/)
if (!match) throw new Error(`Versão inválida em ${packagePath}: ${packageJson.version}`)
packageJson.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
console.log(`Build v${packageJson.version}`)
