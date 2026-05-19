// packages/web/public/modules/partialJson.js
//
// Tolerant parser for partial JSON streamed from gateway `tool_use` frames
// (`partialJson` field, accumulated from Anthropic SSE `input_json_delta`).
//
// Purpose: extract enough already-emitted fields to drive partial Edit/Write
// tool-card rendering BEFORE the tool_use block closes. Streaming UX, not a
// general JSON parser — scope is intentionally tiny:
//
//   • Top-level value MUST be a JSON object. Anything else → {}.
//   • String values are extracted including a partial trailing value (the
//     one currently being typed). Escapes are decoded; an unterminated
//     escape at the buffer edge (e.g. `\\` with no following char) is
//     dropped from the partial tail.
//   • Number, bool, null values: extracted only when complete.
//   • Object / array values: extracted only when their brackets balance
//     and a strict JSON.parse on the substring succeeds. Otherwise the
//     field is skipped (we never invent partial nested structure).
//
// Never throws. On any internal failure returns the fields parsed so far,
// or {} if nothing was extractable.
//
// Caller behavior with mid-stream incomplete fields:
//   - For Edit: `file_path` typically lands first; `old_string` then streams
//     character-by-character; `new_string` streams last. Each visible field
//     drives `_renderEdit` (which already accepts any subset).
//   - For Write: `file_path`, then `content` streams. `_renderWrite` accepts.

const WS = /\s/

/**
 * @param {string} s Raw partial-JSON buffer.
 * @returns {Record<string, unknown>} Best-effort object of parsed fields.
 *                                    Empty object on any error.
 */
export function parsePartialJson(s) {
  if (typeof s !== 'string' || s.length === 0) return {}

  // Fast path: complete JSON.
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    /* fall through to partial scan */
  }

  // Slow path: streaming scan.
  let i = 0
  // Skip leading whitespace.
  while (i < s.length && WS.test(s[i])) i++
  if (s[i] !== '{') return {}
  i++ // past `{`

  const out = {}
  while (i < s.length) {
    // Skip whitespace / commas between entries.
    while (i < s.length && (WS.test(s[i]) || s[i] === ',')) i++
    if (i >= s.length) break
    if (s[i] === '}') break

    // Parse key (must be a complete string).
    if (s[i] !== '"') break
    const keyResult = _scanString(s, i)
    if (!keyResult || keyResult.partial) break // incomplete key → stop
    const key = keyResult.value
    i = keyResult.end

    // Expect ':'.
    while (i < s.length && WS.test(s[i])) i++
    if (s[i] !== ':') break
    i++
    while (i < s.length && WS.test(s[i])) i++
    if (i >= s.length) break

    // Parse value.
    const ch = s[i]
    if (ch === '"') {
      const v = _scanString(s, i)
      if (!v) break
      out[key] = v.value
      i = v.end
      if (v.partial) break // partial string ends the stream
    } else if (ch === '{' || ch === '[') {
      // Skip the field if the structure isn't balanced; otherwise JSON.parse it.
      const end = _scanBalanced(s, i)
      if (end === -1) break // unbalanced → stop scan; tail belongs to this field
      try {
        out[key] = JSON.parse(s.slice(i, end))
      } catch {
        /* skip field */
      }
      i = end
    } else {
      // number / true / false / null — extract only when terminated by
      // `,` / `}` / whitespace. Mid-token at buffer edge → drop.
      const start = i
      while (i < s.length && s[i] !== ',' && s[i] !== '}' && !WS.test(s[i])) i++
      if (i >= s.length) break // unterminated primitive
      const token = s.slice(start, i)
      if (token === 'true') out[key] = true
      else if (token === 'false') out[key] = false
      else if (token === 'null') out[key] = null
      else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
        const n = Number(token)
        if (Number.isFinite(n)) out[key] = n
      }
      // else: unrecognized → skip field
    }
  }
  return out
}

/**
 * Scan a JSON string starting at `s[i]` (must be `"`).
 * Returns { value, end, partial } or null on hopeless input.
 *   - `value`: decoded string (escapes resolved)
 *   - `end`: index after the closing `"` (or s.length if partial)
 *   - `partial`: true if the string was not closed inside `s`
 *
 * Tolerates a truncated escape sequence at the tail by dropping the trailing
 * `\` (or `\u00` fragment) from the partial value rather than throwing.
 */
function _scanString(s, i) {
  if (s[i] !== '"') return null
  let j = i + 1
  let out = ''
  while (j < s.length) {
    const c = s[j]
    if (c === '"') {
      return { value: out, end: j + 1, partial: false }
    }
    if (c === '\\') {
      // Escape sequence. Need at least one more char.
      if (j + 1 >= s.length) {
        // Trailing `\` with nothing after — drop it from partial value.
        return { value: out, end: s.length, partial: true }
      }
      const esc = s[j + 1]
      if (esc === '"') {
        out += '"'
        j += 2
      } else if (esc === '\\') {
        out += '\\'
        j += 2
      } else if (esc === '/') {
        out += '/'
        j += 2
      } else if (esc === 'b') {
        out += '\b'
        j += 2
      } else if (esc === 'f') {
        out += '\f'
        j += 2
      } else if (esc === 'n') {
        out += '\n'
        j += 2
      } else if (esc === 'r') {
        out += '\r'
        j += 2
      } else if (esc === 't') {
        out += '\t'
        j += 2
      } else if (esc === 'u') {
        // \uXXXX — need 4 hex digits.
        if (j + 6 > s.length) {
          // Truncated \u escape; drop it from partial value.
          return { value: out, end: s.length, partial: true }
        }
        const hex = s.slice(j + 2, j + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed; bail (caller treats as parse-failure of the field).
          return { value: out, end: s.length, partial: true }
        }
        out += String.fromCharCode(parseInt(hex, 16))
        j += 6
      } else {
        // Unknown escape — keep both chars literally; lets odd input survive
        // rather than freezing the stream UI.
        out += c + esc
        j += 2
      }
    } else {
      out += c
      j++
    }
  }
  return { value: out, end: s.length, partial: true }
}

/**
 * Scan a balanced {…} or […] substring starting at `s[i]`.
 * Returns index AFTER the matching closer, or -1 if not balanced within `s`.
 * Skips over JSON strings so braces inside strings don't count.
 */
function _scanBalanced(s, i) {
  const open = s[i]
  const close = open === '{' ? '}' : open === '[' ? ']' : null
  if (!close) return -1
  let depth = 0
  let j = i
  while (j < s.length) {
    const c = s[j]
    if (c === '"') {
      const sr = _scanString(s, j)
      if (!sr) return -1
      if (sr.partial) return -1 // partial string inside → bail
      j = sr.end
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return -1
}
