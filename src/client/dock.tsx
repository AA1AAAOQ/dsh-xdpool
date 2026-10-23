/**
 * The docked entry: a `sidebar.footer.action` button that opens the pool card in
 * a `shell.overlay` panel.
 *
 * Why not link to the Settings page the card already lives on: the host's
 * sidebar slot hands a registrant exactly `{ wide }` — no `openSettings`, no
 * navigation seat. dsh-purge, dshmarket and everything else third-party solve it
 * the same way, by owning the surface: a button that toggles an overlay of its
 * own. Re-implementing the card for the overlay would mean two copies to keep in
 * step, so the overlay renders the very same `PoolCard` the settings section
 * renders, page state and all.
 *
 * The open flag lives at module scope rather than in React state because the
 * button and the panel are two separate slot registrations with no common
 * ancestor; module state plus a subscription is the only channel between them.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { POOL_NAV_ICON_MASK_URL } from './nav-icon.ts'

/** Subscribers re-read {@link dockedOpen}; the setter notifies them. */
const listeners = new Set<() => void>()
let dockedOpen = false

/** Read whether the docked panel is showing. */
export function isDockedOpen(): boolean {
  return dockedOpen
}

/** Show or hide the docked panel, notifying every registrant. */
export function setDockedOpen(open: boolean): void {
  if (dockedOpen === open) return
  dockedOpen = open
  for (const listener of [...listeners]) listener()
}

/** Subscribe to {@link setDockedOpen}. Returns the unsubscribe. */
export function subscribeDockedOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribe a component to the open flag. */
function useDockedOpen(): boolean {
  const [open, setOpen] = useState<boolean>(isDockedOpen)
  useEffect(() => {
    // Re-read on subscribe: the flag can flip between render and effect.
    setOpen(isDockedOpen())
    return subscribeDockedOpen(() => {
      setOpen(isDockedOpen())
    })
  }, [])
  return open
}

/** Props the host hands a `sidebar.footer.action` registrant. */
export interface SidebarActionProps {
  /**
   * True while the sidebar is expanded. The collapsed rail is 56px wide and
   * carries one icon per row, so the label must go — the shell hands the flag
   * rather than leaving each registrant to measure the column.
   */
  wide?: boolean
  [key: string]: unknown
}

/**
 * The sidebar button.
 *
 * Renders a glyph and, only when the rail is wide, the product name: a label in
 * the collapsed 56px rail is clipped mid-word, which reads as a layout bug.
 */
export function SidebarEntry({ wide }: SidebarActionProps): ReactNode {
  const open = useDockedOpen()
  const label = 'XD Pool'
  return (
    <button
      type="button"
      className={`dsm-xdpool-dock${open ? ' dsm-xdpool-dock-on' : ''}`}
      title={open ? '收起 XD Pool' : '打开 XD Pool'}
      aria-expanded={open}
      aria-label={label}
      /* The mask URL is handed down as a custom property because the rule that
         consumes it lives in the shared stylesheet, which cannot reach a module
         constant. Inlined here it travels with the one element that needs it. */
      style={{ '--dsm-xdpool-dock-glyph': `url("${POOL_NAV_ICON_MASK_URL}")` } as Record<string, string>}
      onClick={() => {
        setDockedOpen(!isDockedOpen())
      }}
    >
      <span className="dsm-xdpool-dockicon" aria-hidden="true" />
      {wide === true ? <span className="dsm-xdpool-docklabel">{label}</span> : null}
    </button>
  )
}

/**
 * The panel, rendered into `shell.overlay`.
 *
 * `children` is the card itself, passed in rather than imported so this module
 * stays free of the card's dependency graph (the overlay must not drag the
 * settings scope in with it when the host line has no scope to hand out).
 */
export function DockedPanel({ children }: { children: ReactNode }): ReactNode {
  const open = useDockedOpen()
  useEffect(() => {
    if (!open) return
    // Escape closes: the panel covers the conversation but is not modal in the
    // host's sense, so there is no dialog frame to dismiss it for us.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDockedOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  if (!open) return null
  return (
    <div className="dsm-xdpool-dockscrim" role="presentation" onClick={() => { setDockedOpen(false) }}>
      <div
        className="dsm-xdpool-dockpanel"
        role="dialog"
        aria-modal="false"
        aria-label="XD Pool"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dsm-xdpool-dockhead">
          <span className="dsm-xdpool-docktitle">XD Pool</span>
          <button
            type="button"
            className="dsm-xdpool-dockclose"
            aria-label="关闭"
            onClick={() => { setDockedOpen(false) }}
          >
            ×
          </button>
        </div>
        <div className="dsm-xdpool-dockbody">{children}</div>
      </div>
    </div>
  )
}
