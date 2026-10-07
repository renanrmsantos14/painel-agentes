// Linha do tempo em forma de grafo de Git: um bloco por projeto, uma faixa por chat.
import type { CSSProperties, ReactNode } from 'react'
import { ICON } from './icons'
import {
  type Focus, type Pending, type Run, type Status, type StatusOf,
  RANK, STATUS, STALE_MS, agentName, ago, badgeText, isLive, pendSince, plural, projectOf, whatText,
} from './model'

export const ROW = 44
export const LABEL_W = 300
// Linha da branch base fica no meio da linha de cabeçalho do projeto.
const MAIN_Y = ROW / 2
const R = 24 // raio das curvas de saída e de retorno

const vars = (v: Record<string, string>) => v as CSSProperties

function Label({ r, s }: { r: Run; s: Status }) {
  const st = STATUS[s]
  const since = r.pend?.length ? pendSince(r) : 0
  const stale = since && Date.now() - since > STALE_MS
  const who = r.orphan && !r.openUrl ? 'Sem chat · abre a pasta' : `${agentName(r.agent)} · ${r.title}`
  return (
    <div className="lbl" style={vars({ '--c': st.color, '--s-soft': st.soft, '--s-text': st.text })}>
      <div className="lbl-top">
        <span className="br" title={r.git?.branch ?? ''}>{r.git?.branch ?? 'Sem repositório'}</span>
        <span className="badge">{badgeText(r, s)}</span>
        {r.stale ? <i className="verifying" title="Reverificando o Git" /> : null}
        {isLive(r) ? <i className="live" title="Ativo agora" /> : null}
        {r.others?.length ? <span className="n-chats" title={`${plural(r.others.length + 1, 'chat', 'chats')} nesta branch`}>{r.others.length + 1} chats</span> : null}
      </div>
      <div className="lbl-sub">
        <i className={`dot ${r.agent}`} title={agentName(r.agent)} />
        <span className="lbl-title">{s === 'open' || s === 'need' ? whatText(r, s) : who}</span>
        {stale ? <span className="stale">parado {ago(since)}</span> : null}
      </div>
      <button className="more" data-more tabIndex={-1} aria-label="Ações">{ICON.more}</button>
    </div>
  )
}

export function Tooltip({ r, s }: { r: Run; s: Status }) {
  const g = r.git
  const commits = g?.commits ?? []
  const noChat = r.orphan && !r.openUrl
  const prs = r.prs.filter((p) => p.url)
  return (
    <>
      <div className="tt-head"><i className={`dot ${r.agent}`} />{noChat ? 'Sem chat ligado' : `${agentName(r.agent)} · ${ago(r.updatedAt)}`}</div>
      <div className="tt-title">{noChat ? projectOf(r) : r.title}</div>
      {g ? <div className="tt-branch">{ICON.branch}{g.onBase ? g.branch : `${g.branch} → ${g.base}`}{g.worktree ? ' · worktree' : ''}{g.worktreeMissing ? ' · worktree removida' : ''}</div> : null}
      {s === 'need' && r.needsAction ? <div className="tt-need">{r.needsAction}</div> : r.detail ? <div className="tt-detail">{r.detail}</div> : null}
      {s === 'open' || (s === 'need' && r.pend?.length) ? <div className="tt-todo">{whatText(r, s)}</div> : null}
      {commits.length ? (
        <ul className="tt-commits">
          {commits.map((c, i) => <li key={i}>{c}</li>)}
          {(g?.commitCount ?? 0) > commits.length ? <li className="more">+ {g!.commitCount - commits.length} outros</li> : null}
        </ul>
      ) : null}
      {prs.length ? <div className="tt-prs">{prs.map((p) => <span key={p.number} className="tt-pr">{ICON.pr}PR #{p.number} · {p.state.toLowerCase()}</span>)}</div> : null}
      {r.others?.length ? <div className="tt-others">Também nesta branch: {r.others.slice(0, 4).map((o) => o.title).join(' · ')}{r.others.length > 4 ? ` e mais ${r.others.length - 4}` : ''}</div> : null}
      <div className="tt-foot">Clique abre {r.openUrl ? 'o chat' : 'a pasta'} · botão direito mostra as ações</div>
    </>
  )
}

/** Pontos de commit distribuídos ao longo da faixa (o Git não dá a data de cada commit aqui). */
function CommitDots({ n, x0, x1, y, c }: { n: number; x0: number; x1: number; y: number; c: string }) {
  const span = x1 - x0
  if (n <= 0 || span < 24) return null
  const k = Math.min(n, Math.floor(span / 28))
  return <>{Array.from({ length: k }, (_, i) => <circle key={i} className="commit" cx={Math.round(x0 + (span * (i + 1)) / (k + 1))} cy={y} r="4.5" style={vars({ '--c': c })} />)}</>
}

type Scale = { from: number; to: number; width: number }

function Lane({ r, s, y, hasGit, sc }: { r: Run; s: Status; y: number; hasGit: boolean; sc: Scale }) {
  const { from, to, width } = sc
  const x = (t: number) => Math.round(((Math.min(Math.max(t, from), to) - from) / (to - from)) * (width - 24)) + 12
  const live = isLive(r)
  // A faixa precisa de espaço para as duas curvas; perto de "hoje" ela recua a saída em vez de passar da borda.
  const span = R * 2 + 12
  const x1 = Math.min(x(to), Math.max(x(live ? to : r.updatedAt), x(r.createdAt) + span))
  const x0 = Math.min(x(r.createdAt), x1 - span)
  const st = STATUS[s]
  const c = st.color
  const g = r.git
  const pr = r.prs.find((p) => p.url)
  const cls = `lane ${s}${live ? ' live' : ''}${g ? '' : ' nogit'}${r.orphan ? ' orphan' : ''}`
  const props = { className: cls, 'data-id': r.id, style: vars({ '--c': c, '--s-text': st.text }) }
  const entering = r.createdAt < from // começou antes do período: entra pela borda, sem bifurcação
  const flag = <rect className="flag" x={x1 - 7} y={y - 7} width="14" height="14" rx="3" />

  if (!g || !hasGit) return <g {...props}><path className="lane-line" d={`M${x0} ${y}H${x1}`} /><circle className="commit" cx={x1} cy={y} r="4.5" /></g>
  if (g.onBase) {
    // Trabalho direto na base: faixa reta ligada por um ponto cheio na linha principal.
    return (
      <g {...props}>
        <path className="hint" d={`M${x1} ${y}V${MAIN_Y + 6}`} />
        <path className="lane-line" d={`M${x0} ${y}H${x1}`} />
        <CommitDots n={g.commitCount} x0={x0} x1={x1} y={y} c={c} />
        {s === 'main' ? <circle className="on-main" cx={x1} cy={MAIN_Y} r="6" /> : null}
        {s === 'need' ? flag : <circle className="ring" cx={x1} cy={y} r="6" />}
      </g>
    )
  }
  const merged = s === 'merged'
  // Sai da base descendo em trilho vertical e dobra com canto arredondado (estilo grafo de Git); a volta é o espelho.
  const fork = entering ? `M${x0} ${y}` : `M${x0} ${MAIN_Y}V${y - R}Q${x0} ${y} ${x0 + R} ${y}`
  const laneEnd = merged ? x1 - R : x1
  const back = merged ? `Q${x1} ${y} ${x1} ${y - R}V${MAIN_Y}` : ''
  let tip: ReactNode
  if (merged) tip = <circle className="on-main" cx={x1} cy={MAIN_Y} r="7" />
  else if (s === 'need') tip = flag
  else if (s === 'open') {
    const right = x1 > width - 150
    tip = <>
      <circle className="ring" cx={x1} cy={y} r="7" />
      <path className="up" d={`M${x1} ${y - 11}V${y - 20}M${x1 - 3.5} ${y - 16.5}L${x1} ${y - 20}L${x1 + 3.5} ${y - 16.5}`} />
      {pr ? <text className="pr-label" x={right ? x1 - 10 : x1 + 12} y={right ? y + 19 : y + 4} textAnchor={right ? 'end' : undefined}>PR #{pr.number} → {g.base}</text> : null}
    </>
  } else tip = <circle className="ring" cx={x1} cy={y} r="6" />
  return (
    <g {...props}>
      <path className="lane-line" d={`${fork}H${laneEnd}${back}`} />
      {entering ? null : <circle className="fork" cx={x0} cy={MAIN_Y} r="4" />}
      <CommitDots n={g.commitCount} x0={entering ? x0 : x0 + R} x1={laneEnd} y={y} c={c} />
      {tip}
    </g>
  )
}

type ProjectProps = {
  name: string; list: Run[]; sc: Scale; dayTicks: number[]; statusOf: StatusOf
  unpushed?: Pending; clean: number
}

/**
 * Desenha um projeto como grafo de Git: a base é uma linha navy grossa no cabeçalho;
 * cada chat sai dela com uma curva, mostra seus commits como pontos e volta com um ponto cheio quando é mesclado.
 */
export function Project({ name, list, sc, dayTicks, statusOf, unpushed, clean }: ProjectProps) {
  const { from, to, width } = sc
  const base = list.find((r) => r.git)?.git?.base ?? unpushed?.base ?? ''
  const hasGit = Boolean(base)
  const x = (t: number) => Math.round(((Math.min(Math.max(t, from), to) - from) / (to - from)) * (width - 24)) + 12
  // O que precisa de ação fica no topo do projeto; dentro de cada grupo, os mais novos primeiro.
  const rows = [...list].sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)] || b.createdAt - a.createdAt)
  const H = ROW * (rows.length + 1)
  const n = list.filter((r) => !r.orphan).reduce((k, r) => k + 1 + (r.others?.length ?? 0), 0)
  const xt = x(to)

  return (
    <section className="proj">
      <div className="trow head" data-proj={name}>
        <div className="lbl proj-lbl">
          <span className="proj-name" title={`${name}${n ? ` · ${plural(n, 'chat', 'chats')}` : ''}`}>{ICON.folder}{name}</span>
          {hasGit ? <span className="base-tag">{base}</span> : <span className="base-tag muted">sem Git</span>}
          {unpushed ? <button className="pill push" data-push={name} title={unpushed.commits.join('\n')}>{ICON.up}{unpushed.count} sem push</button> : null}
          {clean ? <button className="pill clean" data-clean-proj={name} title="Worktrees já mescladas e limpas">{ICON.tree}{clean}</button> : null}
          <button className="more" data-more tabIndex={-1} aria-label="Ações do projeto">{ICON.more}</button>
        </div>
        <div className="tgraph" />
      </div>
      {rows.map((r) => {
        const s = statusOf(r)
        return (
          <div key={r.id} className={`trow${r.archived ? ' archived' : ''}${r.stale ? ' stale' : ''}`} data-id={r.id} tabIndex={0} role="button"
            aria-label={`${r.git?.branch ?? ''} ${badgeText(r, s)}: ${r.title}`}>
            <Label r={r} s={s} />
            <div className="tgraph" />
          </div>
        )
      })}
      <svg className="graph" width={width} height={H} viewBox={`0 0 ${width} ${H}`} style={{ left: LABEL_W, width, height: H }}>
        <path className="grid" d={dayTicks.map((t) => `M${x(t)} 0V${H}`).join('')} />
        <line className={`main-line${hasGit ? '' : ' muted'}`} x1={x(from)} y1={MAIN_Y} x2={xt} y2={MAIN_Y} />
        {unpushed ? <g className="unpushed-tip"><circle cx={xt} cy={MAIN_Y} r="7" /><path d={`M${xt} ${MAIN_Y + 3}V${MAIN_Y - 3}M${xt - 3} ${MAIN_Y}L${xt} ${MAIN_Y - 3}L${xt + 3} ${MAIN_Y}`} /></g> : null}
        <line className="now-mark" x1={xt} y1={ROW} x2={xt} y2={H} />
        {rows.map((r, i) => <Lane key={r.id} r={r} s={statusOf(r)} y={ROW * (i + 1) + ROW / 2} hasGit={hasGit} sc={sc} />)}
      </svg>
    </section>
  )
}

export function Legend({ focus }: { focus: Focus }) {
  return (
    <div className="legend" aria-label="Legenda">
      <span><svg viewBox="0 0 22 14"><rect x="5" y="1" width="12" height="12" rx="3" fill="var(--need)" stroke="none" /></svg>Precisa de você</span>
      <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5" fill="#fff" stroke="var(--progress)" strokeWidth="2.5" /></svg>Falta integrar</span>
      <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="4" fill="#fff" stroke="var(--bt-color-slate-700)" strokeWidth="2.5" /></svg>Commit</span>
      {focus === 'all' ? <>
        <span><svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="5.5" fill="var(--merged)" stroke="none" /></svg>Mesclado</span>
        <span><svg viewBox="0 0 22 14"><path d="M1 7H21" stroke="var(--idle)" strokeWidth="2.5" strokeDasharray="3 3" /></svg>Sem mudanças</span>
      </> : null}
    </div>
  )
}
