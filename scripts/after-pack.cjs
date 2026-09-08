const path = require('node:path')
const { execFileSync } = require('node:child_process')
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
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  const rceditPath = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  execFileSync(rceditPath, [exePath, '--set-icon', iconPath], { stdio: 'ignore' })
  console.log(`[branchpulse] set exe icon: ${exePath}`)
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
