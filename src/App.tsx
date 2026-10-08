// Painel Agentes: chats do Claude/Codex e pendências do Git numa linha do tempo em grafo.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  type MouseEvent as RMouseEvent, forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle,
  useMemo, useRef, useState, useSyncExternalStore,
} from 'react'
import { ICON } from './icons'
import {
  type Focus, type GitInfo, type Pending, type Run, type Status,
  ACTIVE_MS, FOCUS, IN_TAURI, PENDING_MS, RANK, REFRESH_MS,
  ago, collapse, folderOf, loadDismissed, saveDismissed, isLive, link, np, plural, projectOf, request, statusMemo, ticks,
} from './model'
import { type Item, type MenuReq, Menu, RemoveModal } from './Overlays'
import { type Bridge, type Tab, Settings, updates } from './settings'
import { LABEL_W, Legend, Project, Tooltip } from './Timeline'
import B from './vendor/betinhos-ui.js'

type UI = { q: string; focus: Focus; agent: string; project: string; days: number; archived: boolean }

function loadUi(): UI {
  let s: Partial<UI> = {}
  try { s = JSON.parse(localStorage.getItem('filters') ?? '{}') } catch { /* sem armazenamento */ }
  return { q: '', focus: s.focus ?? 'pending', agent: s.agent ?? 'all', project: s.project ?? '', days: Number(s.days ?? 7), archived: Boolean(s.archived) }
}

const DAYS = [3, 7, 30, 90].map((d) => ({ value: String(d), label: `${d} dias` }))
const PREVIEW_ONLY = 'Esta é só a pré-visualização no navegador; as ações funcionam no app'
const appWin = IN_TAURI ? getCurrentWindow() : null

/** Janela na bandeja ou minimizada não precisa atualizar a tela (o aviso do Windows segue pelo backend). */
async function onScreen() {
  if (document.hidden) return false
  if (!appWin) return true
  try { return (await appWin.isVisible()) && !(await appWin.isMinimized()) } catch { return true }
}

// ---------- Dica ao passar o mouse (posicionada direto no DOM, sem redesenhar o painel) ----------
type TipApi = { show: (r: Run | null, s?: Status) => void; move: (ev: MouseEvent) => void }
const Tip = forwardRef<TipApi>(function Tip(_, ref) {
  const el = useRef<HTMLDivElement>(null)
  const [cur, setCur] = useState<{ r: Run; s: Status } | null>(null)
  useImperativeHandle(ref, () => ({
    show: (r, s) => setCur(r && s ? { r, s } : null),
    move: (ev) => {
      const t = el.current!
      const pad = 16, w = t.offsetWidth, h = t.offsetHeight
      const left = ev.clientX + pad + w > innerWidth ? ev.clientX - w - pad : ev.clientX + pad
      const top = Math.min(ev.clientY + pad, innerHeight - h - 8)
      t.style.transform = `translate(${left}px, ${top}px)`
    },
  }), [])
  return <div ref={el} className={`tip${cur ? ' show' : ''}`} aria-hidden="true">{cur ? <Tooltip r={cur.r} s={cur.s} /> : null}</div>
})

function Toast({ t }: { t: { msg: string; error: boolean; n: number } | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!t) return
    setShow(true)
    const id = setTimeout(() => setShow(false), t.error ? 5000 : 2200)
    return () => clearTimeout(id)
  }, [t])
  return <div className={`toast${show ? ' show' : ''}${t?.error ? ' error' : ''}`} role="status">{t?.msg}</div>
}

export function App() {
  const [ui, setUi] = useState(loadUi)
  const [runs, setRuns] = useState<Run[]>([])
  const [pendings, setPendings] = useState<Pending[]>([])
  const [dismissed, setDismissed] = useState(loadDismissed)
  const [lastLoad, setLastLoad] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [spin, setSpin] = useState(false)
  const [boardW, setBoardW] = useState(0)
  const [menu, setMenu] = useState<MenuReq | null>(null)
  const [removing, setRemoving] = useState<{ ok: Pending[]; skipped: number } | null>(null)
  const [toastS, setToastS] = useState<{ msg: string; error: boolean; n: number } | null>(null)
  const [settingsReq, setSettingsReq] = useState<{ tab: Tab; n: number } | null>(null)
  const q = useDeferredValue(ui.q)
  const upd = useSyncExternalStore(updates.subscribe, updates.get)

  const boardRef = useRef<HTMLElement>(null)
  const qRef = useRef<HTMLInputElement>(null)
  const tipRef = useRef<TipApi>(null)
  const uiRef = useRef(ui); uiRef.current = ui
  const menuOpen = useRef(false); menuOpen.current = Boolean(menu)
  const busy = useRef({ loading: false, lastLoad: 0, lastPending: 0 })

  const patch = (p: Partial<UI>) => setUi((u) => ({ ...u, ...p }))
  const toast = useCallback((msg: string, error = false) => setToastS((t) => ({ msg, error, n: (t?.n ?? 0) + 1 })), [])

  useEffect(() => {
    const { focus, agent, project, days, archived } = ui
    try { localStorage.setItem('filters', JSON.stringify({ focus, agent, project, days, archived })) } catch { /* sem armazenamento */ }
  }, [ui.focus, ui.agent, ui.project, ui.days, ui.archived])

  // ---------- Carga ----------
  const loadPending = useCallback(async (fresh = false) => {
    busy.current.lastPending = Date.now()
    try {
      setPendings(IN_TAURI
        ? await invoke<Pending[]>('list_pending', { fresh })
        : await fetch('/mock-pending.json').then((r) => r.json()))
    } catch (e) {
      toast(`Não consegui verificar as pendências: ${e}`, true)
    }
  }, [toast])

  const load = useCallback(async (manual = false) => {
    const b = busy.current
    if (b.loading) return
    b.loading = true
    setSpin(true)
    try {
      const { days, archived } = uiRef.current
      // Fora do Tauri (pré-visualização no navegador durante o dev) usa o dump gerado por `painel-agentes.exe --dump`.
      setRuns(IN_TAURI
        ? await invoke<Run[]>('list_runs', { days, archived })
        : await fetch('/mock-runs.json').then((r) => r.json()))
      b.lastLoad = Date.now()
      setLastLoad(b.lastLoad)
      setNow(b.lastLoad)
      if (manual || Date.now() - b.lastPending > PENDING_MS) void loadPending(manual)
      if (manual) toast('Atualizado')
    } catch (e) {
      toast(`Não consegui ler os chats: ${e}`, true)
    } finally {
      b.loading = false
      setSpin(false)
    }
  }, [loadPending, toast])

  // Primeira carga e sempre que o período ou os arquivados mudam.
  useEffect(() => { void load() }, [ui.days, ui.archived, load])

  useEffect(() => {
    const t1 = setInterval(async () => { if (await onScreen()) void load() }, REFRESH_MS)
    const t2 = setInterval(async () => { if (busy.current.lastLoad && !menuOpen.current && (await onScreen())) setNow(Date.now()) }, 30_000)
    const focus = () => { if (Date.now() - busy.current.lastLoad > 10_000) void load() }
    const key = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey && ev.key.toLowerCase() === 'f') || (ev.key === '/' && document.activeElement !== qRef.current)) {
        ev.preventDefault(); qRef.current?.focus(); qRef.current?.select()
      }
      if (ev.key === 'F5') { ev.preventDefault(); void load(true) }
    }
    window.addEventListener('focus', focus)
    document.addEventListener('keydown', key)
    return () => { clearInterval(t1); clearInterval(t2); window.removeEventListener('focus', focus); document.removeEventListener('keydown', key) }
  }, [load])

  useEffect(() => {
    if (!IN_TAURI) return
    let fsTimer = 0
    const offs = [
      // O backend respondeu na hora com o último estado; aqui chegam os resultados frescos, em lotes.
      listen<{ id: string; git: GitInfo | null }[]>('run-git', (e) => {
        const fresh = new Map(e.payload.map((x) => [x.id, x.git]))
        setRuns((rs) => rs.some((r) => fresh.has(r.id)) ? rs.map((r) => (fresh.has(r.id) ? { ...r, git: fresh.get(r.id)!, stale: false } : r)) : rs)
      }),
      // O vigia de arquivos avisou que uma pasta mudou: recarrega (agrupando várias pastas numa só).
      listen<string[]>('fs-changed', () => {
        clearTimeout(fsTimer)
        fsTimer = window.setTimeout(async () => { if (await onScreen()) void load() }, 1000)
      }),
      listen('pending-updated', () => void loadPending()),
      listen('open-settings', () => setSettingsReq((r) => ({ tab: 'geral', n: (r?.n ?? 0) + 1 }))),
    ]
    const t0 = setTimeout(() => void updates.check(true), 5_000)
    const t1 = setInterval(() => void updates.check(true), 4 * 3_600_000)
    return () => { clearTimeout(fsTimer); clearTimeout(t0); clearInterval(t1); offs.forEach((p) => void p.then((f) => f())) }
  }, [load, loadPending])

  useEffect(() => { if (upd.s === 'error' && upd.version) toast(upd.msg, true) }, [upd, toast])

  // Largura do grafo acompanha o painel.
  useEffect(() => {
    const el = boardRef.current!
    const ro = new ResizeObserver(() => setBoardW((w) => (Math.abs(el.clientWidth - w) > 4 ? el.clientWidth : w)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 26px de padding de cada lado mais 1px de borda do painel em cada lado.
  const width = Math.max(320, boardW - LABEL_W - 54)

  // ---------- Dados derivados ----------
  const linked = useMemo(() => link(runs, pendings), [runs, pendings])
  const { cleanups, unpushedBy } = linked
  const statusOf = useMemo(() => statusMemo(dismissed), [linked, now, dismissed])

  /** Chats e pendências sem chat que passam nos filtros de texto, agente e projeto (o foco é aplicado depois, para as contagens). */
  const all = useMemo(() => {
    const t = q.trim().toLowerCase()
    return [...linked.runs, ...linked.orphans].filter((r) => {
      if (ui.agent !== 'all' && r.agent !== ui.agent) return false
      if (ui.project && projectOf(r) !== ui.project) return false
      if (!t) return true
      return [r.title, projectOf(r), r.git?.branch ?? '', r.cwd].some((s) => s.toLowerCase().includes(t))
    })
  }, [linked, q, ui.agent, ui.project])

  const projects = useMemo(() => {
    const names = [...new Set([...linked.runs, ...linked.orphans].map(projectOf))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
    if (ui.project && !names.includes(ui.project)) names.unshift(ui.project)
    return names.map((n) => ({ value: n, label: n }))
  }, [linked, ui.project])

  const test = FOCUS.find((f) => f.v === ui.focus)!.test
  const list = useMemo(() => collapse(all.filter((r) => test(statusOf(r))), statusOf), [all, test, statusOf])
  const byId = useMemo(() => new Map([...all, ...list].map((r) => [r.id, r])), [all, list])

  const ordered = useMemo(() => {
    const groups = new Map<string, Run[]>()
    for (const r of list) {
      const name = projectOf(r)
      const g = groups.get(name)
      if (g) g.push(r)
      else groups.set(name, [r])
    }
    // Push pendente na base também é trabalho por integrar, mesmo sem chat no período.
    if (ui.focus !== 'need') {
      const t = q.trim().toLowerCase()
      for (const [name] of unpushedBy) {
        if ((!ui.project || name === ui.project) && (!t || name.toLowerCase().includes(t)) && !groups.has(name)) groups.set(name, [])
      }
    }
    const urgency = (rs: Run[]) => Math.min(...rs.map((r) => RANK[statusOf(r)]), 2)
    return [...groups.entries()].sort((a, b) => {
      const ga = a[1].some((r) => r.git) || unpushedBy.has(a[0]), gb = b[1].some((r) => r.git) || unpushedBy.has(b[0])
      if (ga !== gb) return ga ? -1 : 1
      return urgency(a[1]) - urgency(b[1]) || Math.max(0, ...b[1].map((r) => r.updatedAt)) - Math.max(0, ...a[1].map((r) => r.updatedAt))
    })
  }, [list, ui.focus, ui.project, q, unpushedBy, statusOf])

  // ---------- Ações ----------
  const call = async (cmd: string, args: Record<string, string>) => {
    if (!IN_TAURI) { toast(PREVIEW_ONLY, true); return false }
    try { await invoke(cmd, args); return true } catch (e) { toast(String(e), true); return false }
  }

  const copy = async (text: string, msg: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.append(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast(msg)
  }

  const openRun = (r: Run) => {
    if (r.openUrl) { toast('Abrindo chat…'); void call('open_run', { url: r.openUrl }) } else void call('open_folder', { path: folderOf(r) })
  }

  const confirmRemove = (ps: Pending[]) => {
    // Worktree de um chat ativo agora fica de fora: o agente ainda pode estar usando a pasta.
    const inUse = (p: Pending) => runs.some((r) => np(r.cwd) === np(p.path) && Date.now() - r.updatedAt < ACTIVE_MS)
    const ok = ps.filter((p) => !inUse(p))
    setRemoving({ ok, skipped: ps.length - ok.length })
  }

  /** Baixa vale para a linha e os chats agrupados nela; desfazer remove a marca. */
  const setDone = (r: Run, done: boolean) => {
    const next = { ...dismissed }
    for (const x of [r, ...(r.others ?? [])]) {
      if (done) next[x.id] = x.updatedAt
      else delete next[x.id]
    }
    setDismissed(next)
    saveDismissed(next)
    toast(done ? 'Baixa dada: volta a aparecer se tiver atividade nova' : 'Baixa desfeita')
  }

  function runItems(r: Run): Item[] {
    const items: Item[] = []
    const g = r.git
    if (r.openUrl) items.push({ label: `Abrir chat no ${r.agent === 'codex' ? 'Codex' : 'Claude'}`, icon: ICON.chat, hint: 'Enter', act: () => openRun(r) })
    for (const o of (r.others ?? []).slice(0, 5)) if (o.openUrl) items.push({ label: o.title, icon: ICON.chat, group: 'Outros chats nesta branch', act: () => openRun(o) })
    items.push({ label: 'Abrir pasta', icon: ICON.folder, group: 'Ações', act: () => void call('open_folder', { path: folderOf(r) }) })
    items.push({ label: 'Abrir no VS Code', icon: ICON.code, act: () => void call('open_editor', { path: folderOf(r) }) })
    for (const p of r.prs.filter((p) => p.url)) items.push({ label: `Abrir PR #${p.number} no GitHub`, icon: ICON.pr, act: () => void call('open_link', { url: p.url }) })
    if (g) items.push({ label: 'Copiar nome da branch', icon: ICON.copy, act: () => void copy(g.branch, `Copiado: ${g.branch}`) })
    const req = request(r, unpushedBy.get(projectOf(r)))
    if (req) items.push({ label: 'Copiar pedido para finalizar', icon: ICON.send, act: () => void copy(req, 'Pedido copiado: cole no chat do agente') })
    const s = statusOf(r)
    if (s === 'need' || s === 'open') items.push({ label: 'Dar baixa (não preciso mais)', icon: ICON.check, act: () => setDone(r, true) })
    if (s === 'done') items.push({ label: 'Desfazer baixa', icon: ICON.check, act: () => setDone(r, false) })
    const wt = cleanups.find((p) => np(p.path) === np(r.cwd))
    if (wt) items.push({ label: 'Remover worktree mesclada', icon: ICON.trash, danger: true, act: () => confirmRemove([wt]) })
    return items
  }

  function projItems(name: string): Item[] {
    const any = [...linked.runs, ...linked.orphans].find((r) => projectOf(r) === name && r.git)
    const push = unpushedBy.get(name)
    const root = push?.repoRoot ?? any?.git?.repoRoot ?? any?.cwd
    const items: Item[] = []
    if (root) {
      items.push({ label: 'Abrir pasta do repositório', icon: ICON.folder, act: () => void call('open_folder', { path: root }) })
      items.push({ label: 'Abrir no VS Code', icon: ICON.code, act: () => void call('open_editor', { path: root }) })
    }
    if (push) {
      const req = `Há ${plural(push.count, 'commit', 'commits')} na \`${push.base}\` de ${push.repoRoot} que ainda não foram enviados ao GitHub. Confira e faça o push.`
      items.push({ label: 'Copiar pedido de push', icon: ICON.send, act: () => void copy(req, 'Pedido copiado: cole no chat do agente') })
    }
    const clean = cleanups.filter((p) => p.project === name)
    if (clean.length) items.push({ label: `Remover ${plural(clean.length, 'worktree mesclada', 'worktrees mescladas')}`, icon: ICON.trash, danger: true, act: () => confirmRemove(clean) })
    return items
  }

  // ---------- Destaque e dica ao passar o mouse ----------
  const hoverId = useRef('')
  const hover = (id: string, ev?: MouseEvent) => {
    if (id !== hoverId.current) {
      const board = boardRef.current!
      board.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'))
      hoverId.current = id
      if (id) board.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((e) => e.classList.add('hl'))
      const r = byId.get(id)
      tipRef.current?.show(r ?? null, r && statusOf(r))
    }
    if (ev && id) tipRef.current?.move(ev)
  }
  // Ao redesenhar, o destaque some com os elementos antigos: some a dica também.
  useEffect(() => { hoverId.current = ''; tipRef.current?.show(null) }, [byId])

  const closeMenu = useCallback((restore = false) => {
    setMenu((m) => { if (restore) m?.ret?.focus(); return null })
  }, [])

  /** Abre o menu da linha (chat ou cabeçalho de projeto) que contém o elemento. */
  const menuFor = (el: Element, x: number, y: number, keyboard = false) => {
    hover('')
    const head = el.closest<HTMLElement>('[data-proj]')
    if (head) { setMenu({ items: projItems(head.dataset.proj!), x, y, keyboard, ret: head }); return true }
    const row = el.closest<HTMLElement | SVGElement>('[data-id]')
    const r = row && byId.get(row.dataset.id!)
    if (!r) return false
    const ret = boardRef.current!.querySelector<HTMLElement>(`.trow[data-id="${CSS.escape(r.id)}"]`)
    setMenu({ items: runItems(r), x, y, keyboard, ret })
    return true
  }

  const move = useRef<MouseEvent | null>(null)
  // Um cálculo de dica por quadro, mesmo com o mouse disparando vários eventos entre eles.
  const onMouseMove = (ev: RMouseEvent) => {
    if (!move.current) requestAnimationFrame(() => {
      const e = move.current!
      move.current = null
      const t = e.target as Element
      // Sobre o botão de ações a dica atrapalha a leitura do menu.
      const el = t.closest('[data-more]') || menuOpen.current ? null : t.closest<HTMLElement | SVGElement>('[data-id]')
      hover(el?.dataset.id ?? '', e)
    })
    move.current = ev.nativeEvent
  }

  const clearFilters = () => patch({ q: '', focus: 'pending', agent: 'all', project: '' })

  const onBoardClick = (ev: RMouseEvent) => {
    const t = ev.target as Element
    if (t.closest('[data-clear]')) { clearFilters(); return }
    if (t.closest('[data-focus-all]')) { patch({ focus: 'all' }); return }
    if (t.closest('[data-clean-all]')) { confirmRemove(cleanups.filter((p) => !ui.project || p.project === ui.project)); return }
    const cp = t.closest<HTMLElement>('[data-clean-proj]')
    if (cp) { confirmRemove(cleanups.filter((p) => p.project === cp.dataset.cleanProj)); return }
    const more = t.closest<HTMLElement>('[data-more], [data-push]')
    if (more) {
      const b = more.getBoundingClientRect()
      menuFor(more, b.right - 4, b.bottom + 4, ev.detail === 0)
      return
    }
    if (t.closest('[data-proj]')) return
    const el = t.closest<HTMLElement | SVGElement>('[data-id]')
    const r = el && byId.get(el.dataset.id!)
    if (r) openRun(r)
  }

  const onBoardKey = (ev: React.KeyboardEvent) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.trow[data-id]')
    if (!row || ev.target !== row) return
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); row.click() }
    // Shift+F10 e a tecla de menu abrem as ações pelo teclado.
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      ev.preventDefault()
      const b = row.getBoundingClientRect()
      menuFor(row, b.left + 24, b.bottom, true)
    }
  }

  // ---------- Configurações ----------
  const bridge = useMemo<Bridge>(() => ({
    view: () => { const { agent, days, archived } = uiRef.current; return { agent, days, archived } },
    applyView: (v) => patch(v),
    afterSave: () => void loadPending(true),
    toast,
  }), [loadPending, toast])
  const openSettings = () => setSettingsReq((r) => ({ tab: 'geral', n: (r?.n ?? 0) + 1 }))

  // ---------- Tela ----------
  const to = now
  const from = to - ui.days * 86_400_000
  const x = (t: number) => Math.round(((t - from) / (to - from)) * (width - 24)) + 12
  const tk = ticks(from, to, ui.days, width)
  const dayTicks = tk.map((t) => t.t)
  const visibleClean = cleanups.filter((p) => !ui.project || p.project === ui.project)
  const cleanLabel = `Limpar ${plural(visibleClean.length, 'worktree mesclada', 'worktrees mescladas')}`
  const title = { pending: 'O que está pendente', need: 'Esperando sua resposta', open: 'Falta integrar na base', done: 'Pendências com baixa', all: 'Todas as branches' }[ui.focus]

  const st = all.map(statusOf)
  const need = st.filter((s) => s === 'need').length
  const open = st.filter((s) => s === 'open').length
  const live = all.filter(isLive).length
  const verifying = all.filter((r) => r.stale).length

  let board
  if (!lastLoad) {
    board = <div className="loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><p>Lendo chats e repositórios…</p></div>
  } else if (ordered.length) {
    board = (
      <section className="timeline">
        <div className="tl-head">
          <div><h2>{title}</h2><p>Cada linha sai da branch base, recebe commits e volta quando é mesclada</p></div>
          <div className="tl-tools"><Legend focus={ui.focus} />{visibleClean.length ? <button className="pill clean" data-clean-all>{ICON.tree}{cleanLabel}</button> : null}</div>
        </div>
        <div className="axis">
          <div className="axis-lbl">Branch · o que falta</div>
          <div className="axis-track">
            {/* "hoje" ocupa o último rótulo; os outros ficam só se não encostarem nele. */}
            {tk.filter((t) => x(to) - x(t.t) > 190).map((t) => <span key={t.t} className="tick" style={{ left: x(t.t) }}>{t.label}</span>)}
            <span className="now" style={{ left: x(to) + 1 }}>hoje · agora</span>
          </div>
        </div>
        {ordered.map(([name, rs]) => (
          <Project key={name} name={name} list={rs} sc={{ from, to, width }} dayTicks={dayTicks} statusOf={statusOf}
            unpushed={unpushedBy.get(name)} clean={cleanups.filter((p) => p.project === name).length} />
        ))}
      </section>
    )
  } else if (ui.focus === 'pending' && !ui.q && !ui.project && ui.agent === 'all') {
    board = (
      <div className="empty ok">
        <h2>Tudo integrado</h2><p>Nenhum chat esperando você e nada fora da base ou sem push.</p>
        {visibleClean.length ? <><button className="link-btn" data-clean-all>{cleanLabel}</button> </> : null}
        <button className="link-btn" data-focus-all>Ver todas as branches</button>
      </div>
    )
  } else {
    board = <div className="empty"><p>Nada nesse filtro nos últimos {ui.days} dias.</p><button className="link-btn" data-clear>Limpar filtros</button></div>
  }

  const showUpd = upd.s === 'available' || upd.s === 'downloading' || upd.s === 'installing'

  return (
    <>
      <div className="app">
        <header className="top">
          <div className="brand">
            <div className="logo" aria-hidden="true">{ICON.logo}</div>
            <div>
              <h1>Painel Agentes</h1>
              <p className="sub">
                {!lastLoad ? 'Lendo chats e repositórios…' : <>
                  {need ? <b className="s-need">{need} {need === 1 ? 'precisa' : 'precisam'} de você</b> : null}
                  {need && open ? ' · ' : null}
                  {open ? <b className="s-open">{open} {open === 1 ? 'falta' : 'faltam'} integrar</b> : null}
                  {!need && !open ? <b className="s-ok">Tudo integrado</b> : null}
                  {[live ? `${plural(live, 'ativo', 'ativos')} agora` : '', verifying ? `reverificando ${plural(verifying, 'pasta', 'pastas')}` : '', `atualizado ${ago(lastLoad)}`]
                    .filter(Boolean).map((s) => ` · ${s}`).join('')}
                </>}
              </p>
            </div>
          </div>
          <div className="controls">
            <label className="search">
              {ICON.search}
              <input ref={qRef} type="search" placeholder="Buscar chat, projeto ou branch" autoComplete="off" value={ui.q} onChange={(e) => patch({ q: e.target.value })} />
            </label>
            <div className="sel-project">
              <B.Select options={projects} value={ui.project || null} searchable placeholder="Todos os projetos" aria-label="Projeto"
                onChange={(v) => patch({ project: v ?? '' })} />
            </div>
            <div className="sel-days">
              <B.Select options={DAYS} value={String(ui.days)} searchable={false} clearable={false} aria-label="Período"
                onChange={(v) => { if (v) patch({ days: Number(v) }) }} />
            </div>
            <button className="update-btn" hidden={!showUpd} disabled={upd.s !== 'available'} onClick={() => void updates.install()}>
              {upd.s === 'available' ? `Atualizar para v${upd.version}` : upd.s === 'downloading' ? `Baixando ${upd.pct}%` : 'Instalando…'}
            </button>
            <button className={`icon-btn${spin ? ' spin' : ''}`} title="Atualizar agora (F5)" aria-label="Atualizar agora" onClick={() => void load(true)}>{ICON.refresh}</button>
            <button className="icon-btn" title="Configurações" aria-label="Abrir configurações" onClick={openSettings}>{ICON.gear}</button>
          </div>
        </header>

        <nav className="chips" aria-label="Foco">
          {FOCUS.map(({ v, label, color, test: t }) => (
            <button key={v} className={`chip${ui.focus === v ? ' on' : ''}`} aria-pressed={ui.focus === v} style={{ '--c': color } as React.CSSProperties}
              onClick={() => patch({ focus: v })}>{label}<b>{st.filter(t).length}</b></button>
          ))}
        </nav>
        <main ref={boardRef} className="board" aria-live="polite"
          onMouseMove={onMouseMove} onMouseLeave={() => { move.current = null; hover('') }}
          onScroll={() => { hover(''); if (menu) closeMenu() }}
          onClick={onBoardClick} onKeyDown={onBoardKey}
          onContextMenu={(ev) => { if (menuFor(ev.target as Element, ev.clientX, ev.clientY)) ev.preventDefault() }}>
          {board}
        </main>
      </div>

      <Tip ref={tipRef} />
      {menu ? <Menu req={menu} onClose={closeMenu} /> : null}
      {removing ? <RemoveModal ok={removing.ok} skipped={removing.skipped} inApp={IN_TAURI} toast={toast}
        onClose={() => setRemoving(null)} onFinish={() => void loadPending(true)} /> : null}
      <Toast t={toastS} />
      <Settings bridge={bridge} req={settingsReq} />
      <div className="version" aria-hidden="true">v{__APP_VERSION__} · {__BUILD_DATE__}</div>
    </>
  )
}

