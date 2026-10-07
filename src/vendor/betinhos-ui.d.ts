// Tipos mínimos do bundle do Design System Betinhos usados pelo painel.
import type { ComponentType } from 'react'

export type SelectOption = { value: string; label: string; subtitle?: string; search?: string; group?: string; disabled?: boolean }

declare const Betinhos: {
  Select: ComponentType<{
    options: SelectOption[]
    value: string | null
    onChange: (v: string | null) => void
    searchable?: boolean
    clearable?: boolean
    placeholder?: string
    size?: 'default' | 'compact'
    'aria-label'?: string
  }>
  [name: string]: ComponentType<any>
}
export default Betinhos
