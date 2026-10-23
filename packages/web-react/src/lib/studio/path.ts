// OCV5-593 /studio routes. The studio is its own full-page surface (like /desktop/enroll), so the
// chat workspace router never mirrors over these paths.

export const STUDIO_PAGES = [
  'brief',
  'image',
  'board',
  'review',
  'voice',
  'music',
  'final',
] as const
export type StudioPage = (typeof STUDIO_PAGES)[number]

export type StudioRoute = { kind: 'home' } | { kind: 'project'; id: string; page: StudioPage }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isStudioPath(pathname: string): boolean {
  return pathname === '/studio' || pathname.startsWith('/studio/')
}

/** null → not a studio URL, or an unknown one (the app shows its own not-found state). */
export function parseStudioPath(pathname: string): StudioRoute | null {
  if (!isStudioPath(pathname)) return null
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 1) return { kind: 'home' }
  if (parts[1] !== 'p' || !parts[2] || !UUID.test(parts[2]) || parts.length > 4) return null
  const page = (parts[3] ?? 'board') as StudioPage
  if (!STUDIO_PAGES.includes(page)) return null
  return { kind: 'project', id: parts[2], page }
}

export function studioHref(route: StudioRoute): string {
  if (route.kind === 'home') return '/studio'
  return route.page === 'board' ? `/studio/p/${route.id}` : `/studio/p/${route.id}/${route.page}`
}
