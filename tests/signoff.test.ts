import { describe, expect, mock, test } from 'claude-code/testing'

import { machine, type Runner, SKILL_SCRIPTS, world } from './fake-machine'
import { BRIEF_STDOUT, CONFIG_YAML, INSPECT_JSON } from './fixtures'

const RECORD = 'ds-signoff.json'
const BUILD = 'python build.py ds.config.yaml --approve --out ds-out'
const SIGNED = JSON.stringify({ approvedAt: '2026-10-09T00:00:00.000Z', config: CONFIG_YAML })
const PANE = { title: 'defsys', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

// The reason a plugin refused a call, or undefined when the call went through.
function refusal(answer: unknown): string | undefined {
  return (answer as { deny?: string }).deny
}

describe('the build gate', () => {
  test('a build with --approve is refused before sign-off', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: 0 })
    const answer = await $.tool.call({ tool: 'Bash', command: BUILD })
    expect(refusal(answer)).toMatch(/not signed off/)
  })

  test('the same build runs once the config is signed off', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML, [RECORD]: SIGNED }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: 0 })
    const answer = await $.tool.call({ tool: 'Bash', command: BUILD })
    expect(refusal(answer)).toBeUndefined()
  })

  test('a sign-off lapses when the config changes after it', async ($, on) => {
    machine(
      on,
      { 'ds.config.yaml': CONFIG_YAML.replace('Acme', 'Acme Two'), [RECORD]: SIGNED },
      world(BRIEF_STDOUT, INSPECT_JSON),
    )
    mock.clock(on, { now: 0 })
    const answer = await $.tool.call({ tool: 'PowerShell', command: BUILD })
    expect(refusal(answer)).toMatch(/changed after the last sign-off/)
  })

  test('the model cannot write the sign-off record itself', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: 0 })
    const byWrite = await $.tool.call({ tool: 'Write', file_path: `/project/${RECORD}`, content: '{}' })
    const byShell = await $.tool.call({ tool: 'Bash', command: `echo {} > ${RECORD}` })
    expect(refusal(byWrite)).toMatch(/written only by the Approve button/)
    expect(refusal(byShell)).toMatch(/written only by the Approve button/)
  })
})

describe('the side panel sign-off', () => {
  test('Approve signs the config off, on the terminal and on the desktop', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })

    for (const surface of ['terminal', 'desktop'] as const) {
      disk.delete(RECORD)
      const ui = await $.ui.mount({
        plugin: 'defsystem',
        surface,
        component: 'Pane',
        requestId: 'defsystem',
        props: PANE,
      })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: /Not signed off/ })).toBeDefined()

      await ui.press({ key: 'approve' })

      expect(disk.get(RECORD)).toContain('"approvedAt": "2026-10-09T00:00:00.000Z"')
      expect(await ui.find({ type: 'Text', text: /Signed off/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a brief with a failing contrast pair cannot be approved', async ($, on) => {
    // build.py exits 1 when a pair fails, and still prints the brief with the FAIL line.
    const failing = BRIEF_STDOUT.replace('46 pairs checked, 0 failing.', '46 pairs checked, 1 failing.').replace(
      '## Sign-off',
      '- FAIL text/muted (light): 3.90:1 < 4.5:1\r\n\r\n## Sign-off',
    )
    const runner: Runner = (argv, stdin) =>
      (argv[1] ?? '').endsWith('build.py')
        ? { exitCode: 1, stdout: failing, stderr: '' }
        : world(failing, INSPECT_JSON)(argv, stdin)
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, runner)
    mock.clock(on, { now: 0 })
    const ui = await $.ui.mount({
      plugin: 'defsystem',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'defsystem',
      props: PANE,
    })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'approve' })
    expect(disk.has(RECORD)).toBe(false)
    expect(await ui.find({ type: 'Text', text: /failing contrast pair/ })).toBeDefined()
    await ui.unmount()
  })

  test('Approve is refused, with the reason, while the skill bundled in the mod has no scripts', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    disk.delete(`${SKILL_SCRIPTS}/build.py`)
    mock.clock(on, { now: 0 })
    const ui = await $.ui.mount({
      plugin: 'defsystem',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'defsystem',
      props: PANE,
    })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'approve' })
    expect(disk.has(RECORD)).toBe(false)
    expect(await ui.find({ type: 'Text', text: /scripts are missing from this mod/ })).toBeDefined()
    await ui.unmount()
  })
})
