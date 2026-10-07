// Configurações do painel: gaveta lateral com abas, montada com os componentes do Design System.
// As alterações ficam pendentes até "Salvar alterações"; a aba Atualização age na hora.
import './react-global'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState, useSyncExternalStore } from 'react'
import B from './vendor/betinhos-ui.js'

const { Drawer, Dialog, Tabs, Checkbox, SegmentedControl, Field, Input, Button, Alert, Progress } = B
const IN_APP = '__TAURI_INTERNALS__' in window
const RELEASES = 'https://github.com/renanrmsantos14/painel-agentes/releases'

export type View = { agent: string; days: number; archived: boolean }
type Backend = { startMinimized: boolean; notify: boolean; notifyAfterDays: number; roots: string[] }
type Draft = Backend & View & { autostart: boolean }
export type Tab = 'geral' | 'exibicao' | 'avisos' | 'pastas' | 'atualizacao'
export type Bridge = { view: () => View; applyView: (v: View) => void; afterSave: () => void; toast: (msg: string, error?: boolean) => void }

// ---------- Estado da atualização, compartilhado com o botão do topo ----------
export type UpdateState =
  | { s: 'idle' | 'checking' | 'latest' }
  | { s: 'available'; version: string; notes?: string | null }
  | { s: 'downloading'; version: string; pct: number }
  | { s: 'installing'; version: string }
  | { s: 'error'; msg: string; version?: string }

let upd: UpdateState = { s: 'idle' }
const subs = new Set<() => void>()
const setUpd = (next: UpdateState) => { upd = next; subs.forEach((f) => f()) }

export const updates = {
  get: () => upd,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
  async check(quiet = false) {
    if (!IN_APP || upd.s === 'checking' || upd.s === 'downloading' || upd.s === 'installing') return
    const before = upd
    setUpd({ s: 'checking' })
    try {
      const u = await invoke<{ version: string; notes?: string | null } | null>('check_update')
      setUpd(u ? { s: 'available', version: u.version, notes: u.notes } : { s: 'latest' })
    } catch (e) {
      // Na verificação automática, sem internet não vira erro na tela: tenta de novo depois.
      setUpd(quiet ? before : { s: 'error', msg: String(e) })
    }
  },
  async install() {
    if (upd.s !== 'available' && !(upd.s === 'error' && upd.version)) return
    const version = upd.version!
    setUpd({ s: 'downloading', version, pct: 0 })
    try { await invoke('install_update') } catch (e) { setUpd({ s: 'error', msg: String(e), version }) }
  },
}
if (IN_APP) {
  void listen<number>('update-progress', (e) => {
    if (upd.s !== 'downloading' && upd.s !== 'installing') return
    const version = upd.version
    setUpd(e.payload >= 100 ? { s: 'installing', version } : { s: 'downloading', version, pct: e.payload })
  })
}

// ---------- Leitura e gravação ----------
const BROWSER_DEFAULTS: Backend = { startMinimized: true, notify: true, notifyAfterDays: 1, roots: ['C:\\Users\\voce\\Desktop\\vscode', 'C:\\Users\\voce\\Desktop\\Projetos'] }

async function loadDraft(view: View): Promise<Draft> {
  if (!IN_APP) return { ...BROWSER_DEFAULTS, ...view, autostart: false }
  const [cfg, autostart] = await Promise.all([invoke<Backend>('get_settings'), invoke<boolean>('get_autostart')])
  return { ...cfg, ...view, autostart }
}

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

// ---------- Abas ----------
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="set-section"><h3 className="set-eyebrow">{title}</h3><div className="set-stack">{children}</div></section>
}

function Geral({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <Section title="Inicialização">
      <Checkbox label="Iniciar com o Windows" description={IN_APP ? 'O painel abre sozinho ao entrar no Windows, para os avisos funcionarem.' : 'Disponível no app instalado.'}
        checked={d.autostart} disabled={!IN_APP} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ autostart: e.target.checked })} />
      <Checkbox label="Começar minimizado na bandeja" description="Abre escondido; clique no ícone da bandeja para ver o painel."
        checked={d.startMinimized} disabled={!IN_APP || !d.autostart} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ startMinimized: e.target.checked })} />
    </Section>
  )
}

function Exibicao({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <>
      <Section title="Chats">
        <Field label="Agente" hint="Mostra os chats só deste agente.">
          <SegmentedControl aria-label="Agente" value={d.agent} onChange={(agent: string) => set({ agent })}
            options={[{ value: 'all', label: 'Todos' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} />
        </Field>
        <Field label="Período" hint="Quanto tempo para trás a linha do tempo mostra.">
          <SegmentedControl aria-label="Período" value={String(d.days)} onChange={(v: string) => set({ days: Number(v) })}
            options={[3, 7, 30, 90].map((n) => ({ value: String(n), label: `${n} dias` }))} />
        </Field>
        <Checkbox label="Mostrar chats arquivados" description="Inclui os chats arquivados no Claude e no Codex."
          checked={d.archived} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ archived: e.target.checked })} />
      </Section>
    </>
  )
}

function Avisos({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <Section title="Avisos do Windows">
      <Checkbox label="Avisar trabalho esquecido no Git" description="Arquivos sem commit, commits sem push e branches sem mesclar. Cada item é avisado no máximo uma vez por dia."
        checked={d.notify} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ notify: e.target.checked })} />
      <Field label="Avisar depois de" hint="Tempo parado antes do primeiro aviso." disabled={!d.notify}>
        <SegmentedControl aria-label="Avisar depois de" value={String(d.notifyAfterDays)} onChange={(v: string) => set({ notifyAfterDays: Number(v) })}
          options={[1, 2, 3, 7].map((n) => ({ value: String(n), label: n === 1 ? '1 dia' : `${n} dias`, disabled: !d.notify }))} />
      </Field>
    </Section>
  )
}

function Pastas({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const [nova, setNova] = useState('')
  const add = () => {
    const p = nova.trim().replace(/[\\/]+$/, '')
    if (!p) return
    if (!d.roots.some((r) => r.toLowerCase() === p.toLowerCase())) set({ roots: [...d.roots, p] })
    setNova('')
  }
  return (
    <Section title="Onde procurar repositórios">
      <p className="set-hint">Toda subpasta com Git dentro destas pastas entra no painel, mesmo sem chat. As pastas dos chats entram sempre.</p>
      {d.roots.length ? (
        <ul className="set-list">
          {d.roots.map((r) => (
            <li key={r}>
              <span className="set-path" title={r}>{r}</span>
              <Button variant="ghost" size="compact" aria-label={`Remover ${r}`} onClick={() => set({ roots: d.roots.filter((x) => x !== r) })}>Remover</Button>
            </li>
          ))}
        </ul>
      ) : <Alert tone="warning" title="Nenhuma pasta">Só os repositórios abertos em chats vão aparecer.</Alert>}
      <div className="set-add">
        <Field label="Adicionar pasta" hint="Cole o caminho completo, por exemplo C:\Users\voce\Desktop\Clientes.">
          <Input value={nova} placeholder="C:\…" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNova(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        </Field>
        <Button variant="secondary" onClick={add} disabled={!nova.trim()}>Adicionar</Button>
      </div>
    </Section>
  )
}

function Atualizacao({ openLink }: { openLink: (url: string) => void }) {
  const u = useSyncExternalStore(updates.subscribe, updates.get)
  if (!IN_APP) return <Section title="Atualização"><p className="set-hint">Atualização automática disponível no app instalado. Versão desta tela: v{__APP_VERSION__}.</p></Section>
  const busy = u.s === 'checking' || u.s === 'downloading' || u.s === 'installing'
  const status = {
    idle: 'As versões novas são verificadas ao abrir o app e a cada 4 horas.',
    checking: 'Verificando…',
    latest: 'Você está na versão mais recente.',
    available: u.s === 'available' ? `Versão nova disponível: v${u.version}.` : '',
    downloading: u.s === 'downloading' ? `Baixando v${u.version}… ${u.pct}%` : '',
    installing: 'Instalando a versão nova. O painel reabre sozinho.',
    error: u.s === 'error' ? `Não foi possível ${u.version ? 'atualizar' : 'verificar'} agora. Confira a internet. (${u.msg})` : '',
  }[u.s]
  return (
    <Section title="Atualização">
      <p className="set-version">Versão instalada: <b>v{__APP_VERSION__}</b> · {__BUILD_DATE__}</p>
      {u.s === 'error' ? <Alert tone="danger">{status}</Alert> : <p className="set-hint" role="status">{status}</p>}
      {u.s === 'downloading' ? <Progress label="Download" value={u.pct} /> : null}
      {u.s === 'available' && u.notes ? <p className="set-hint">{u.notes}</p> : null}
      <div className="set-actions">
        <Button variant="secondary" loading={u.s === 'checking'} disabled={busy} onClick={() => void updates.check()}>Verificar atualização</Button>
        {u.s === 'available' || (u.s === 'error' && u.version) ? <Button onClick={() => void updates.install()}>{u.s === 'error' ? 'Tentar de novo' : 'Atualizar agora'}</Button> : null}
        <Button variant="ghost" onClick={() => openLink(RELEASES)}>Ver todas as versões</Button>
      </div>
    </Section>
  )
}

// ---------- Gaveta ----------
const TABS: { value: Tab; label: string }[] = [
  { value: 'geral', label: 'Geral' }, { value: 'exibicao', label: 'Exibição' }, { value: 'avisos', label: 'Avisos' },
  { value: 'pastas', label: 'Pastas' }, { value: 'atualizacao', label: 'Atualização' },
]

export function Settings({ bridge, req }: { bridge: Bridge; req: { tab: Tab; n: number } | null }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('geral')
  const [initial, setInitial] = useState<Draft | null>(null)
  const [d, setD] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    if (!req) return
    setTab(req.tab); setOpen(true); setError(''); setD(null)
    loadDraft(bridge.view()).then((x) => { setInitial(x); setD(x) }, (e) => setError(String(e)))
  }, [req])

  const dirty = !!d && !!initial && !same(d, initial)
  const set = (p: Partial<Draft>) => setD((x) => (x ? { ...x, ...p } : x))
  const close = () => { if (saving) return; if (dirty) setConfirm(true); else setOpen(false) }

  async function save() {
    if (!d || !initial) return
    setSaving(true); setError('')
    try {
      if (IN_APP) {
        const { autostart, agent, days, archived, ...cfg } = d
        await invoke('save_settings', { value: cfg })
        if (autostart !== initial.autostart) await invoke('set_autostart', { on: autostart })
      }
      const v: View = { agent: d.agent, days: d.days, archived: d.archived }
      if (JSON.stringify(v) !== JSON.stringify({ agent: initial.agent, days: initial.days, archived: initial.archived })) bridge.applyView(v)
      if (d.roots.join('|') !== initial.roots.join('|')) bridge.afterSave()
      setOpen(false)
      bridge.toast('Configurações salvas')
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const openLink = (url: string) => { if (IN_APP) void invoke('open_link', { url }); else window.open(url, '_blank') }
  const body = !d ? (error ? <Alert tone="danger" title="Não foi possível abrir as configurações">{error}</Alert> : <p className="set-hint">Carregando…</p>)
    : tab === 'geral' ? <Geral d={d} set={set} />
    : tab === 'exibicao' ? <Exibicao d={d} set={set} />
    : tab === 'avisos' ? <Avisos d={d} set={set} />
    : tab === 'pastas' ? <Pastas d={d} set={set} />
    : <Atualizacao openLink={openLink} />

  return (
    <>
      <Drawer open={open} onClose={close} title="Configurações" size="default"
        footer={<>
          <Button variant="secondary" onClick={close} disabled={saving}>Cancelar</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!dirty}>Salvar alterações</Button>
        </>}>
        <Tabs aria-label="Seções das configurações" value={tab} onChange={(t: Tab) => setTab(t)} tabs={TABS} />
        <div className="set-body">
          {error && d ? <Alert tone="danger" title="Não foi possível salvar">{error}</Alert> : null}
          {body}
        </div>
      </Drawer>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Descartar alterações?" tone="danger"
        actions={<>
          <Button variant="secondary" onClick={() => setConfirm(false)}>Continuar editando</Button>
          <Button variant="danger" onClick={() => { setConfirm(false); setOpen(false) }}>Descartar</Button>
        </>}>
        As mudanças feitas nas configurações ainda não foram salvas.
      </Dialog>
    </>
  )
}
