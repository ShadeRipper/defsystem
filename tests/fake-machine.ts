import type { On } from 'claude-code'

import { CANDIDATE_AAA_JSON, CANDIDATE_BAD_JSON, SKILL_MD } from './fixtures'

// The world under the mod for the tests: an in-memory project folder and the mod's own folder, the environment, and the
// process runner. No real file or process is touched. The project folder is /project. The mod's own files live under
// PLUGIN_ROOT, and the skill is bundled there at resources/defsys, so no cache path is involved.

export const PLUGIN_ROOT = '/plugin'
export const SKILL_DIR = `${PLUGIN_ROOT}/resources/defsys`
export const SKILL_SCRIPTS = `${SKILL_DIR}/scripts`

export type Run = { exitCode: number; stdout: string; stderr: string }
export type Runner = (argv: readonly string[], stdin: string) => Run

// The world a process sees: build.py prints the brief; the helper answers inspect with the recorded inspect output,
// and candidate with the recorded output for the change that was asked for.
export function world(brief: string, inspect: string): Runner {
  const candidates: Record<string, string> = {
    'color.contrast=AAA': CANDIDATE_AAA_JSON,
    'brands.0.radius.button=eight': CANDIDATE_BAD_JSON,
  }
  return (argv, stdin) => {
    if ((argv[1] ?? '').endsWith('build.py')) return { exitCode: 0, stdout: brief, stderr: '' }
    if ((argv[1] ?? '').endsWith('defsys_helper.py')) {
      const action = argv[argv.length - 1]
      if (action === 'inspect') return { exitCode: 0, stdout: inspect, stderr: '' }
      if (action === 'candidate') {
        const payload = JSON.parse(stdin) as { path: string[]; text: string }
        const key = `${payload.path.join('.')}=${payload.text}`
        return { exitCode: 0, stdout: candidates[key] ?? JSON.stringify({ ok: false, error: `no fixture for ${key}`, yaml: '', diff: '', failing: [] }), stderr: '' }
      }
    }
    return { exitCode: 127, stdout: '', stderr: `not expected: ${argv.join(' ')}` }
  }
}

// Returns the in-memory project folder, so a test can read what the mod wrote. The bundled skill is part of the disk:
// its build.py stub and its SKILL.md are there unless a test removes them.
export function machine(on: On, files: Record<string, string>, runner: Runner): Map<string, string> {
  const disk = new Map<string, string>([
    [`${SKILL_SCRIPTS}/build.py`, '# skill stub'],
    [`${SKILL_DIR}/SKILL.md`, SKILL_MD],
    ...Object.entries(files),
  ])

  // The engine may give a project file's path as the real working folder or as /project. Either way it is the
  // file's name, or ds-out/<name>. A path inside the mod is kept whole under PLUGIN_ROOT.
  const key = (path: string) => {
    const p = path.replace(/\\/g, '/')
    const bundled = p.indexOf('resources/defsys/')
    if (bundled >= 0) return `${PLUGIN_ROOT}/${p.slice(bundled)}`
    const helper = p.indexOf('helpers/defsys_helper.py')
    if (helper >= 0) return `${PLUGIN_ROOT}/${p.slice(helper)}`
    const at = p.indexOf('ds-out/')
    return at >= 0 ? p.slice(at) : (p.split('/').pop() ?? p)
  }
  const isDir = (dir: string) => [...disk.keys()].some(name => name.startsWith(`${dir}/`))

  on('session.cwd', () => ({ value: '/project' }))
  on('fs.exists', (_, e) => ({ value: disk.has(key(e.path)) || isDir(key(e.path)) }))
  on('fs.read', (_, e) => {
    const text = disk.get(key(e.path))
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    disk.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = key(e.path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const name of disk.keys()) {
      if (!name.startsWith(`${dir}/`)) continue
      const rest = name.slice(dir.length + 1).split('/')
      names.set(rest[0] ?? '', rest.length > 1 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => ({
    value: { ...runner(e.argv, e.init?.stdin ?? ''), isStdoutTruncated: false, isStderrTruncated: false, stream: 'stdout' as const },
  }))
  // The engine's own tool answer, beneath the plugin. A call that gets here ran.
  on('tool.call', () => ({ ref: 0, result: {}, text: 'ran' }))

  return disk
}
