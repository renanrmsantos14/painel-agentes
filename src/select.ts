// Select do Design System Betinhos (bt-select), portado para TS puro: painel próprio,
// busca sem acento, teclado completo e painel fixo que vira para cima quando falta espaço.

export type SelectOption = { value: string; label: string }
type Opts = { label: string; searchable?: boolean; onChange: (v: string) => void }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const CARET = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
let seq = 0

export function createSelect(host: HTMLElement, { label, searchable = true, onChange }: Opts) {
  const id = `bt-select-${++seq}`
  let options: SelectOption[] = []
  let value = ''
  let shown: SelectOption[] = []
  let active = -1

  host.classList.add('bt-control', 'bt-control--combobox')
  host.innerHTML = `<button type="button" class="bt-select__trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}" aria-label="${label}"><span class="bt-select__value"></span></button><span class="bt-select__caret">${CARET}</span>`
  const trigger = host.querySelector<HTMLButtonElement>('.bt-select__trigger')!
  const valueEl = host.querySelector<HTMLSpanElement>('.bt-select__value')!

  const panel = document.createElement('div')
  panel.className = 'bt-select-panel'
  panel.hidden = true
  panel.innerHTML = `${searchable ? '<input class="bt-select-panel__search" type="text" placeholder="Pesquisar" autocomplete="off" aria-label="Pesquisar">' : ''}<div class="bt-select-panel__list" role="listbox" id="${id}" aria-label="${label}"></div>`
  const search = panel.querySelector<HTMLInputElement>('.bt-select-panel__search')
  const list = panel.querySelector<HTMLDivElement>('.bt-select-panel__list')!
  document.body.append(panel)

  const paintValue = () => { valueEl.textContent = options.find((o) => o.value === value)?.label ?? '' }

  function paintList() {
    const words = norm(search?.value ?? '').split(/\s+/).filter(Boolean)
    shown = options.filter((o) => words.every((w) => norm(o.label).includes(w)))
    active = Math.min(Math.max(active, 0), shown.length - 1)
    list.innerHTML = shown.length
      ? shown.map((o, i) => `<div class="bt-select-option${i === active ? ' is-active' : ''}" role="option" id="${id}-${i}" data-i="${i}" aria-selected="${o.value === value}"><span class="bt-select-option__label">${o.label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</span></div>`).join('')
      : '<p class="bt-select-panel__status">Nenhuma opção encontrada</p>'
    const el = list.querySelector<HTMLElement>('.is-active')
    trigger.setAttribute('aria-activedescendant', el?.id ?? '')
    el?.scrollIntoView({ block: 'nearest' })
  }

  function place() {
    const r = host.getBoundingClientRect()
    const below = innerHeight - r.bottom - 8, above = r.top - 8
    const up = below < 200 && above > below
    panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 220) - 8))}px`
    panel.style.width = `${Math.max(r.width, 220)}px`
    panel.style.maxHeight = `${Math.min(260, up ? above : below)}px`
    panel.style.top = up ? '' : `${r.bottom + 4}px`
    panel.style.bottom = up ? `${innerHeight - r.top + 4}px` : ''
  }

  const isOpen = () => !panel.hidden
  function open() {
    if (isOpen()) return
    if (search) search.value = ''
    active = Math.max(0, options.findIndex((o) => o.value === value))
    panel.hidden = false
    host.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
    place(); paintList()
    // Em tela de toque a busca não ganha foco, para o teclado virtual não cobrir a lista.
    if (search && matchMedia('(pointer: fine)').matches) search.focus()
  }
  function close(refocus = false) {
    if (!isOpen()) return
    panel.hidden = true
    host.classList.remove('is-open')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-activedescendant')
    if (refocus) trigger.focus()
  }
  function choose(i: number) {
    const o = shown[i]
    if (!o) return
    close(true)
    if (o.value === value) return
    value = o.value
    paintValue()
    onChange(value)
  }

  function onKey(e: KeyboardEvent) {
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open() }
      return
    }
    const last = shown.length - 1
    const move: Record<string, number> = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: last }
    if (e.key in move) { e.preventDefault(); active = Math.min(Math.max(move[e.key], 0), last); paintList() }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active) }
    else if (e.key === 'Escape') { e.preventDefault(); close(true) }
    else if (e.key === 'Tab') close()
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()))
  trigger.addEventListener('keydown', onKey)
  search?.addEventListener('keydown', onKey)
  search?.addEventListener('input', () => { active = 0; paintList() })
  list.addEventListener('mousedown', (e) => e.preventDefault()) // mantém o foco na busca
  list.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')
    if (el) choose(Number(el.dataset.i))
  })
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !host.contains(e.target as Node) && !panel.contains(e.target as Node)) close()
  })
  addEventListener('resize', () => isOpen() && place())
  addEventListener('scroll', (e) => isOpen() && !panel.contains(e.target as Node) && place(), true)

  return {
    setOptions(next: SelectOption[]) { options = next; paintValue(); if (isOpen()) paintList() },
    setValue(v: string) { value = v; paintValue() },
    get value() { return value },
  }
}
