import { Surface, type SurfaceProps } from './Surface'

export interface PanelProps extends SurfaceProps {
  /** @deprecated No effect since Round 7: nothing is a 95 %-opaque box any more; text over a photo gets a scrim. */
  overPhoto?: boolean
}

/**
 * @deprecated Round 7 D2 (no boxes) — use `Surface` (`variant="plain"` for content). Kept under its old name (CLAUDE.md
 * rule #4): it now renders `<Surface variant="plain">` — no fill, border or radius — and `overPhoto` is accepted and ignored.
 * Nothing in the tree calls it any more.
 */
export function Panel({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted and ignored, see PanelProps
  overPhoto,
  ...rest
}: PanelProps) {
  return <Surface variant="plain" {...rest} />
}
