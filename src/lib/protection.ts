export type ProtectionPatternType = 'exact' | 'glob' | 'regex'

export function globPatternToRegex(pattern: string): RegExp {
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 2
        continue
      }
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    index += 1
  }
  return new RegExp(`^${out}$`)
}

export function matchPattern(pattern: string, type: ProtectionPatternType, name: string): boolean {
  if (type === 'regex') {
    try {
      return new RegExp(pattern).test(name)
    } catch {
      return false
    }
  }
  if (type === 'exact') return pattern === name
  try {
    return globPatternToRegex(pattern).test(name)
  } catch {
    return false
  }
}
