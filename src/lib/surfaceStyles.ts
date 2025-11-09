export const SURFACE_STYLES = [
  'glass',
  'midnight',
  'slate',
  'charcoal',
  'linen',
  'frost',
  'grove',
  'lagoon',
  'ember',
  // New themes
  'deep-indigo',
  'warm-amber',
  'fresh-teal',
  'sunset-orange',
  'cool-blue',
  'soft-magenta',
  // Note: corrected spelling from earlier draft 'muted-lavendar'
  'muted-lavender',
  'neutral-grey-blue',
] as const

export type SurfaceStyle = (typeof SURFACE_STYLES)[number]

export const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'glass'

export const sanitizeSurfaceStyle = (value: unknown): SurfaceStyle | null => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim() as SurfaceStyle
  return (SURFACE_STYLES as readonly string[]).includes(normalized) ? normalized : null
}

export const ensureSurfaceStyle = (
  value: unknown,
  fallback: SurfaceStyle = DEFAULT_SURFACE_STYLE,
): SurfaceStyle => sanitizeSurfaceStyle(value) ?? fallback
