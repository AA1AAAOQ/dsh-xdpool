/**
 * The glyph for this plugin's row in the sidebar panel list.
 *
 * The host owns the row: a `sidebar.panellist` registrant supplies only the mark
 * that goes in the glyph slot, while the shell draws the button, the label, the
 * active state, the tooltip and the collapse animation. That is deliberate — a row
 * painted by the plugin would drift from the first-party rows (Plugins, Plugin
 * market, Automation tasks) the moment the host changes its metrics, and it is why
 * this entry belongs in that list rather than floating an overlay over the
 * conversation.
 *
 * Props are the ones the shell passes: `size` (16 expanded, 18 in the 56px rail)
 * and `active`, so the mark can take the same weight as its neighbours.
 *
 * @module dsh-xdpool/client/panel-icon
 */

import type { ReactNode } from 'react'
import { POOL_NAV_ICON_PATHS } from './nav-icon.ts'

/** Props the `sidebar.panellist` slot hands a registrant. */
export interface PanelIconProps {
  /** Glyph edge in px: 16 while the sidebar is wide, 18 in the collapsed rail. */
  size?: number
  /** True while this panel is the one on screen. */
  active?: boolean
  [key: string]: unknown
}

/**
 * Render the pool's mark.
 *
 * Inlined rather than masked from a data URI because the shell gives the glyph an
 * 18px box in the collapsed rail: a `mask-size: 16px` silhouette would read as
 * smaller than the first-party icons beside it, and scaling the mask would blur
 * its 1.7px arc. Both placements share {@link POOL_NAV_ICON_PATHS}, so the artwork
 * cannot drift between the settings nav row and this one.
 */
export function PanelIcon({ size }: PanelIconProps): ReactNode {
  const edge = typeof size === 'number' && size > 0 ? size : 16
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={edge}
      height={edge}
      aria-hidden="true"
      focusable="false"
    >
      {/* No palette of its own: currentColor lets the shell's row colour —
          including its active and hover states — drive the mark. */}
      {POOL_NAV_ICON_PATHS.map((shape, index) => (
        <path key={index} {...shape} />
      ))}
    </svg>
  )
}
