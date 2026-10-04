/** Build a precompiled npm tarball accepted by DSH's plugin manager. */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out-dir')) {
  throw new Error('Usage: npm run pack:plugin -- [--out-dir <directory>]')
}
const outDir = resolve(root, args[1] ?? 'outputs')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const npmCli = process.env.npm_execpath
if (npmCli === undefined || !/npm-cli\.js$/i.test(npmCli)) {
  throw new Error('Run packaging with npm run pack:plugin so the npm CLI can be located.')
}

await mkdir(outDir, { recursive: true })
await mkdir(join(root, 'tmp'), { recursive: true })
const stage = await mkdtemp(join(root, 'tmp', 'plugin-package-'))
try {
  for (const entry of manifest.files) {
    await cp(join(root, entry), join(stage, entry), { recursive: true })
  }
  // The installable package already contains JS. Its installation never needs
  // a compiler, development dependencies, or lifecycle build approval.
  const { scripts: _scripts, devDependencies: _devDependencies, ...runtimeManifest } = manifest
  await writeFile(join(stage, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n')
  const packed = await new Promise((resolvePack, reject) => {
    const child = spawn(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', outDir], {
      cwd: stage,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('npm pack exited with code ' + code)); return }
      try { resolvePack(JSON.parse(output)[0]) } catch (error) { reject(error) }
    })
  })
  await cp(join(root, 'INSTALL.md'), join(outDir, 'dsh-openreelbench-INSTALL.md'))
  console.log('DSH plugin: ' + join(outDir, packed.filename))
  console.log('Package: ' + packed.name + '@' + packed.version)
  console.log('Files: ' + packed.entryCount + ', size: ' + packed.size + ' bytes')
} finally {
  // mkdtemp created this exact directory under the project's tmp directory.
  await rm(stage, { recursive: true, force: true })
}
