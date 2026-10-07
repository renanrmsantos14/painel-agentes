import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { createSelect } from './select'

declare const __APP_VERSION__: string
declare const __BUILD_DATE__: string

type Agent = 'claude' | 'codex' | 'git'
type Pr = { number: number; url: string; state: string }
type GitInfo = {
  project: string; repoRoot: string; branch: string; base: string; onBase: boolean; branchExists: boolean
  worktree: boolean; worktreeMissing: boolean; ahead: number; behind: number; merged: boolean
  commits: string[]; commitCount: number; files: number; insertions: number; deletions: number; dirty: number
}
type Run = {
  id: string; agent: Agent; title: string; cwd: string; createdAt: number; updatedAt: number
  archived: boolean; state: string | null; detail: string | null; needsAction: string | null
  prs: Pr[]; git: GitInfo | null; openUrl: string
  /** `git` é o último estado conhecido; o backend ainda está reverificando esta pasta. */
  stale: boolean
  /** Pendências do Git ligadas a este chat (mesma branch e repositório). */
  pend?: Pending[]
  /** Linha montada a partir de uma pendência sem chat no período (não veio de list_runs). */
  orphan?: boolean
  /** Outros chats na mesma branch e pasta, mostrados numa linha só. */
  others?: Run[]
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
// A varredura de pendências (todos os repositórios) é cara: refaz no máximo a cada 2 min, salvo no F5.
const PENDING_MS = 2 * 60_000
// Pedidos parados há mais que isso deixam de contar como "Precisa de você" (o agente já foi deixado de lado).
const NEED_MS = 3 * 86_400_000
const IN_TAURI = '__TAURI_INTERNALS__' in window

const ICON = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.2 7.4"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><path d="M12 21v-6M12 15l-5-4M12 15l5-4M7 11V6M17 11V6"/><circle cx="7" cy="4.5" r="1.5"/><circle cx="17" cy="4.5" r="1.5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  pr: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 18.5V6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H9z"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/></svg>',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const board = $<HTMLElement>('board')
const qInput = $<HTMLInputElement>('q')
const projectSel = createSelect($('project'), { label: 'Projeto', placeholder: 'Todos os projetos', onChange: (v) => { ui.project = v; persist(); render() } })
const daysSel = createSelect($('days'), { label: 'Período', searchable: false, clearable: false, onChange: (v) => { ui.days = Number(v); persist(); void load() } })
daysSel.setOptions([3, 7, 30, 90].map((d) => ({ value: String(d), label: `${d} dias` })))
const archivedChk = $<HTMLInputElement>('archived')
const refreshBtn = $<HTMLButtonElement>('refresh')
const summaryEl = $<HTMLElement>('summary')

type Focus = 'pending' | 'need' | 'open' | 'all'
const saved = (() => { try { return JSON.parse(localStorage.getItem('filters') ?? '{}') } catch { return {} } })()
const ui = {
  q: '',
  focus: ((saved.focus as Focus) ?? 'pending') as Focus,
  agent: (saved.agent as string) ?? 'all',
  project: (saved.project as string) ?? '',
  days: Number(saved.days ?? 7),
  archived: Boolean(saved.archived),
}
let runs: Run[] = []
let pendings: Pending[] = []
let orphans: Run[] = []
let cleanups: Pending[] = []
let unpushedBy = new Map<string, Pending>()
let loading = false
let lastLoad = 0
let lastPending = 0

function persist() {
  try { localStorage.setItem('filters', JSON.stringify({ focus: ui.focus, agent: ui.agent, project: ui.project, days: ui.days, archived: ui.archived })) } catch { /* sem armazenamento */ }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const np = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const agentName = (a: Agent) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'Sem chat')

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

function folderOf(r: Run) {
  return r.git && !r.git.worktreeMissing ? r.cwd : r.git?.repoRoot ?? r.cwd
}

// ---------- Pendências do Git ligadas aos chats ----------

/** Linha do grafo para uma pendência que não tem chat no período (ex.: branch esquecida, pasta suja). */
function pendAsRun(p: Pending): Run {
  return {
    id: `p:${np(p.path)}|${p.branch}`, agent: p.chatAgent ?? 'git', title: p.chatTitle ?? 'Nenhum chat ligado', cwd: p.path,
    createdAt: 0, updatedAt: p.lastActivity || Date.now(), archived: false, state: null, detail: null, needsAction: null,
    prs: [], openUrl: p.chatUrl ?? '', orphan: true, pend: [], stale: false,
    git: {
      project: p.project, repoRoot: p.repoRoot, branch: p.branch, base: p.base, onBase: p.branch === p.base, branchExists: true,
      worktree: p.worktree, worktreeMissing: false, ahead: 0, behind: 0, merged: false, commits: [], commitCount: 0,
      files: 0, insertions: 0, deletions: 0, dirty: 0,
    },
  }
}

/** Liga cada pendência ao chat mais recente na mesma branch; o que sobra vira linha própria no grafo. */
function link() {
  runs.forEach((r) => (r.pend = []))
  cleanups = pendings.filter((p) => p.kind === 'cleanup')
  unpushedBy = new Map(pendings.filter((p) => p.kind === 'unpushed').map((p) => [p.project, p]))
  const synth = new Map<string, Run>()
  for (const p of pendings) {
    if (p.kind === 'cleanup' || p.kind === 'unpushed') continue
    const cands = runs.filter((r) => r.git && np(r.git.repoRoot) === np(p.repoRoot) && r.git.branch === p.branch)
    const sameDir = cands.filter((r) => np(r.cwd) === np(p.path))
    const hit = (sameDir.length ? sameDir : cands).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (hit) { hit.pend!.push(p); continue }
    const k = `${np(p.path)}|${p.branch}`
    const o = synth.get(k) ?? pendAsRun(p)
    o.pend!.push(p)
    if (p.kind === 'dirty') o.git!.dirty = p.count
    if (p.kind === 'unmerged') { o.git!.ahead = o.git!.commitCount = p.count; o.git!.commits = p.commits }
    o.updatedAt = Math.max(o.updatedAt, p.lastActivity)
    synth.set(k, o)
  }
  orphans = [...synth.values()]
}

const pendCount = (r: Run, kind: Pending['kind']) => r.pend?.filter((p) => p.kind === kind).reduce((n, p) => n + p.count, 0) ?? 0
/** Atividade mais antiga entre as pendências do chat (para destacar o que está parado). */
const pendSince = (r: Run) => Math.min(...(r.pend ?? []).map((p) => p.lastActivity || Date.now()), Date.now())

type Status = 'need' | 'open' | 'merged' | 'main' | 'idle'

// Memo por renderização: o mesmo chat é classificado várias vezes (contagens, ordenação, grafo, rótulo).
let statusMemo = new WeakMap<Run, Status>()

function statusOf(r: Run): Status {
  let s = statusMemo.get(r)
  if (!s) statusMemo.set(r, (s = computeStatus(r)))
  return s
}

function computeStatus(r: Run): Status {
  const g = r.git
  if (r.needsAction && !r.archived && Date.now() - r.updatedAt < NEED_MS) return 'need'
  if (r.pend?.length) return 'open'
  if (g) {
    if (g.dirty > 0 || (g.ahead > 0 && !g.merged)) return 'open'
    if (g.onBase && g.commitCount > 0) return 'main'
    if (g.merged && !g.onBase) return 'merged'
  }
  return 'idle'
}

// Cada estado é um par cor/fundo/texto do design system (status nunca só pela cor: a forma no grafo muda também).
const STATUS: Record<Status, { label: string; color: string; soft: string; text: string }> = {
  need: { label: 'Precisa de você', color: 'var(--need)', soft: 'var(--need-soft)', text: 'var(--need-text)' },
  open: { label: 'Falta integrar', color: 'var(--progress)', soft: 'var(--progress-soft)', text: 'var(--progress-text)' },
  merged: { label: 'Mesclado', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  main: { label: 'Direto na base', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  idle: { label: 'Sem mudanças', color: 'var(--idle)', soft: 'var(--idle-soft)', text: 'var(--idle-text)' },
}

/** Chats e pendências sem chat que passam nos filtros de texto, agente e projeto (o foco é aplicado depois, para as contagens). */
function filtered() {
  const q = ui.q.trim().toLowerCase()
  return [...runs, ...orphans].filter((r) => {
    if (ui.agent !== 'all' && r.agent !== ui.agent) return false
    if (ui.project && projectOf(r) !== ui.project) return false
    if (!q) return true
    return [r.title, projectOf(r), r.git?.branch ?? '', r.cwd].some((s) => s.toLowerCase().includes(q))
  })
}

const FOCUS: { v: Focus; label: string; color: string; test: (s: Status) => boolean }[] = [
  { v: 'pending', label: 'Pendentes', color: 'var(--bt-color-brand)', test: (s) => s === 'need' || s === 'open' },
  { v: 'need', label: 'Precisa de você', color: 'var(--need)', test: (s) => s === 'need' },
  { v: 'open', label: 'Falta integrar', color: 'var(--progress)', test: (s) => s === 'open' },
  { v: 'all', label: 'Todos', color: 'var(--idle)', test: () => true },
]

function renderChips(list: Run[]) {
  const st = list.map(statusOf)
  $<HTMLElement>('status').innerHTML = FOCUS.map(({ v, label, color, test }) => {
    const n = st.filter(test).length
    return `<button class="chip${ui.focus === v ? ' on' : ''}" data-focus="${v}" aria-pressed="${ui.focus === v}" style="--c:${color}">${label}<b>${n}</b></button>`
  }).join('')
}

function renderProjects() {
  const names = [...new Set([...runs, ...orphans].map(projectOf))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  if (ui.project && !names.includes(ui.project)) names.unshift(ui.project)
  projectSel.setOptions([...names.map((n) => ({ value: n, label: n }))])
  projectSel.setValue(ui.project)
}

const ROW = 44
const LABEL_W = 300
// Linha da branch base fica no meio da linha de cabeçalho do projeto.
const MAIN_Y = ROW / 2

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

/** Etiqueta curta: diz o próximo passo, não só o estado. */
function badgeText(r: Run, s: Status) {
  const g = r.git
  const pr = r.prs.find((p) => p.url)
  if (s === 'open') {
    if ((g?.dirty ?? 0) > 0 || pendCount(r, 'dirty')) return 'Falta commit'
    if (pr) return `PR #${pr.number} aberto`
    return 'Falta mesclar'
  }
  if (s === 'merged' && pr) return `Mesclado · PR #${pr.number}`
  return STATUS[s].label
}

/** O que falta, em uma linha. */
function whatText(r: Run, s: Status) {
  const g = r.git
  if (!g) return 'Fora de um repositório'
  const dirty = Math.max(g.dirty, pendCount(r, 'dirty'))
  const ahead = Math.max(g.merged ? 0 : g.ahead, pendCount(r, 'unmerged'))
  const parts: string[] = []
  if (dirty) parts.push(plural(dirty, 'arquivo não commitado', 'arquivos não commitados'))
  if (ahead && !g.onBase) parts.push(`${plural(ahead, 'commit', 'commits')} fora da ${g.base}`)
  if (parts.length) return parts.join(' · ')
  if (s === 'merged') return `Mesclado na ${g.base}`
  if (s === 'main') return `${plural(g.commitCount, 'commit', 'commits')} direto na ${g.base}`
  if (!g.branchExists && !g.onBase) return 'Branch removida'
  return 'Sem mudanças'
}

function label(r: Run, s: Status) {
  const live = Date.now() - r.updatedAt < ACTIVE_MS && !r.orphan
  const st = STATUS[s]
  const since = r.pend?.length ? pendSince(r) : 0
  const stale = since && Date.now() - since > STALE_MS
  const who = r.orphan ? (r.openUrl ? `${agentName(r.agent)} · ${esc(r.title)}` : 'Sem chat · abre a pasta') : `${agentName(r.agent)} · ${esc(r.title)}`
  return `<div class="lbl" style="--c:${st.color};--s-soft:${st.soft};--s-text:${st.text}">
    <div class="lbl-top">
      <span class="br" title="${esc(r.git?.branch ?? '')}">${esc(r.git?.branch ?? 'Sem repositório')}</span>
      <span class="badge">${esc(badgeText(r, s))}</span>
      ${r.stale ? '<i class="verifying" title="Reverificando o Git"></i>' : ''}
      ${live ? '<i class="live" title="Ativo agora"></i>' : ''}
      ${r.others?.length ? `<span class="n-chats" title="${esc(plural(r.others.length + 1, 'chat', 'chats'))} nesta branch">${r.others.length + 1} chats</span>` : ''}
    </div>
    <div class="lbl-sub">
      <i class="dot ${r.agent}" title="${agentName(r.agent)}"></i>
      <span class="lbl-title">${s === 'open' || s === 'need' ? esc(whatText(r, s)) : who}</span>
      ${stale ? `<span class="stale">parado ${ago(since)}</span>` : ''}
    </div>
    <button class="more" data-more tabindex="-1" aria-label="Ações">${ICON.more}</button>
  </div>`
}

function tooltip(r: Run, s: Status) {
  const g = r.git
  const commits = g?.commits ?? []
  const ask = s === 'need' && r.needsAction ? `<div class="tt-need">${esc(r.needsAction)}</div>` : r.detail ? `<div class="tt-detail">${esc(r.detail)}</div>` : ''
  const prs = r.prs.filter((p) => p.url).map((p) => `<span class="tt-pr">${ICON.pr}PR #${p.number} · ${esc(p.state.toLowerCase())}</span>`).join('')
  const todo = s === 'open' || (s === 'need' && r.pend?.length) ? `<div class="tt-todo">${esc(whatText(r, s))}</div>` : ''
  return `<div class="tt-head"><i class="dot ${r.agent}"></i>${r.orphan && !r.openUrl ? 'Sem chat ligado' : `${agentName(r.agent)} · ${ago(r.updatedAt)}`}</div>
    <div class="tt-title">${esc(r.orphan && !r.openUrl ? projectOf(r) : r.title)}</div>
    ${g ? `<div class="tt-branch">${ICON.branch}${esc(g.onBase ? g.branch : `${g.branch} → ${g.base}`)}${g.worktree ? ' · worktree' : ''}${g.worktreeMissing ? ' · worktree removida' : ''}</div>` : ''}
    ${ask}${todo}
    ${commits.length ? `<ul class="tt-commits">${commits.map((c) => `<li>${esc(c)}</li>`).join('')}${(g?.commitCount ?? 0) > commits.length ? `<li class="more">+ ${g!.commitCount - commits.length} outros</li>` : ''}</ul>` : ''}
    ${prs ? `<div class="tt-prs">${prs}</div>` : ''}
    ${r.others?.length ? `<div class="tt-others">Também nesta branch: ${r.others.slice(0, 4).map((o) => esc(o.title)).join(' · ')}${r.others.length > 4 ? ` e mais ${r.others.length - 4}` : ''}</div>` : ''}
    <div class="tt-foot">Clique abre ${r.openUrl ? 'o chat' : 'a pasta'} · botão direito mostra as ações</div>`
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

const RANK: Record<Status, number> = { need: 0, open: 1, main: 2, merged: 2, idle: 3 }

/**
 * Desenha um projeto como grafo de Git: a base é uma linha navy grossa no cabeçalho;
 * cada chat sai dela com uma curva, mostra seus commits como pontos e volta com um ponto cheio quando é mesclado.
 */
function project(name: string, list: Run[], from: number, to: number, width: number, dayTicks: number[]) {
  const base = list.find((r) => r.git)?.git?.base ?? unpushedBy.get(name)?.base ?? ''
  const hasGit = Boolean(base)
  const x = (t: number) => Math.round(((Math.min(Math.max(t, from), to) - from) / (to - from)) * (width - 24)) + 12
  // O que precisa de ação fica no topo do projeto; dentro de cada grupo, os mais novos primeiro.
  const rows = [...list].sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)] || b.createdAt - a.createdAt)
  const H = ROW * (rows.length + 1)
  const svg: string[] = []
  const R = 24 // raio das curvas de saída e de retorno
  const unpushed = unpushedBy.get(name)

  svg.push(`<path class="grid" d="${dayTicks.map((t) => `M${x(t)} 0V${H}`).join('')}"/>`)
  svg.push(`<line class="main-line${hasGit ? '' : ' muted'}" x1="${x(from)}" y1="${MAIN_Y}" x2="${x(to)}" y2="${MAIN_Y}"/>`)
  if (unpushed) svg.push(`<g class="unpushed-tip"><circle cx="${x(to)}" cy="${MAIN_Y}" r="7"/><path d="M${x(to)} ${MAIN_Y + 3}V${MAIN_Y - 3}M${x(to) - 3} ${MAIN_Y}L${x(to)} ${MAIN_Y - 3}L${x(to) + 3} ${MAIN_Y}"/></g>`)
  svg.push(`<line class="now-mark" x1="${x(to)}" y1="${ROW}" x2="${x(to)}" y2="${H}"/>`)

  rows.forEach((r, i) => {
    const s = statusOf(r)
    const y = ROW * (i + 1) + ROW / 2
    const live = Date.now() - r.updatedAt < ACTIVE_MS && !r.orphan
    const x0 = x(r.createdAt)
    const x1 = Math.max(x(live ? to : r.updatedAt), x0 + R * 2 + 12)
    const st = STATUS[s]
    const c = st.color
    const g = r.git
    const pr = r.prs.find((p) => p.url)
    const cls = `lane ${s}${live ? ' live' : ''}${g ? '' : ' nogit'}${r.orphan ? ' orphan' : ''}`
    const style = `--c:${c};--s-text:${st.text}`
    const entering = r.createdAt < from // começou antes do período: entra pela borda, sem bifurcação

    if (!g || !hasGit) {
      svg.push(`<g class="${cls}" data-id="${esc(r.id)}" style="${style}"><path class="lane-line" d="M${x0} ${y}H${x1}"/><circle class="commit" cx="${x1}" cy="${y}" r="4.5"/></g>`)
      return
    }
    if (g.onBase) {
      // Trabalho direto na base: faixa reta ligada por um ponto cheio na linha principal.
      svg.push(`<g class="${cls}" data-id="${esc(r.id)}" style="${style}">
        <path class="hint" d="M${x1} ${y}V${MAIN_Y + 6}"/>
        <path class="lane-line" d="M${x0} ${y}H${x1}"/>
        ${commitDots(g.commitCount, x0, x1, y, c)}
        ${s === 'main' ? `<circle class="on-main" cx="${x1}" cy="${MAIN_Y}" r="6"/>` : ''}
        ${s === 'need' ? `<rect class="flag" x="${x1 - 7}" y="${y - 7}" width="14" height="14" rx="3"/>` : `<circle class="ring" cx="${x1}" cy="${y}" r="6"/>`}</g>`)
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
    else if (s === 'need') tip = `<rect class="flag" x="${x1 - 7}" y="${y - 7}" width="14" height="14" rx="3"/>`
    else if (s === 'open') tip = `<circle class="ring" cx="${x1}" cy="${y}" r="7"/><path class="up" d="M${x1} ${y - 11}V${y - 20}M${x1 - 3.5} ${y - 16.5}L${x1} ${y - 20}L${x1 + 3.5} ${y - 16.5}"/>${pr ? `<text class="pr-label" ${x1 > width - 150 ? `x="${x1 - 10}" y="${y + 19}" text-anchor="end"` : `x="${x1 + 12}" y="${y + 4}"`}>PR #${pr.number} → ${esc(g.base)}</text>` : ''}`
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
    return `<div class="trow${r.archived ? ' archived' : ''}${r.stale ? ' stale' : ''}" data-id="${esc(r.id)}" tabindex="0" role="button"
      aria-label="${esc(`${r.git?.branch ?? ''} ${badgeText(r, s)}: ${r.title}`)}">${label(r, s)}<div class="tgraph"></div></div>`
  }).join('')

  const clean = cleanups.filter((p) => p.project === name).length
  const n = list.filter((r) => !r.orphan).reduce((k, r) => k + 1 + (r.others?.length ?? 0), 0)
  return `<section class="proj">
    <div class="trow head" data-proj="${esc(name)}">
      <div class="lbl proj-lbl">
        <span class="proj-name" title="${esc(name)}${n ? ` · ${plural(n, 'chat', 'chats')}` : ''}">${ICON.folder}${esc(name)}</span>
        ${hasGit ? `<span class="base-tag">${esc(base)}</span>` : '<span class="base-tag muted">sem Git</span>'}
        ${unpushed ? `<button class="pill push" data-push="${esc(name)}" title="${esc(unpushed.commits.join('\n'))}">${ICON.up}${unpushed.count} sem push</button>` : ''}
        ${clean ? `<button class="pill clean" data-clean-proj="${esc(name)}" title="Worktrees já mescladas e limpas">${ICON.tree}${clean}</button>` : ''}
        
        <button class="more" data-more tabindex="-1" aria-label="Ações do projeto">${ICON.more}</button>
      </div>
      <div class="tgraph"></div>
    </div>
    ${rowsHtml}
    <svg class="graph" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" style="left:${LABEL_W}px;width:${width}px;height:${H}px">${svg.join('')}</svg>
  </section>`
}

function legend() {
  const items = [
    `<span><svg viewBox="0 0 22 14"><rect x="5" y="1" width="12" height="12" rx="3" fill="var(--need)" stroke="none"/></svg>Precisa de você</span>`,
    `<span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5" fill="#fff" stroke="var(--progress)" stroke-width="2.5"/></svg>Falta integrar</span>`,
    `<span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="4" fill="#fff" stroke="var(--bt-color-slate-700)" stroke-width="2.5"/></svg>Commit</span>`,
  ]
  if (ui.focus === 'all') {
    items.push(`<span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5.5" fill="var(--merged)" stroke="none"/></svg>Mesclado</span>`)
    items.push(`<span><svg viewBox="0 0 22 14"><path d="M1 7H21" stroke="var(--idle)" stroke-width="2.5" stroke-dasharray="3 3"/></svg>Sem mudanças</span>`)
  }
  return `<div class="legend" aria-label="Legenda">${items.join('')}</div>`
}

/**
 * Vários chats na mesma branch e pasta viram uma linha: o mais recente representa o grupo
 * e a faixa vai do primeiro ao último. Quem espera resposta fica sempre em linha própria.
 */
function collapse(list: Run[]) {
  const out: Run[] = []
  const groups = new Map<string, Run[]>()
  for (const r of list) {
    if (!r.git || r.orphan || statusOf(r) === 'need') { out.push(r); continue }
    const k = `${np(r.git.repoRoot)}|${r.git.branch}|${np(r.cwd)}|${statusOf(r)}`
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue }
    const [top, ...rest] = [...g].sort((a, b) => b.updatedAt - a.updatedAt)
    out.push({ ...top, createdAt: Math.min(...g.map((r) => r.createdAt)), others: rest, prs: [...new Map(g.flatMap((r) => r.prs).map((p) => [p.number, p])).values()] })
  }
  return out
}

let width = 0
const byId = new Map<string, Run>()

function render() {
  statusMemo = new WeakMap()
  // 26px de padding de cada lado mais 1px de borda do painel em cada lado.
  width = Math.max(320, board.clientWidth - LABEL_W - 54)
  if (!lastLoad) {
    board.innerHTML = `<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><p>Lendo chats e repositórios…</p></div>`
    return
  }
  const all = filtered()
  renderChips(all)
  const test = FOCUS.find((f) => f.v === ui.focus)!.test
  const list = collapse(all.filter((r) => test(statusOf(r))))
  byId.clear()
  all.forEach((r) => byId.set(r.id, r))
  list.forEach((r) => byId.set(r.id, r))
  const to = Date.now()
  const from = to - ui.days * 86_400_000

  const groups = new Map<string, Run[]>()
  for (const r of list) {
    const name = projectOf(r)
    const g = groups.get(name)
    if (g) g.push(r)
    else groups.set(name, [r])
  }
  // Push pendente na base também é trabalho por integrar, mesmo sem chat no período.
  if (ui.focus === 'pending' || ui.focus === 'open' || ui.focus === 'all') {
    const q = ui.q.trim().toLowerCase()
    for (const [name] of unpushedBy) {
      if ((!ui.project || name === ui.project) && (!q || name.toLowerCase().includes(q)) && !groups.has(name)) groups.set(name, [])
    }
  }
  const urgency = (rs: Run[]) => Math.min(...rs.map((r) => RANK[statusOf(r)]), 2)
  const ordered = [...groups.entries()].sort((a, b) => {
    const ga = a[1].some((r) => r.git) || unpushedBy.has(a[0]), gb = b[1].some((r) => r.git) || unpushedBy.has(b[0])
    if (ga !== gb) return ga ? -1 : 1
    return urgency(a[1]) - urgency(b[1]) || Math.max(0, ...b[1].map((r) => r.updatedAt)) - Math.max(0, ...a[1].map((r) => r.updatedAt))
  })

  const x = (t: number) => Math.round(((t - from) / (to - from)) * (width - 24)) + 12
  const tk = ticks(from, to)
  // "hoje" ocupa o último rótulo; os outros ficam só se não encostarem nele.
  const axis = tk.filter((t) => x(to) - x(t.t) > 190).map((t) => `<span class="tick" style="left:${x(t.t)}px">${t.label}</span>`).join('')
  const visibleClean = cleanups.filter((p) => !ui.project || p.project === ui.project)
  const title = { pending: 'O que está pendente', need: 'Esperando sua resposta', open: 'Falta integrar na base', all: 'Todas as branches' }[ui.focus]

  board.innerHTML = ordered.length
    ? `<section class="timeline">
        <div class="tl-head">
          <div><h2>${title}</h2><p>Cada linha sai da branch base, recebe commits e volta quando é mesclada</p></div>
          <div class="tl-tools">${legend()}${visibleClean.length ? `<button class="pill clean" data-clean-all>${ICON.tree}Limpar ${plural(visibleClean.length, 'worktree mesclada', 'worktrees mescladas')}</button>` : ''}</div>
        </div>
        <div class="axis"><div class="axis-lbl">Branch · o que falta</div><div class="axis-track">${axis}<span class="now" style="left:${x(to) + 1}px">hoje · agora</span></div></div>
        ${ordered.map(([name, rs]) => project(name, rs, from, to, width, tk.map((t) => t.t))).join('')}
      </section>`
    : ui.focus === 'pending' && !ui.q && !ui.project && ui.agent === 'all'
      ? `<div class="empty ok"><h2>Tudo integrado</h2><p>Nenhum chat esperando você e nada fora da base ou sem push.</p>${visibleClean.length ? `<button class="link-btn" data-clean-all>Limpar ${plural(visibleClean.length, 'worktree mesclada', 'worktrees mescladas')}</button> ` : ''}<button class="link-btn" data-focus-all>Ver todas as branches</button></div>`
      : `<div class="empty"><p>Nada nesse filtro nos últimos ${ui.days} dias.</p><button class="link-btn" data-clear>Limpar filtros</button></div>`

  const st = all.map(statusOf)
  const need = st.filter((s) => s === 'need').length
  const open = st.filter((s) => s === 'open').length
  const live = all.filter((r) => !r.orphan && Date.now() - r.updatedAt < ACTIVE_MS).length
  const verifying = all.filter((r) => r.stale).length
  const parts = [
    need ? `<b class="s-need">${need} ${need === 1 ? 'precisa' : 'precisam'} de você</b>` : '',
    open ? `<b class="s-open">${open} ${open === 1 ? 'falta' : 'faltam'} integrar</b>` : '',
    !need && !open ? '<b class="s-ok">Tudo integrado</b>' : '',
    live ? `${plural(live, 'ativo', 'ativos')} agora` : '',
    verifying ? `reverificando ${plural(verifying, 'pasta', 'pastas')}` : '',
    `atualizado ${ago(lastLoad)}`,
  ]
  summaryEl.innerHTML = parts.filter(Boolean).join(' · ')
}

function clearFilters() {
  ui.q = ''; qInput.value = ''
  ui.focus = 'pending'; ui.agent = 'all'; ui.project = ''
  syncAgent()
  projectSel.setValue('')
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
// Um cálculo de dica por quadro, mesmo com o mouse disparando vários eventos entre eles.
let moveEv: MouseEvent | null = null
board.addEventListener('mousemove', (ev) => {
  if (!moveEv) requestAnimationFrame(() => {
    const e = moveEv!
    moveEv = null
    const t = e.target as Element
    // Sobre o botão de ações a dica atrapalha a leitura do menu.
    const el = t.closest('[data-more]') || ctx.classList.contains('show') ? null : t.closest<HTMLElement | SVGElement>('[data-id]')
    hover(el?.dataset.id ?? '', e)
  })
  moveEv = ev
})
board.addEventListener('mouseleave', () => { moveEv = null; hover('') })
board.addEventListener('scroll', () => { hover(''); closeMenu() })
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
    runs = IN_TAURI
      ? await invoke<Run[]>('list_runs', { days: ui.days, archived: ui.archived })
      : await fetch('/mock-runs.json').then((r) => r.json())
    lastLoad = Date.now()
    link()
    renderProjects()
    render()
    if (manual || Date.now() - lastPending > PENDING_MS) void loadPending(manual)
    if (manual) toast('Atualizado')
  } catch (e) {
    toast(`Não consegui ler os chats: ${e}`, true)
  } finally {
    loading = false
    refreshBtn.classList.remove('spin')
  }
}

async function loadPending(fresh = false) {
  lastPending = Date.now()
  try {
    pendings = IN_TAURI
      ? await invoke<Pending[]>('list_pending', { fresh })
      : await fetch('/mock-pending.json').then((r) => r.json())
    link()
    renderProjects()
    render()
  } catch (e) {
    toast(`Não consegui verificar as pendências: ${e}`, true)
  }
}

// ---------- Reverificação em segundo plano ----------
let patchTimer = 0
function schedulePatch() {
  clearTimeout(patchTimer)
  patchTimer = window.setTimeout(() => { link(); renderProjects(); render() }, 150)
}
if (IN_TAURI) {
  // O backend respondeu na hora com o último estado; aqui chegam os resultados frescos, em lotes.
  void listen<{ id: string; git: GitInfo | null }[]>('run-git', (e) => {
    const byRun = new Map(runs.map((r) => [r.id, r]))
    let touched = false
    for (const { id, git } of e.payload) {
      const r = byRun.get(id)
      if (!r) continue
      r.git = git; r.stale = false; touched = true
    }
    if (touched) schedulePatch()
  })
  // O vigia de arquivos avisou que uma pasta mudou: recarrega (agrupando várias pastas numa só).
  let fsTimer = 0
  void listen<string[]>('fs-changed', () => {
    clearTimeout(fsTimer)
    fsTimer = window.setTimeout(async () => { if (await onScreen()) void load() }, 1000)
  })
}

async function call(cmd: string, args: Record<string, string>) {
  if (!IN_TAURI) { toast('Esta é só a pré-visualização no navegador; as ações funcionam no app', true); return false }
  try { await invoke(cmd, args); return true } catch (e) { toast(String(e), true); return false }
}

async function copy(text: string, msg: string) {
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

function openRun(r: Run) {
  if (r.openUrl) { toast('Abrindo chat…'); void call('open_run', { url: r.openUrl }) } else void call('open_folder', { path: folderOf(r) })
}

/** Pedido pronto para colar no chat e o agente terminar o que falta (commit, merge, push). */
function request(r: Run) {
  const g = r.git
  if (!g) return ''
  const dirty = Math.max(g.dirty, pendCount(r, 'dirty'))
  const ahead = Math.max(g.merged ? 0 : g.ahead, pendCount(r, 'unmerged'))
  const push = unpushedBy.get(projectOf(r))
  const steps: string[] = []
  if (dirty) steps.push(`revise e faça commit dos ${plural(dirty, 'arquivo pendente', 'arquivos pendentes')}`)
  if (!g.onBase && (ahead || dirty)) steps.push(`mescle a branch \`${g.branch}\` na \`${g.base}\``)
  if (ahead || dirty || push) steps.push(`envie a \`${g.base}\` para o GitHub (push)`)
  if (!steps.length) return ''
  if (g.worktree && !g.onBase) steps.push('remova o worktree se ele não for mais usado')
  return `Finalize o trabalho da branch \`${g.branch}\` em ${r.cwd}: ${steps.join(', ')}. No fim, confirme com git status e git log que nada ficou para trás.`
}

// ---------- Menu de ações (⋯ ou botão direito) ----------
type Item = { label: string; icon: string; act: () => void; danger?: boolean; hint?: string; group?: string }
const ctx = $<HTMLElement>('ctx')
let ctxItems: Item[] = []

function runItems(r: Run): Item[] {
  const items: Item[] = []
  const g = r.git
  if (r.openUrl) items.push({ label: `Abrir chat no ${r.agent === 'codex' ? 'Codex' : 'Claude'}`, icon: ICON.chat, hint: 'Enter', act: () => openRun(r) })
  for (const o of (r.others ?? []).slice(0, 5)) if (o.openUrl) items.push({ label: o.title, icon: ICON.chat, group: 'Outros chats nesta branch', act: () => openRun(o) })
  items.push({ label: 'Abrir pasta', icon: ICON.folder, group: 'Ações', act: () => void call('open_folder', { path: folderOf(r) }) })
  items.push({ label: 'Abrir no VS Code', icon: ICON.code, act: () => void call('open_editor', { path: folderOf(r) }) })
  for (const p of r.prs.filter((p) => p.url)) items.push({ label: `Abrir PR #${p.number} no GitHub`, icon: ICON.pr, act: () => void call('open_link', { url: p.url }) })
  if (g) items.push({ label: 'Copiar nome da branch', icon: ICON.copy, act: () => void copy(g.branch, `Copiado: ${g.branch}`) })
  const req = request(r)
  if (req) items.push({ label: 'Copiar pedido para finalizar', icon: ICON.send, act: () => void copy(req, 'Pedido copiado: cole no chat do agente') })
  const wt = cleanups.find((p) => np(p.path) === np(r.cwd))
  if (wt) items.push({ label: 'Remover worktree mesclada', icon: ICON.trash, danger: true, act: () => confirmRemove([wt]) })
  return items
}

function projItems(name: string): Item[] {
  const any = [...runs, ...orphans].find((r) => projectOf(r) === name && r.git)
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

function openMenu(items: Item[], x: number, y: number, keyboard = false) {
  hover('')
  ctxItems = items
  // Rótulo de seção só aparece quando o grupo muda (ex.: outros chats, depois as ações).
  ctx.innerHTML = items.map((it, i) => `${it.group && it.group !== items[i - 1]?.group && items.some((x) => x.group && x.group !== it.group) ? `<div class="ctx-label">${esc(it.group)}</div>` : ''}${it.danger && i ? '<hr>' : ''}<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}</button>`).join('')
  ctx.classList.add('show')
  const w = ctx.offsetWidth, h = ctx.offsetHeight
  ctx.style.transform = `translate(${Math.min(x, innerWidth - w - 8)}px, ${y + h > innerHeight - 8 ? Math.max(8, y - h) : y}px)`
  if (keyboard) ctx.querySelector<HTMLElement>('button')?.focus()
}
let menuReturn: HTMLElement | null = null
function closeMenu(restore = false) {
  if (!ctx.classList.contains('show')) return
  ctx.classList.remove('show')
  if (restore) menuReturn?.focus()
}
ctx.addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLElement>('[data-i]')
  if (!b) return
  const it = ctxItems[Number(b.dataset.i)]
  closeMenu()
  it.act()
})
ctx.addEventListener('keydown', (ev) => {
  const bs = [...ctx.querySelectorAll<HTMLElement>('button')]
  const i = bs.indexOf(document.activeElement as HTMLElement)
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    bs[(i + (ev.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus()
  } else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); closeMenu(true) }
})
document.addEventListener('pointerdown', (ev) => { if (!ctx.contains(ev.target as Node)) closeMenu() })
window.addEventListener('blur', () => closeMenu())

/** Abre o menu da linha (chat ou cabeçalho de projeto) que contém o elemento. */
function menuFor(el: Element, x: number, y: number, keyboard = false) {
  const head = el.closest<HTMLElement>('[data-proj]')
  if (head) { menuReturn = head; openMenu(projItems(head.dataset.proj!), x, y, keyboard); return true }
  const row = el.closest<HTMLElement | SVGElement>('[data-id]')
  const r = row && byId.get(row.dataset.id!)
  if (!r) return false
  menuReturn = board.querySelector<HTMLElement>(`.trow[data-id="${CSS.escape(r.id)}"]`)
  openMenu(runItems(r), x, y, keyboard)
  return true
}

// ---------- Remover worktrees mescladas ----------
const modal = $<HTMLElement>('modal')
let removing = false
let modalReturn: Element | null = null

function closeModal() {
  if (removing || modal.hidden) return
  modal.hidden = true
  ;(modalReturn as HTMLElement | null)?.focus?.()
}

function confirmRemove(list: Pending[]) {
  // Worktree de um chat ativo agora fica de fora: o agente ainda pode estar usando a pasta.
  const busy = (p: Pending) => runs.some((r) => np(r.cwd) === np(p.path) && Date.now() - r.updatedAt < ACTIVE_MS)
  const ok = list.filter((p) => !busy(p))
  const skipped = list.length - ok.length
  modalReturn = document.activeElement
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <h2 id="m-title">${ok.length ? `Remover ${plural(ok.length, 'worktree mesclada', 'worktrees mescladas')}?` : 'Nada para remover agora'}</h2>
    <p>Só apaga pastas de worktree limpas e já mescladas na base. As branches e os commits continuam no repositório, e o Git recusa qualquer pasta com algo não salvo.${skipped ? ` ${plural(skipped, 'worktree em uso por um chat ativo ficou', 'worktrees em uso por chats ativos ficaram')} de fora.` : ''}</p>
    <ul class="m-list">${ok.map((p) => `<li data-path="${esc(p.path)}"><b>${esc(p.project)}</b> <span class="m-br">${esc(p.branch)}</span><small>${esc(p.path)}</small></li>`).join('')}</ul>
    <div class="m-actions">
      <button class="link-btn" data-m-cancel>${ok.length ? 'Cancelar' : 'Fechar'}</button>
      ${ok.length ? `<button class="danger-btn" data-m-go>Remover ${ok.length}</button>` : ''}
    </div>
  </div>`
  modal.hidden = false
  modal.querySelector<HTMLElement>(ok.length ? '[data-m-cancel]' : '[data-m-cancel]')!.focus()
  modal.querySelector('[data-m-go]')?.addEventListener('click', () => void removeAll(ok))
}

async function removeAll(list: Pending[]) {
  if (!IN_TAURI) { toast('Esta é só a pré-visualização no navegador; as ações funcionam no app', true); return }
  removing = true
  const go = modal.querySelector<HTMLButtonElement>('[data-m-go]')!
  const cancel = modal.querySelector<HTMLButtonElement>('[data-m-cancel]')!
  go.disabled = cancel.disabled = true
  const fails: { p: Pending; err: string }[] = []
  // Algumas em paralelo: cada remoção é quase toda espera por processos do Git.
  let next = 0
  let finished = 0
  go.textContent = `Removendo 0 de ${list.length}…`
  const worker = async () => {
    while (next < list.length) {
      const p = list[next++]
      const li = modal.querySelector<HTMLElement>(`li[data-path="${CSS.escape(p.path)}"]`)
      try {
        await invoke('remove_worktree', { path: p.path })
        li?.classList.add('done')
      } catch (e) {
        fails.push({ p, err: String(e) })
        li?.classList.add('fail')
        li?.insertAdjacentHTML('beforeend', `<em>${esc(String(e))}</em>`)
      }
      go.textContent = `Removendo ${++finished} de ${list.length}…`
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
  removing = false
  const done = list.length - fails.length
  void loadPending(true)
  if (!fails.length) {
    modal.hidden = true
    toast(`${plural(done, 'worktree removida', 'worktrees removidas')}`)
    return
  }
  modal.querySelector('h2')!.textContent = `${done ? `${plural(done, 'removida', 'removidas')}, ` : ''}${plural(fails.length, 'não pôde', 'não puderam')} ser ${fails.length === 1 ? 'removida' : 'removidas'}`
  go.remove()
  cancel.disabled = false
  cancel.textContent = 'Fechar'
  cancel.focus()
}

modal.addEventListener('click', (ev) => {
  const t = ev.target as Element
  if (t === modal || t.closest('[data-m-cancel]')) closeModal()
})

// ---------- Eventos ----------
$<HTMLElement>('status').addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLElement>('[data-focus]')
  if (!b) return
  ui.focus = b.dataset.focus as Focus
  persist(); render()
})
// Menu de preferências fecha ao clicar fora ou com Esc.
const prefs = document.querySelector<HTMLDetailsElement>('.prefs')!
document.addEventListener('pointerdown', (ev) => { if (prefs.open && !prefs.contains(ev.target as Node)) prefs.open = false })
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  if (!modal.hidden) { closeModal(); return }
  if (prefs.open) { prefs.open = false; prefs.querySelector('summary')!.focus() }
})

board.addEventListener('click', (ev) => {
  const t = ev.target as Element
  if (t.closest('[data-clear]')) { clearFilters(); return }
  if (t.closest('[data-focus-all]')) { ui.focus = 'all'; persist(); render(); return }
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
})
board.addEventListener('contextmenu', (ev) => {
  if (menuFor(ev.target as Element, ev.clientX, ev.clientY)) ev.preventDefault()
})
board.addEventListener('keydown', (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('.trow[data-id]')
  if (!row || ev.target !== row) return
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); row.click() }
  // Shift+F10 e a tecla de menu abrem as ações pelo teclado.
  if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
    ev.preventDefault()
    const b = row.getBoundingClientRect()
    menuFor(row, b.left + 24, b.bottom, true)
  }
})

// Digitação rápida redesenha uma vez por quadro, não a cada tecla.
let typing = 0
qInput.addEventListener('input', () => {
  ui.q = qInput.value
  cancelAnimationFrame(typing)
  typing = requestAnimationFrame(() => render())
})
function syncAgent() {
  document.querySelectorAll<HTMLButtonElement>('#agent button').forEach((x) => {
    x.classList.toggle('on', x.dataset.v === ui.agent)
    x.setAttribute('aria-checked', String(x.dataset.v === ui.agent))
  })
}
document.querySelectorAll<HTMLButtonElement>('#agent button').forEach((b) => {
  b.addEventListener('click', () => { ui.agent = b.dataset.v!; syncAgent(); persist(); render() })
})
syncAgent()
daysSel.setValue(String(ui.days))
archivedChk.checked = ui.archived
archivedChk.addEventListener('change', () => { ui.archived = archivedChk.checked; persist(); void load() })
refreshBtn.addEventListener('click', () => void load(true))

// ---------- Atualização do app (GitHub Releases) ----------
const updBtn = $<HTMLButtonElement>('update')
let updating = false
async function checkUpdate() {
  if (!IN_TAURI || updating) return
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
if (IN_TAURI) {
  void listen<number>('update-progress', (e) => { updBtn.textContent = e.payload >= 100 ? 'Instalando…' : `Baixando ${e.payload}%` })
  setTimeout(() => void checkUpdate(), 5_000)
  setInterval(() => void checkUpdate(), 4 * 3_600_000)
}

const autoChk = $<HTMLInputElement>('autostart')
if (IN_TAURI) {
  void invoke<boolean>('get_autostart').then((on) => (autoChk.checked = on))
  void listen('pending-updated', () => void loadPending())
}
autoChk.addEventListener('change', async () => {
  try {
    await invoke('set_autostart', { on: autoChk.checked })
    toast(autoChk.checked ? 'O painel vai iniciar com o Windows, na bandeja' : 'Não inicia mais com o Windows')
  } catch (e) { autoChk.checked = !autoChk.checked; toast(String(e), true) }
})
/** Janela na bandeja ou minimizada não precisa atualizar a tela (o aviso do Windows segue pelo backend). */
const appWin = IN_TAURI ? getCurrentWindow() : null
async function onScreen() {
  if (document.hidden) return false
  if (!appWin) return true
  try { return (await appWin.isVisible()) && !(await appWin.isMinimized()) } catch { return true }
}
window.addEventListener('focus', () => { if (Date.now() - lastLoad > 10_000) void load() })
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey && ev.key.toLowerCase() === 'f') || (ev.key === '/' && document.activeElement !== qInput)) {
    ev.preventDefault(); qInput.focus(); qInput.select()
  }
  if (ev.key === 'F5') { ev.preventDefault(); void load(true) }
})
setInterval(async () => { if (await onScreen()) void load() }, REFRESH_MS)
setInterval(async () => { if (lastLoad && !ctx.classList.contains('show') && (await onScreen())) render() }, 30_000)

$<HTMLElement>('version').textContent = `v${__APP_VERSION__} · ${__BUILD_DATE__}`
render()
void load()
