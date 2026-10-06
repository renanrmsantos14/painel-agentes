import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

declare const __APP_VERSION__: string
declare const __BUILD_DATE__: string

type Pr = { number: number; url: string; state: string }
type GitInfo = {
  project: string; repoRoot: string; branch: string; base: string; onBase: boolean; branchExists: boolean
  worktree: boolean; worktreeMissing: boolean; ahead: number; behind: number; merged: boolean
  commits: string[]; commitCount: number; files: number; insertions: number; deletions: number; dirty: number
}
type Run = {
  id: string; agent: 'claude' | 'codex'; title: string; cwd: string; createdAt: number; updatedAt: number
  archived: boolean; state: string | null; detail: string | null; needsAction: string | null
  prs: Pr[]; git: GitInfo | null; openUrl: string
}
type Pending = {
  key: string; kind: 'dirty' | 'unmerged' | 'unpushed' | 'cleanup'; project: string; repoRoot: string; path: string
  branch: string; base: string; count: number; lastActivity: number; commits: string[]; worktree: boolean
  chatTitle: string | null; chatUrl: string | null; chatAgent: 'claude' | 'codex' | null
}

const ACTIVE_MS = 10 * 60_000
// Pendência parada há mais que isso aparece como esquecida (e gera aviso do Windows).
const STALE_MS = 86_400_000
const REFRESH_MS = 45_000
// Pedidos parados há mais que isso deixam de contar como "Precisa de você" (o agente já foi deixado de lado).
const NEED_MS = 3 * 86_400_000

const ICON = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.2 7.4"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><path d="M12 21v-6M12 15l-5-4M12 15l5-4M7 11V6M17 11V6"/><circle cx="7" cy="4.5" r="1.5"/><circle cx="17" cy="4.5" r="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  pr: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const board = $<HTMLElement>('board')
const qInput = $<HTMLInputElement>('q')
const projectSel = $<HTMLSelectElement>('project')
const daysSel = $<HTMLSelectElement>('days')
const archivedChk = $<HTMLInputElement>('archived')
const refreshBtn = $<HTMLButtonElement>('refresh')
const summaryEl = $<HTMLElement>('summary')

const saved = (() => { try { return JSON.parse(localStorage.getItem('filters') ?? '{}') } catch { return {} } })()
const ui = {
  q: '',
  status: 'all' as 'all' | Status,
  agent: (saved.agent as string) ?? 'all',
  project: (saved.project as string) ?? '',
  days: Number(saved.days ?? 7),
  archived: Boolean(saved.archived),
}
let runs: Run[] = []
let pendings: Pending[] = []
let pendLoaded = false
let showCleanup = false
let showAllPend = false
// Pendências mostradas por padrão: as mais antigas; o resto fica atrás de "Mostrar todas".
const PEND_LIMIT = 5
let loading = false
let lastLoad = 0

function persist() {
  try { localStorage.setItem('filters', JSON.stringify({ agent: ui.agent, project: ui.project, days: ui.days, archived: ui.archived })) } catch { /* sem armazenamento */ }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'ontem' : `há ${d} dias`
}

function projectOf(r: Run) {
  return r.git?.project || r.cwd.split(/[\\/]/).filter(Boolean).pop() || 'Sem pasta'
}

/** Chats que passam nos filtros de texto, agente e projeto; o filtro por estado é aplicado depois, para as contagens dos chips. */
function filtered() {
  const q = ui.q.trim().toLowerCase()
  return runs.filter((r) => {
    if (ui.agent !== 'all' && r.agent !== ui.agent) return false
    if (ui.project && projectOf(r) !== ui.project) return false
    if (!q) return true
    return [r.title, projectOf(r), r.git?.branch ?? '', r.cwd].some((s) => s.toLowerCase().includes(q))
  })
}

type Status = 'need' | 'open' | 'merged' | 'main' | 'idle'

const CHIPS: { v: 'all' | Status; label: string }[] = [
  { v: 'all', label: 'Todos' }, { v: 'need', label: 'Precisa de você' }, { v: 'open', label: 'Não mesclados' }, { v: 'merged', label: 'Mesclados' }, { v: 'idle', label: 'Sem mudanças' },
]

function renderChips(list: Run[]) {
  const counts = list.reduce((m, r) => { const s = statusOf(r) === 'main' ? 'merged' : statusOf(r); m[s] = (m[s] ?? 0) + 1; return m }, {} as Record<string, number>)
  $<HTMLElement>('status').innerHTML = CHIPS.map(({ v, label }) => {
    const n = v === 'all' ? list.length : counts[v] ?? 0
    return `<button class="chip${ui.status === v ? ' on' : ''}" data-status="${v}" aria-pressed="${ui.status === v}" style="--c:${v === 'all' ? 'var(--bt-color-brand)' : STATUS[v].color}">${label}<b>${n}</b></button>`
  }).join('')
}

function renderProjects() {
  const names = [...new Set(runs.map(projectOf))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  if (ui.project && !names.includes(ui.project)) names.unshift(ui.project)
  projectSel.innerHTML = `<option value="">Todos os projetos</option>${names.map((n) => `<option ${n === ui.project ? 'selected' : ''}>${esc(n)}</option>`).join('')}`
}

// Cada estado é um par cor/fundo/texto do design system (status nunca só pela cor: a forma no grafo muda também).
const STATUS: Record<Status, { label: string; color: string; soft: string; text: string }> = {
  need: { label: 'Precisa de você', color: 'var(--need)', soft: 'var(--need-soft)', text: 'var(--need-text)' },
  open: { label: 'Não mesclado', color: 'var(--progress)', soft: 'var(--progress-soft)', text: 'var(--progress-text)' },
  merged: { label: 'Mesclado', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  main: { label: 'Direto na main', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  idle: { label: 'Sem mudanças', color: 'var(--idle)', soft: 'var(--idle-soft)', text: 'var(--idle-text)' },
}

const ROW = 44
const LABEL_W = 300
// Linha da branch base fica no meio da linha de cabeçalho do projeto.
const MAIN_Y = ROW / 2

function statusOf(r: Run): Status {
  const g = r.git
  if (r.needsAction && !r.archived && Date.now() - r.updatedAt < NEED_MS) return 'need'
  if (g) {
    if (g.dirty > 0 || (g.ahead > 0 && !g.merged)) return 'open'
    if (g.onBase && g.commitCount > 0) return 'main'
    if (g.merged && !g.onBase) return 'merged'
  }
  return 'idle'
}

function statusText(r: Run, s: Status) {
  const g = r.git
  if (!g) return 'Fora de um repositório'
  if (g.dirty > 0) return `${g.dirty} ${g.dirty === 1 ? 'arquivo não commitado' : 'arquivos não commitados'}`
  if (s === 'open') return `${g.ahead} ${g.ahead === 1 ? 'commit' : 'commits'} à frente da ${g.base}`
  if (s === 'merged') return `Mesclado na ${g.base}`
  if (s === 'main') return `Direto na ${g.base}`
  if (s === 'need') return 'Esperando sua resposta'
  if (!g.branchExists && !g.onBase) return 'Branch removida'
  return 'Sem mudanças'
}

/** Marcas do eixo do tempo: um rótulo por dia (ou por semana em períodos longos). */
function ticks(from: number, to: number) {
  // Passo em dias para manter ~80px entre rótulos.
  const perDay = (width - 24) / ui.days
  const step = [1, 2, 3, 7, 14, 30].find((n) => n * perDay >= 80) ?? 30
  const d = new Date(to)
  d.setHours(0, 0, 0, 0)
  const out: { t: number; label: string }[] = []
  for (let t = d.getTime(); t >= from; t -= step * 86_400_000) {
    const dt = new Date(t)
    const wd = dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')
    out.push({ t, label: `${wd} ${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` })
  }
  return out
}

/** Etiqueta curta do estado: PR aberto vale mais que o estado genérico. */
function badgeText(r: Run, s: Status) {
  const pr = r.prs.find((p) => p.url)
  if (s === 'merged' && pr) return `Mesclado · PR #${pr.number}`
  if (s === 'open' && pr) return `PR #${pr.number} aberto`
  if (s === 'open' && r.git && r.git.dirty > 0) return 'Não commitado'
  return STATUS[s].label
}

function label(r: Run, s: Status) {
  const g = r.git
  const live = Date.now() - r.updatedAt < ACTIVE_MS
  const agent = r.agent === 'claude' ? 'Claude' : 'Codex'
  const stats = g && (g.commitCount > 0 || g.files > 0)
    ? `<span class="stats"><span>${g.commitCount} ${g.commitCount === 1 ? 'commit' : 'commits'}</span><span class="add">+${g.insertions}</span><span class="del">−${g.deletions}</span></span>`
    : ''
  const behind = g && g.behind > 0 && !g.merged ? `<span>${g.behind} atrás da ${esc(g.base)}</span>` : ''
  const st = STATUS[s]
  return `<div class="lbl" style="--c:${st.color};--s-soft:${st.soft};--s-text:${st.text}">
    <div class="lbl-top">
      <span class="br" title="${esc(g?.branch ?? statusText(r, s))}">${esc(g?.branch ?? 'Sem repositório')}</span>
      <span class="badge">${esc(badgeText(r, s))}</span>
      ${live ? '<i class="live" title="Ativo agora"></i>' : ''}
    </div>
    <div class="lbl-sub">
      <i class="dot ${r.agent}" title="${agent}"></i>
      <span class="lbl-title">${agent} · ${esc(r.title)}</span>
      ${stats}${behind}
    </div>
  </div>`
}

function tooltip(r: Run, s: Status) {
  const g = r.git
  const commits = g?.commits ?? []
  const ask = s === 'need' && r.needsAction ? `<div class="tt-need">${esc(r.needsAction)}</div>` : r.detail ? `<div class="tt-detail">${esc(r.detail)}</div>` : ''
  const prs = r.prs.filter((p) => p.url).map((p) => `<span class="tt-pr">${ICON.pr}PR #${p.number} · ${esc(p.state.toLowerCase())}</span>`).join('')
  return `<div class="tt-head"><i class="dot ${r.agent}"></i>${r.agent === 'claude' ? 'Claude' : 'Codex'} · ${ago(r.updatedAt)}</div>
    <div class="tt-title">${esc(r.title)}</div>
    ${g ? `<div class="tt-branch">${ICON.branch}${esc(g.onBase ? g.branch : `${g.branch} → ${g.base}`)}${g.worktree ? ' · worktree' : ''}${g.worktreeMissing ? ' · worktree removida' : ''}</div>` : ''}
    ${ask}
    ${commits.length ? `<ul class="tt-commits">${commits.map((c) => `<li>${esc(c)}</li>`).join('')}${(g?.commitCount ?? 0) > commits.length ? `<li class="more">+ ${g!.commitCount - commits.length} outros</li>` : ''}</ul>` : ''}
    ${prs ? `<div class="tt-prs">${prs}</div>` : ''}
    <div class="tt-foot">Clique para abrir o chat · clique direito abre a pasta</div>`
}

/** Pontos de commit distribuídos ao longo da faixa (o Git não dá a data de cada commit aqui). */
function commitDots(n: number, x0: number, x1: number, y: number, c: string) {
  const span = x1 - x0
  if (n <= 0 || span < 24) return ''
  const k = Math.min(n, Math.floor(span / 28))
  const out: string[] = []
  for (let i = 1; i <= k; i++) out.push(`<circle class="commit" cx="${Math.round(x0 + (span * i) / (k + 1))}" cy="${y}" r="4.5" style="--c:${c}"/>`)
  return out.join('')
}

/**
 * Desenha um projeto como grafo de Git: a base é uma linha navy grossa no cabeçalho;
 * cada chat sai dela com uma curva, mostra seus commits como pontos e volta com um ponto cheio quando é mesclado.
 */
function project(name: string, list: Run[], from: number, to: number, width: number, dayTicks: number[]) {
  const base = list.find((r) => r.git)?.git?.base ?? ''
  const hasGit = list.some((r) => r.git)
  const x = (t: number) => Math.round(((Math.min(Math.max(t, from), to) - from) / (to - from)) * (width - 24)) + 12
  const rows = [...list].sort((a, b) => b.createdAt - a.createdAt)
  const H = ROW * (rows.length + 1)
  const svg: string[] = []
  const R = 24 // raio das curvas de saída e de retorno

  svg.push(`<path class="grid" d="${dayTicks.map((t) => `M${x(t)} 0V${H}`).join('')}"/>`)
  svg.push(`<line class="main-line${hasGit ? '' : ' muted'}" x1="${x(from)}" y1="${MAIN_Y}" x2="${x(to)}" y2="${MAIN_Y}"/>`)
  svg.push(`<line class="now-mark" x1="${x(to)}" y1="0" x2="${x(to)}" y2="${H}"/>`)

  rows.forEach((r, i) => {
    const s = statusOf(r)
    const y = ROW * (i + 1) + ROW / 2
    const live = Date.now() - r.updatedAt < ACTIVE_MS
    const x0 = x(r.createdAt)
    const x1 = Math.max(x(live ? to : r.updatedAt), x0 + R * 2 + 12)
    const st = STATUS[s]
    const c = st.color
    const g = r.git
    const pr = r.prs.find((p) => p.url)
    const cls = `lane ${s}${live ? ' live' : ''}${g ? '' : ' nogit'}`
    const style = `--c:${c};--s-text:${st.text}`
    const entering = r.createdAt < from // chat começou antes do período: entra pela borda, sem bifurcação

    if (!g || !hasGit) {
      svg.push(`<g class="${cls}" data-id="${esc(r.id)}" style="${style}"><path class="lane-line" d="M${x0} ${y}H${x1}"/><circle class="commit" cx="${x1}" cy="${y}" r="4.5"/></g>`)
      return
    }
    if (g.onBase) {
      // Commits feitos direto na base: faixa reta ligada por um ponto cheio na linha principal.
      svg.push(`<g class="${cls}" data-id="${esc(r.id)}" style="${style}">
        <path class="hint" d="M${x1} ${y}V${MAIN_Y + 6}"/>
        <path class="lane-line" d="M${x0} ${y}H${x1}"/>
        ${commitDots(g.commitCount, x0, x1, y, c)}
        ${s === 'main' ? `<circle class="on-main" cx="${x1}" cy="${MAIN_Y}" r="6"/>` : ''}
        <circle class="ring" cx="${x1}" cy="${y}" r="6"/></g>`)
      return
    }
    const merged = s === 'merged'
    // Sai da base descendo em trilho vertical e dobra com canto arredondado (estilo grafo de Git); a volta é o espelho.
    const fork = entering ? `M${x0} ${y}` : `M${x0} ${MAIN_Y}V${y - R}Q${x0} ${y} ${x0 + R} ${y}`
    const laneEnd = merged ? x1 - R : x1
    const back = merged ? `Q${x1} ${y} ${x1} ${y - R}V${MAIN_Y}` : ''
    const dotsFrom = entering ? x0 : x0 + R
    let tip = ''
    if (merged) tip = `<circle class="on-main" cx="${x1}" cy="${MAIN_Y}" r="7"/>`
    else if (s === 'need') tip = `<rect class="flag" x="${x1 - 7}" y="${y - 7}" width="14" height="14" rx="3"/><text x="${x1 + 12}" y="${y + 4}">aguarda resposta</text>`
    else if (s === 'open') tip = `<circle class="ring" cx="${x1}" cy="${y}" r="7"/><path class="hint" d="M${x1} ${y - 9}V${y - 22}M${x1 - 4} ${y - 18}L${x1} ${y - 22}L${x1 + 4} ${y - 18}"/>${pr ? `<text x="${x1 + 12}" y="${y + 4}">PR #${pr.number} → ${esc(g.base)}</text>` : ''}`
    else tip = `<circle class="ring" cx="${x1}" cy="${y}" r="6"/>`
    svg.push(`<g class="${cls}" data-id="${esc(r.id)}" style="${style}">
      <path class="lane-line" d="${fork}H${laneEnd}${back}"/>
      ${entering ? '' : `<circle class="fork" cx="${x0}" cy="${MAIN_Y}" r="4"/>`}
      ${commitDots(g.commitCount, dotsFrom, laneEnd, y, c)}
      ${tip}
    </g>`)
  })

  const rowsHtml = rows.map((r) => {
    const s = statusOf(r)
    const folder = r.git && !r.git.worktreeMissing ? r.cwd : r.git?.repoRoot ?? r.cwd
    return `<div class="trow${r.archived ? ' archived' : ''}" data-id="${esc(r.id)}" data-open="${esc(r.openUrl)}" data-folder="${esc(folder)}"
      tabindex="0" role="button" aria-label="Abrir chat ${esc(r.title)}">${label(r, s)}<div class="tgraph"></div></div>`
  }).join('')

  const n = list.length
  return `<section class="proj">
    <div class="trow head">
      <div class="lbl proj-lbl">
        <span class="proj-name">${ICON.folder}${esc(name)}</span>
        ${hasGit ? `<span class="base-tag">${esc(base)}</span>` : '<span class="base-tag muted">sem Git</span>'}
        <span class="proj-count">${n} ${n === 1 ? 'chat' : 'chats'}</span>
      </div>
      <div class="tgraph"></div>
    </div>
    ${rowsHtml}
    <svg class="graph" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" style="left:${LABEL_W}px;width:${width}px;height:${H}px">${svg.join('')}</svg>
  </section>`
}

const LEGEND = `<div class="legend" aria-label="Legenda">
  <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="4" fill="#fff" stroke="var(--bt-color-slate-700)" stroke-width="2.5"/></svg>Commit</span>
  <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5.5" fill="var(--merged)" stroke="none"/></svg>Mesclado na base</span>
  <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5" fill="#fff" stroke="var(--progress)" stroke-width="2.5"/></svg>Aberto, sem mesclar</span>
  <span><svg viewBox="0 0 22 14"><rect x="5" y="1" width="12" height="12" rx="3" fill="var(--need)" stroke="none"/></svg>Precisa de você</span>
  <span><svg viewBox="0 0 22 14"><path d="M1 7H21" stroke="var(--idle)" stroke-width="2.5" stroke-dasharray="3 3"/></svg>Sem mudanças</span>
</div>`

const KIND: Record<Pending['kind'], { color: string; soft: string; icon: string; text: (p: Pending) => string }> = {
  dirty: { color: 'var(--need)', soft: 'var(--need-soft)', icon: ICON.edit, text: (p) => `${p.count} ${p.count === 1 ? 'arquivo não commitado' : 'arquivos não commitados'}` },
  unmerged: { color: 'var(--progress)', soft: 'var(--progress-soft)', icon: ICON.branch, text: (p) => `${p.count} ${p.count === 1 ? 'commit' : 'commits'} fora da ${p.base}` },
  unpushed: { color: 'var(--danger)', soft: 'var(--bt-color-danger-soft)', icon: ICON.up, text: (p) => `${p.count} ${p.count === 1 ? 'commit' : 'commits'} sem push para o GitHub` },
  cleanup: { color: 'var(--idle)', soft: 'var(--idle-soft)', icon: ICON.tree, text: () => 'Worktree já mesclada, pode ser removida' },
}

function pendRow(p: Pending, i: number) {
  const k = KIND[p.kind]
  const stale = p.kind !== 'cleanup' && Date.now() - p.lastActivity > STALE_MS
  const where = p.worktree ? 'worktree' : p.path === p.repoRoot ? 'pasta principal' : ''
  const chat = p.chatTitle
    ? `<span class="pd-chat"><i class="dot ${p.chatAgent}"></i>${esc(p.chatTitle)}</span>`
    : '<span class="pd-chat muted">Nenhum chat ligado · abre a pasta</span>'
  return `<div class="pd${stale ? ' stale' : ''}" data-pend="${i}" tabindex="0" role="button" style="--c:${k.color};--c-soft:${k.soft}"
      title="${esc(p.commits.join('\n'))}">
    <span class="pd-icon">${k.icon}</span>
    <div class="pd-main">
      <div class="pd-top"><span class="pd-proj">${esc(p.project)}</span><span class="pd-br">${ICON.branch}${esc(p.branch)}</span>${where ? `<span class="pd-where">${where}</span>` : ''}</div>
      <div class="pd-what">${esc(k.text(p))}${p.commits[0] ? ` · <span class="pd-commit">${esc(p.commits[0])}</span>` : ''}</div>
    </div>
    ${chat}
    <span class="pd-age">${p.lastActivity ? (stale ? `parado ${ago(p.lastActivity)}` : ago(p.lastActivity)) : ''}</span>
  </div>`
}

function pendSection() {
  if (!pendLoaded) return '<section class="pend"><div class="pend-head"><h2>Pendências</h2><span class="sub">Verificando worktrees e branches…</span></div></section>'
  const q = ui.q.trim().toLowerCase()
  const vis = pendings
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (!ui.project || p.project === ui.project) && (!q || [p.project, p.branch, p.chatTitle ?? ''].some((s) => s.toLowerCase().includes(q))))
  const open = vis.filter(({ p }) => p.kind !== 'cleanup')
  const clean = vis.filter(({ p }) => p.kind === 'cleanup')
  const stale = open.filter(({ p }) => Date.now() - p.lastActivity > STALE_MS).length
  return `<section class="pend${open.length ? '' : ' ok'}">
    <div class="pend-head">
      <h2>${open.length ? `${open.length} ${open.length === 1 ? 'pendência' : 'pendências'} no Git` : 'Tudo atualizado no Git'}</h2>
      <span class="sub">${open.length ? `${stale ? `${stale} parada${stale === 1 ? '' : 's'} há mais de 1 dia · ` : ''}clique para abrir o chat e pedir para finalizar` : 'Nada esquecido: tudo mesclado e enviado ao GitHub'}</span>
    </div>
    ${open.length ? `<div class="pd-list">${open.sort((a, b) => a.p.lastActivity - b.p.lastActivity).slice(0, showAllPend ? undefined : PEND_LIMIT).map(({ p, i }) => pendRow(p, i)).join('')}</div>` : ''}
    ${open.length > PEND_LIMIT ? `<button class="pd-clean" data-toggle-all>${showAllPend ? 'Mostrar só as 5 mais antigas ▴' : `Mostrar todas as ${open.length} ▾`}</button>` : ''}
    ${clean.length ? `<button class="pd-clean" data-toggle-clean>${ICON.tree}${clean.length} ${clean.length === 1 ? 'worktree já mesclada pode' : 'worktrees já mescladas podem'} ser removida${clean.length === 1 ? '' : 's'} ${showCleanup ? '▴' : '▾'}</button>
      ${showCleanup ? `<div class="pd-list">${clean.map(({ p, i }) => pendRow(p, i)).join('')}</div>` : ''}` : ''}
  </section>`
}

let width = 0
const byId = new Map<string, Run>()

function render() {
  // 26px de padding de cada lado mais 1px de borda do painel em cada lado.
  width = Math.max(320, board.clientWidth - LABEL_W - 54)
  if (!lastLoad) {
    board.innerHTML = `<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><p>Lendo chats e repositórios…</p></div>`
    return
  }
  const all = filtered()
  renderChips(all)
  const list = ui.status === 'all' ? all : all.filter((r) => { const s = statusOf(r); return s === ui.status || (ui.status === 'merged' && s === 'main') })
  byId.clear()
  list.forEach((r) => byId.set(r.id, r))
  const to = Date.now()
  const from = to - ui.days * 86_400_000

  const groups = new Map<string, Run[]>()
  for (const r of list) {
    const k = r.git ? projectOf(r) : `${projectOf(r)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const ga = a[1].some((r) => r.git), gb = b[1].some((r) => r.git)
    if (ga !== gb) return ga ? -1 : 1
    return Math.max(...b[1].map((r) => r.updatedAt)) - Math.max(...a[1].map((r) => r.updatedAt))
  })

  const x = (t: number) => Math.round(((t - from) / (to - from)) * (width - 24)) + 12
  const tk = ticks(from, to)
  // "hoje" ocupa o último rótulo; os outros ficam só se não encostarem nele.
  const axis = tk.filter((t) => x(to) - x(t.t) > 110).map((t) => `<span class="tick" style="left:${x(t.t)}px">${t.label}</span>`).join('')

  board.innerHTML = pendSection() + (list.length
    ? `<section class="timeline">
        <div class="tl-head"><div><h2>Branches e integração</h2><p>Cada linha nasce da branch base, recebe commits e volta quando é mesclada</p></div>${LEGEND}</div>
        <div class="axis"><div class="axis-lbl">Branch · chat</div><div class="axis-track">${axis}<span class="now" style="left:${x(to) - 1}px">hoje · agora</span></div></div>
        ${ordered.map(([name, rs]) => project(name, rs, from, to, width, tk.map((t) => t.t))).join('')}
      </section>`
    : `<div class="empty"><p>Nenhum chat ${ui.status !== 'all' ? 'nesse estado' : 'nesse filtro'} nos últimos ${ui.days} dias.</p><button class="link-btn" data-clear>Limpar filtros</button></div>`)

  const live = all.filter((r) => Date.now() - r.updatedAt < ACTIVE_MS).length
  const projects = new Set(all.map(projectOf)).size
  summaryEl.textContent = `${all.length} ${all.length === 1 ? 'chat' : 'chats'} em ${projects} ${projects === 1 ? 'projeto' : 'projetos'}${live ? ` · ${live} ${live === 1 ? 'ativo' : 'ativos'} agora` : ''} · atualizado ${ago(lastLoad)}`
}

function clearFilters() {
  ui.q = ''; qInput.value = ''
  ui.status = 'all'; ui.agent = 'all'; ui.project = ''
  document.querySelectorAll('#agent button').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.v === 'all'))
  projectSel.value = ''
  persist(); render()
}

// ---------- Destaque e dica ao passar o mouse ----------
const tip = $<HTMLElement>('tip')
let hoverId = ''
function hover(id: string, ev?: MouseEvent) {
  if (id !== hoverId) {
    board.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'))
    hoverId = id
    if (id) board.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((e) => e.classList.add('hl'))
    const r = byId.get(id)
    if (r) tip.innerHTML = tooltip(r, statusOf(r))
    tip.classList.toggle('show', Boolean(r))
  }
  if (ev && id) {
    const pad = 16, w = tip.offsetWidth, h = tip.offsetHeight
    const left = ev.clientX + pad + w > innerWidth ? ev.clientX - w - pad : ev.clientX + pad
    const top = Math.min(ev.clientY + pad, innerHeight - h - 8)
    tip.style.transform = `translate(${left}px, ${top}px)`
  }
}
board.addEventListener('mousemove', (ev) => {
  const el = (ev.target as Element).closest<HTMLElement | SVGElement>('[data-id]')
  hover(el?.dataset.id ?? '', ev as MouseEvent)
})
board.addEventListener('mouseleave', () => hover(''))
board.addEventListener('scroll', () => hover(''))
new ResizeObserver(() => { if (Math.abs(board.clientWidth - LABEL_W - 54 - width) > 4) render() }).observe(board)

let toastTimer = 0
function toast(msg: string, error = false) {
  const t = $<HTMLElement>('toast')
  t.textContent = msg
  t.className = `toast show${error ? ' error' : ''}`
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (t.className = 'toast'), error ? 5000 : 2200)
}

async function load(manual = false) {
  if (loading) return
  loading = true
  refreshBtn.classList.add('spin')
  try {
    // Fora do Tauri (pré-visualização no navegador durante o dev) usa o dump gerado por `painel-agentes.exe --dump`.
    runs = '__TAURI_INTERNALS__' in window
      ? await invoke<Run[]>('list_runs', { days: ui.days, archived: ui.archived })
      : await fetch('/mock-runs.json').then((r) => r.json())
    lastLoad = Date.now()
    renderProjects()
    render()
    void loadPending()
    if (manual) toast('Atualizado')
  } catch (e) {
    toast(`Não consegui ler os chats: ${e}`, true)
  } finally {
    loading = false
    refreshBtn.classList.remove('spin')
  }
}

async function loadPending() {
  try {
    pendings = '__TAURI_INTERNALS__' in window
      ? await invoke<Pending[]>('list_pending')
      : await fetch('/mock-pending.json').then((r) => r.json())
    pendLoaded = true
    render()
  } catch (e) {
    toast(`Não consegui verificar as pendências: ${e}`, true)
  }
}

async function call(cmd: string, args: Record<string, string>) {
  if (!('__TAURI_INTERNALS__' in window)) return toast('Esta é só a pré-visualização no navegador; abrir chat ou pasta funciona no app', true)
  try { await invoke(cmd, args) } catch (e) { toast(String(e), true) }
}

// ---------- Eventos ----------
$<HTMLElement>('status').addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLElement>('[data-status]')
  if (!b) return
  ui.status = b.dataset.status as typeof ui.status
  render()
})
// Menu de preferências fecha ao clicar fora ou com Esc.
const menu = document.querySelector<HTMLDetailsElement>('.menu')!
document.addEventListener('pointerdown', (ev) => { if (menu.open && !menu.contains(ev.target as Node)) menu.open = false })
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')!.focus() } })

board.addEventListener('click', (ev) => {
  const t = ev.target as Element
  if (t.closest('[data-clear]')) { clearFilters(); return }
  if (t.closest('[data-toggle-clean]')) { showCleanup = !showCleanup; render(); return }
  if (t.closest('[data-toggle-all]')) { showAllPend = !showAllPend; render(); return }
  const pd = t.closest<HTMLElement>('[data-pend]')
  if (pd) {
    const p = pendings[Number(pd.dataset.pend)]
    if (p.chatUrl) { toast('Abrindo chat…'); void call('open_run', { url: p.chatUrl }) } else void call('open_folder', { path: p.path })
    return
  }
  const el = (ev.target as Element).closest<HTMLElement | SVGElement>('[data-id]')
  const r = el && byId.get(el.dataset.id!)
  if (r) {
    toast('Abrindo chat…')
    void call('open_run', { url: r.openUrl })
  }
})
board.addEventListener('contextmenu', (ev) => {
  const el = (ev.target as Element).closest<HTMLElement | SVGElement>('[data-id]')
  const r = el && byId.get(el.dataset.id!)
  if (!r) return
  ev.preventDefault()
  void call('open_folder', { path: r.git && !r.git.worktreeMissing ? r.cwd : r.git?.repoRoot ?? r.cwd })
})
board.addEventListener('keydown', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.trow[data-id], .pd')
  if (row && (ev.key === 'Enter' || ev.key === ' ') && ev.target === row) {
    ev.preventDefault()
    row.click()
  }
})

qInput.addEventListener('input', () => { ui.q = qInput.value; render() })
document.querySelectorAll<HTMLButtonElement>('#agent button').forEach((b) => {
  b.classList.toggle('on', b.dataset.v === ui.agent)
  b.addEventListener('click', () => {
    ui.agent = b.dataset.v!
    document.querySelectorAll('#agent button').forEach((x) => x.classList.toggle('on', x === b))
    persist(); render()
  })
})
projectSel.addEventListener('change', () => { ui.project = projectSel.value; persist(); render() })
daysSel.value = String(ui.days)
daysSel.addEventListener('change', () => { ui.days = Number(daysSel.value); persist(); void load() })
archivedChk.checked = ui.archived
archivedChk.addEventListener('change', () => { ui.archived = archivedChk.checked; persist(); void load() })
refreshBtn.addEventListener('click', () => void load(true))
// ---------- Atualização do app (GitHub Releases) ----------
const updBtn = $<HTMLButtonElement>('update')
let updating = false
async function checkUpdate() {
  if (!('__TAURI_INTERNALS__' in window) || updating) return
  try {
    const u = await invoke<{ version: string } | null>('check_update')
    updBtn.hidden = !u
    if (u) updBtn.textContent = `Atualizar para v${u.version}`
  } catch { /* sem internet: tenta de novo mais tarde */ }
}
updBtn.addEventListener('click', async () => {
  if (updating) return
  updating = true
  updBtn.disabled = true
  updBtn.textContent = 'Baixando…'
  try {
    await invoke('install_update')
  } catch (e) {
    toast(String(e), true)
    updating = false
    updBtn.disabled = false
    void checkUpdate()
  }
})
if ('__TAURI_INTERNALS__' in window) {
  void listen<number>('update-progress', (e) => { updBtn.textContent = e.payload >= 100 ? 'Instalando…' : `Baixando ${e.payload}%` })
  setTimeout(() => void checkUpdate(), 5_000)
  setInterval(() => void checkUpdate(), 4 * 3_600_000)
}

const autoChk = $<HTMLInputElement>('autostart')
if ('__TAURI_INTERNALS__' in window) {
  void invoke<boolean>('get_autostart').then((on) => (autoChk.checked = on))
  void listen('pending-updated', () => void loadPending())
}
autoChk.addEventListener('change', async () => {
  try {
    await invoke('set_autostart', { on: autoChk.checked })
    toast(autoChk.checked ? 'O painel vai iniciar com o Windows, na bandeja' : 'Não inicia mais com o Windows')
  } catch (e) { autoChk.checked = !autoChk.checked; toast(String(e), true) }
})
window.addEventListener('focus', () => { if (Date.now() - lastLoad > 10_000) void load() })
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey && ev.key.toLowerCase() === 'f') || (ev.key === '/' && document.activeElement !== qInput)) {
    ev.preventDefault(); qInput.focus(); qInput.select()
  }
  if (ev.key === 'F5') { ev.preventDefault(); void load(true) }
})
setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
setInterval(() => { if (lastLoad) render() }, 30_000)

$<HTMLElement>('version').textContent = `v${__APP_VERSION__} · ${__BUILD_DATE__}`
render()
void load()
