import { ConnectorError } from '../errors.js'
import type { ExecActionT } from '../spec/types.js'

function fail(path: string, message: string): never {
  throw new ConnectorError('VALIDATION_FAILED', `params${path}: ${message}`)
}

function validateNode(schema: Record<string, unknown>, value: unknown, path: string): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => Object.is(v, value)))
    fail(path, 'not in enum')

  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        fail(path, 'must be an object')
      const obj = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const name of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(obj, name)) fail(`${path}/${name}`, 'is required')
      }
      for (const [name, child] of Object.entries(obj)) {
        const childSchema = properties[name]
        if (childSchema) validateNode(childSchema, child, `${path}/${name}`)
        else if (schema.additionalProperties === false) fail(`${path}/${name}`, 'is not allowed')
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'must be an array')
      if (typeof schema.minItems === 'number' && value.length < schema.minItems)
        fail(path, `must contain at least ${schema.minItems} items`)
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
        fail(path, `must contain at most ${schema.maxItems} items`)
      const items = schema.items as Record<string, unknown>
      for (let i = 0; i < value.length; i += 1) validateNode(items, value[i], `${path}/${i}`)
      return
    }
    case 'string': {
      if (typeof value !== 'string') fail(path, 'must be a string')
      const length = [...value].length
      if (typeof schema.minLength === 'number' && length < schema.minLength)
        fail(path, `must contain at least ${schema.minLength} characters`)
      if (typeof schema.maxLength === 'number' && length > schema.maxLength)
        fail(path, `must contain at most ${schema.maxLength} characters`)
      return
    }
    case 'integer':
      if (!Number.isInteger(value)) fail(path, 'must be an integer')
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be finite number')
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'must be a boolean')
      return
    case 'null':
      if (value !== null) fail(path, 'must be null')
      return
    default:
      fail(path, 'unsupported signed schema')
  }
  const number = value as number
  if (typeof schema.minimum === 'number' && number < schema.minimum)
    fail(path, `must be >= ${schema.minimum}`)
  if (typeof schema.maximum === 'number' && number > schema.maximum)
    fail(path, `must be <= ${schema.maximum}`)
}

/** 对签进 exec contract 的安全 JSON-Schema 子集做唯一运行时入参校验。 */
export function validateDeclarativeParams(
  action: ExecActionT,
  value: unknown,
): Record<string, unknown> {
  const params = value ?? {}
  validateNode(action.params, params, '')
  return params as Record<string, unknown>
}
