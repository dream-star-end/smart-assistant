import { Type } from '@sinclair/typebox'

export const UserErrorSchema = Type.Object({
  code: Type.String(),
  category: Type.Union(([
    'auth', 'permission', 'input', 'size', 'context', 'capacity', 'model', 'connection',
    'execution', 'storage', 'billing', 'cancelled', 'configuration', 'state', 'conflict', 'not_found', 'unknown',
  ] as const).map((value) => Type.Literal(value))),
  retryable: Type.Boolean(),
  userMessageKey: Type.String(),
  message: Type.String(),
  actions: Type.Array(Type.Union(([
    'retry', 'switch_model', 'contact_admin', 'edit_message', 'relogin',
    'refresh', 'topup', 'new_session', 'wait', 'check_settings',
  ] as const).map((value) => Type.Literal(value)))),
})
