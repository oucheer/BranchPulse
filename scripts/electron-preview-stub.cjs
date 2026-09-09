// Email preview-only stand-in for APIs imported at module load time.
module.exports = {
  app: { getPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}
