// Tipos do backend e regras puras do painel (sem DOM nem React).

export type Agent = 'claude' | 'codex' | 'git'
export type Pr = { number: number; url: string; state: string }
export type GitInfo = {
  project: string; repoRoot: string; branch: string; base: string; onBase: boolean; branchExists: boolean
  worktree: boolean; worktreeMissing: boolean; ahead: number; behind: number; merged: boolean
  commits: string[]; commitCount: number; files: number; insertions: number; deletions: number; dirty: number
}
export type Run = {
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
export type Pending = {
  key: string; kind: 'dirty' | 'unmerged' | 'unpushed' | 'cleanup'; project: string; repoRoot: string; path: string
  branch: string; base: string; count: number; lastActivity: number; commits: string[]; worktree: boolean
  chatTitle: string | null; chatUrl: string | null; chatAgent: 'claude' | 'codex' | null
}

export const ACTIVE_MS = 10 * 60_000
// Pendência parada há mais que isso aparece como esquecida (e gera aviso do Windows).
export const STALE_MS = 86_400_000
export const REFRESH_MS = 45_000
// A varredura de pendências (todos os repositórios) é cara: refaz no máximo a cada 2 min, salvo no F5.
export const PENDING_MS = 2 * 60_000
// Pedidos parados há mais que isso deixam de contar como "Precisa de você" (o agente já foi deixado de lado).
const NEED_MS = 3 * 86_400_000
export const IN_TAURI = '__TAURI_INTERNALS__' in window

export const np = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
export const agentName = (a: Agent) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'Sem chat')

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'ontem' : `há ${d} dias`
}

export const projectOf = (r: Run) => r.git?.project || r.cwd.split(/[\\/]/).filter(Boolean).pop() || 'Sem pasta'
export const folderOf = (r: Run) => (r.git && !r.git.worktreeMissing ? r.cwd : r.git?.repoRoot ?? r.cwd)
export const isLive = (r: Run) => Date.now() - r.updatedAt < ACTIVE_MS && !r.orphan

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

export type Linked = { runs: Run[]; orphans: Run[]; cleanups: Pending[]; unpushedBy: Map<string, Pending> }

/** Liga cada pendência ao chat mais recente na mesma branch; o que sobra vira linha própria no grafo. */
export function link(source: Run[], pendings: Pending[]): Linked {
  const runs = source.map((r) => ({ ...r, pend: [] as Pending[] }))
  const cleanups = pendings.filter((p) => p.kind === 'cleanup')
  const unpushedBy = new Map(pendings.filter((p) => p.kind === 'unpushed').map((p) => [p.project, p]))
  const synth = new Map<string, Run>()
  for (const p of pendings) {
    if (p.kind === 'cleanup' || p.kind === 'unpushed') continue
    const cands = runs.filter((r) => r.git && np(r.git.repoRoot) === np(p.repoRoot) && r.git.branch === p.branch)
    const sameDir = cands.filter((r) => np(r.cwd) === np(p.path))
    const hit = (sameDir.length ? sameDir : cands).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (hit) { hit.pend.push(p); continue }
    const k = `${np(p.path)}|${p.branch}`
    const o = synth.get(k) ?? pendAsRun(p)
    o.pend!.push(p)
    if (p.kind === 'dirty') o.git!.dirty = p.count
    if (p.kind === 'unmerged') { o.git!.ahead = o.git!.commitCount = p.count; o.git!.commits = p.commits }
    o.updatedAt = Math.max(o.updatedAt, p.lastActivity)
    synth.set(k, o)
  }
  return { runs, orphans: [...synth.values()], cleanups, unpushedBy }
}

export const pendCount = (r: Run, kind: Pending['kind']) => r.pend?.filter((p) => p.kind === kind).reduce((n, p) => n + p.count, 0) ?? 0
/** Atividade mais antiga entre as pendências do chat (para destacar o que está parado). */
export const pendSince = (r: Run) => Math.min(...(r.pend ?? []).map((p) => p.lastActivity || Date.now()), Date.now())

export type Status = 'need' | 'open' | 'merged' | 'main' | 'idle' | 'done'

/** Baixas dadas pelo usuário: id da linha -> `updatedAt` no momento da baixa. Atividade nova reabre. */
export type Dismissed = Record<string, number>

export function loadDismissed(): Dismissed {
  try { return JSON.parse(localStorage.getItem('baixas') ?? '{}') } catch { return {} }
}
export function saveDismissed(d: Dismissed) {
  try { localStorage.setItem('baixas', JSON.stringify(d)) } catch { /* sem armazenamento */ }
}

function computeStatus(r: Run, dismissed: Dismissed): Status {
  const s = baseStatus(r)
  return (s === 'need' || s === 'open') && (dismissed[r.id] ?? -1) >= r.updatedAt ? 'done' : s
}

function baseStatus(r: Run): Status {
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

/** Classificador com memo: o mesmo chat é classificado várias vezes por renderização. */
export function statusMemo(dismissed: Dismissed = {}) {
  const memo = new WeakMap<Run, Status>()
  return (r: Run) => {
    let s = memo.get(r)
    if (!s) memo.set(r, (s = computeStatus(r, dismissed)))
    return s
  }
}
export type StatusOf = ReturnType<typeof statusMemo>

// Cada estado é um par cor/fundo/texto do design system (status nunca só pela cor: a forma no grafo muda também).
export const STATUS: Record<Status, { label: string; color: string; soft: string; text: string }> = {
  need: { label: 'Precisa de você', color: 'var(--need)', soft: 'var(--need-soft)', text: 'var(--need-text)' },
  open: { label: 'Falta integrar', color: 'var(--progress)', soft: 'var(--progress-soft)', text: 'var(--progress-text)' },
  merged: { label: 'Mesclado', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  main: { label: 'Direto na base', color: 'var(--merged)', soft: 'var(--merged-soft)', text: 'var(--merged-text)' },
  idle: { label: 'Sem mudanças', color: 'var(--idle)', soft: 'var(--idle-soft)', text: 'var(--idle-text)' },
  done: { label: 'Com baixa', color: 'var(--idle)', soft: 'var(--idle-soft)', text: 'var(--idle-text)' },
}

export const RANK: Record<Status, number> = { need: 0, open: 1, main: 2, merged: 2, idle: 3, done: 3 }

export type Focus = 'pending' | 'need' | 'open' | 'done' | 'all'
export const FOCUS: { v: Focus; label: string; color: string; test: (s: Status) => boolean }[] = [
  { v: 'pending', label: 'Pendentes', color: 'var(--bt-color-brand)', test: (s) => s === 'need' || s === 'open' },
  { v: 'need', label: 'Precisa de você', color: 'var(--need)', test: (s) => s === 'need' },
  { v: 'open', label: 'Falta integrar', color: 'var(--progress)', test: (s) => s === 'open' },
  { v: 'done', label: 'Com baixa', color: 'var(--idle)', test: (s) => s === 'done' },
  { v: 'all', label: 'Todos', color: 'var(--idle)', test: () => true },
]

/** Etiqueta curta: diz o próximo passo, não só o estado. */
export function badgeText(r: Run, s: Status) {
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
export function whatText(r: Run, s: Status) {
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

/**
 * Vários chats na mesma branch e pasta viram uma linha: o mais recente representa o grupo
 * e a faixa vai do primeiro ao último. Quem espera resposta fica sempre em linha própria.
 */
export function collapse(list: Run[], statusOf: StatusOf) {
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

/** Marcas do eixo do tempo: um rótulo por dia (ou por semana em períodos longos). */
export function ticks(from: number, to: number, days: number, width: number) {
  // Passo em dias para manter ~80px entre rótulos.
  const perDay = (width - 24) / days
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

/** Pedido pronto para colar no chat e o agente terminar o que falta (commit, merge, push). */
export function request(r: Run, push: Pending | undefined) {
  const g = r.git
  if (!g) return ''
  const dirty = Math.max(g.dirty, pendCount(r, 'dirty'))
  const ahead = Math.max(g.merged ? 0 : g.ahead, pendCount(r, 'unmerged'))
  const steps: string[] = []
  if (dirty) steps.push(`revise e faça commit dos ${plural(dirty, 'arquivo pendente', 'arquivos pendentes')}`)
  if (!g.onBase && (ahead || dirty)) steps.push(`mescle a branch \`${g.branch}\` na \`${g.base}\``)
  if (ahead || dirty || push) steps.push(`envie a \`${g.base}\` para o GitHub (push)`)
  if (!steps.length) return ''
  if (g.worktree && !g.onBase) steps.push('remova o worktree se ele não for mais usado')
  return `Finalize o trabalho da branch \`${g.branch}\` em ${r.cwd}: ${steps.join(', ')}. No fim, confirme com git status e git log que nada ficou para trás.`
}
