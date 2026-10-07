// Ponte entre o painel (TS puro) e o Select do Design System Betinhos (React):
// cada filtro vira uma pequena raiz React, controlada por setOptions/setValue.
import './react-global'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import Betinhos, { type SelectOption } from './vendor/betinhos-ui.js'
import './vendor/betinhos-tokens.css'
import './vendor/betinhos-ui.css'

export type { SelectOption }
type Opts = { label: string; searchable?: boolean; clearable?: boolean; placeholder?: string; onChange: (v: string) => void }

export function createSelect(host: HTMLElement, { label, searchable = true, clearable, placeholder, onChange }: Opts) {
  const root = createRoot(host)
  let options: SelectOption[] = []
  let value = ''

  const paint = () => root.render(createElement(Betinhos.Select, {
    options, value: value || null, searchable, clearable, placeholder, 'aria-label': label,
    onChange: (v) => {
      // Limpar devolve null: vira o valor vazio, que mostra o placeholder.
      const next = v ?? ''
      if (next === value) return
      value = next
      paint()
      onChange(value)
    },
  }))

  paint()
  return {
    setOptions(next: SelectOption[]) { options = next; paint() },
    setValue(v: string) { value = v; paint() },
    get value() { return value },
  }
}
