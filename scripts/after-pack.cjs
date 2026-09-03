const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

async function flipFusesForExe(exePath) {
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  })
}

exports.default = async function afterPack(context) {
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  await flipFusesForExe(exePath)
  console.log(`[branchpulse] flipped Electron fuses: ${exePath}`)
}

exports.flipFusesForExe = flipFusesForExe

if (require.main === module) {
  const target = process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'BranchPulse.exe')
  flipFusesForExe(path.resolve(target))
    .then(() => console.log(`[branchpulse] flipped Electron fuses: ${path.resolve(target)}`))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
