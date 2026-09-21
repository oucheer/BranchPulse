/**
 * Reads a current localStorage key, falling back to the pre-rename key once.
 * Copying the value forward keeps the fallback from becoming a permanent
 * second read path.
 */
export function readStorage(key: string, legacyKey: string): string | null {
  try {
    const current = window.localStorage.getItem(key)
    if (current !== null) return current
    const legacy = window.localStorage.getItem(legacyKey)
    if (legacy === null) return null
    window.localStorage.setItem(key, legacy)
    return legacy
  } catch {
    return null
  }
}
