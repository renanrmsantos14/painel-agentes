// Menu de ações (⋯ ou botão direito) e confirmação de remoção de worktrees.
import { invoke } from '@tauri-apps/api/core'
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Pending, plural } from './model'

export type Item = { label: string; icon: ReactNode; act: () => void; danger?: boolean; hint?: string; group?: string }
export type MenuReq = { items: Item[]; x: number; y: number; keyboard: boolean; ret: HTMLElement | null }

export function Menu({ req, onClose }: { req: MenuReq; onClose: (restore?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { items, x, y, keyboard } = req

  useLayoutEffect(() => {
    const el = ref.current!
    const w = el.offsetWidth, h = el.offsetHeight
    el.style.transform = `translate(${Math.min(x, innerWidth - w - 8)}px, ${y + h > innerHeight - 8 ? Math.max(8, y - h) : y}px)`
    if (keyboard) el.querySelector<HTMLElement>('button')?.focus()
  }, [req])

  useEffect(() => {
    const down = (ev: PointerEvent) => { if (!ref.current?.contains(ev.target as Node)) onClose() }
    const blur = () => onClose()
    document.addEventListener('pointerdown', down)
    window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('blur', blur) }
  }, [onClose])

  const onKey = (ev: KeyboardEvent) => {
    const bs = [...ref.current!.querySelectorAll<HTMLElement>('button')]
    const i = bs.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      bs[(i + (ev.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus()
    } else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); onClose(true) }
  }

  return (
    <div ref={ref} className="ctx show" role="menu" aria-label="Ações" onKeyDown={onKey}>
      {items.map((it, i) => (
        <Fragment key={i}>
          {/* Rótulo de seção só aparece quando o grupo muda (ex.: outros chats, depois as ações). */}
          {it.group && it.group !== items[i - 1]?.group && items.some((o) => o.group && o.group !== it.group) ? <div className="ctx-label">{it.group}</div> : null}
          {it.danger && i ? <hr /> : null}
          <button role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.act() }}>
            {it.icon}<span>{it.label}</span>{it.hint ? <kbd>{it.hint}</kbd> : null}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

type RemoveProps = { ok: Pending[]; skipped: number; inApp: boolean; onClose: () => void; onFinish: (done: number, fails: number) => void; toast: (m: string, e?: boolean) => void }

export function RemoveModal({ ok, skipped, inApp, onClose, onFinish, toast }: RemoveProps) {
  const [result, setResult] = useState<Record<string, string | true>>({})
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(-1)
  const [title, setTitle] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const ret = useRef(document.activeElement as HTMLElement | null)

  const close = () => { if (running) return; onClose(); ret.current?.focus?.() }
  useEffect(() => { cancelRef.current?.focus() }, [])
  useEffect(() => {
    const key = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') close() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  async function removeAll() {
    if (!inApp) { toast('Esta é só a pré-visualização no navegador; as ações funcionam no app', true); return }
    setRunning(true)
    setFinished(0)
    let fails = 0
    // Algumas em paralelo: cada remoção é quase toda espera por processos do Git.
    let next = 0
    const worker = async () => {
      while (next < ok.length) {
        const p = ok[next++]
        try {
          await invoke('remove_worktree', { path: p.path })
          setResult((x) => ({ ...x, [p.path]: true }))
        } catch (e) {
          fails++
          setResult((x) => ({ ...x, [p.path]: String(e) }))
        }
        setFinished((n) => n + 1)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, ok.length) }, worker))
    setRunning(false)
    const done = ok.length - fails
    onFinish(done, fails)
    if (!fails) { onClose(); toast(plural(done, 'worktree removida', 'worktrees removidas')); return }
    setTitle(`${done ? `${plural(done, 'removida', 'removidas')}, ` : ''}${plural(fails, 'não pôde', 'não puderam')} ser ${fails === 1 ? 'removida' : 'removidas'}`)
    cancelRef.current?.focus()
  }

  const ended = Boolean(title)
  return (
    <div className="overlay" onClick={(ev) => { if (ev.target === ev.currentTarget) close() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <h2 id="m-title">{title || (ok.length ? `Remover ${plural(ok.length, 'worktree mesclada', 'worktrees mescladas')}?` : 'Nada para remover agora')}</h2>
        <p>Só apaga pastas de worktree limpas e já mescladas na base. As branches e os commits continuam no repositório, e o Git recusa qualquer pasta com algo não salvo.{skipped ? ` ${plural(skipped, 'worktree em uso por um chat ativo ficou', 'worktrees em uso por chats ativos ficaram')} de fora.` : ''}</p>
        <ul className="m-list">
          {ok.map((p) => {
            const r = result[p.path]
            return (
              <li key={p.path} className={r === true ? 'done' : r ? 'fail' : undefined}>
                <b>{p.project}</b> <span className="m-br">{p.branch}</span><small>{p.path}</small>
                {typeof r === 'string' ? <em>{r}</em> : null}
              </li>
            )
          })}
        </ul>
        <div className="m-actions">
          <button ref={cancelRef} className="link-btn" disabled={running} onClick={close}>{ok.length && !ended ? 'Cancelar' : 'Fechar'}</button>
          {ok.length && !ended ? (
            <button className="danger-btn" disabled={running} onClick={() => void removeAll()}>
              {finished < 0 ? `Remover ${ok.length}` : `Removendo ${finished} de ${ok.length}…`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
