import { expect, test } from 'vitest'
import { api } from '../api'
import { integrationsApi } from './integrationsApi'
import { memorySkillsApi } from './memorySkillsApi'
import { projectsApi } from './projectsApi'

// FINDINGS §8 C2 (OCV5-475): `api` spreads per-domain objects at their original positions. A key
// present in two parts would be silently overridden by the later one (spread does not error), so
// pin that the parts are disjoint and that every domain entry is exposed on `api` unchanged.
const parts = { projectsApi, memorySkillsApi, integrationsApi }

test('api domain parts are disjoint and exposed on api by reference', () => {
  const seen = new Map<string, string>()
  for (const [part, obj] of Object.entries(parts)) {
    for (const key of Object.keys(obj)) {
      expect(seen.get(key), `${key} in both ${seen.get(key)} and ${part}`).toBeUndefined()
      seen.set(key, part)
      expect(api[key as keyof typeof api], `api.${key}`).toBe(obj[key as keyof typeof obj])
    }
  }
  expect(seen.size).toBe(163)
  // OCV5-614 adds the authenticated model-switch quote/confirm endpoint.
  expect(api.modelSwitchCost).toBeTypeOf('function')
  expect(Object.keys(api)).toHaveLength(255)
})
