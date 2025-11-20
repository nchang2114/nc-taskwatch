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
  // Life routine: additional green variants (#6EBF77/bg-green-400 family)
  'leaf',
  'sprout',
  'fern',
  'sage',
  'meadow',
  'willow',
  'pine',
  'basil',
  'mint',
  // Life routine: additional warm/coral variants (#FF8C69 family)
  'coral',
  'peach',
  'apricot',
  'salmon',
  'tangerine',
  'papaya',
] as const

export type SurfaceStyle = (typeof SURFACE_STYLES)[number]

export const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'glass'

const SUPABASE_SURFACE_ALLOWLIST: SurfaceStyle[] = [
  'glass',
  'midnight',
  'slate',
  'charcoal',
  'linen',
  'frost',
  'grove',
  'lagoon',
  'ember',
]
const SUPABASE_SURFACE_SET = new Set<SurfaceStyle>(SUPABASE_SURFACE_ALLOWLIST)
const SUPABASE_SURFACE_FALLBACKS: Record<string, SurfaceStyle> = {
  'cool-blue': 'glass',
  'muted-lavender': 'frost',
  'neutral-grey-blue': 'slate',
  'fresh-teal': 'lagoon',
  'sunset-orange': 'ember',
  'soft-magenta': 'grove',
  'deep-indigo': 'midnight',
  'warm-amber': 'ember',
  leaf: 'grove',
  sprout: 'grove',
  fern: 'grove',
  sage: 'grove',
  meadow: 'grove',
  willow: 'grove',
  pine: 'grove',
  basil: 'grove',
  mint: 'grove',
  coral: 'ember',
  peach: 'ember',
  apricot: 'ember',
  salmon: 'ember',
  tangerine: 'ember',
  papaya: 'ember',
}

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

export const clampSurfaceToSupabase = (value: SurfaceStyle | null | undefined): SurfaceStyle | null => {
  if (!value) return null
  if (SUPABASE_SURFACE_SET.has(value)) {
    return value
  }
  return SUPABASE_SURFACE_FALLBACKS[value] ?? DEFAULT_SURFACE_STYLE
}
