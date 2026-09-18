/**
 * Local storage keys used before the BranchPulse -> GitManager rename.
 *
 * `readStorage(key, legacyKey)` reads the current key and, when it is absent,
 * falls back to the legacy one so an existing browser keeps its language and
 * animation settings. The value is copied under the new key, which makes the
 * fallback a one-time migration instead of a permanent second read path.
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
