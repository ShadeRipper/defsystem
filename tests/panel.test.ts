import { describe, expect, mock, test } from 'claude-code/testing'

import {
  answersFrom,
  buildStages,
  countLeaves,
  EMPTY_VIEW,
  indexVariables,
  linkFrom,
  linkRecord,
  linkTarget,
  parseBrief,
  pickFor,
  pickGroups,
  pickOptions,
  playbackFrom,
  resolvePick,
  indicatorText,
  STAGE_BUTTONS,
  swatchOf,
  treeOf,
  turnNote,
  unlinkRecord,
} from '../hooks/brief'
import type { Answer, PanelView, TokenCollection } from '../types'
import { LARGE_INSPECT } from './fixture-large'
import { machine, SKILL_SCRIPTS, world } from './fake-machine'
import { BRIEF_STDOUT, CONFIG_YAML, INSPECT_JSON, SKILL_MD } from './fixtures'

const PANE = { title: 'defsys', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const LINK = 'ds-design-system.json'
const LINKED = JSON.stringify({ source: 'claude-design', title: 'Acme Brand', url: 'https://claude.ai/artifact/abc123', linkedAt: '2026-10-09T00:00:00.000Z' })

const inspected = JSON.parse(INSPECT_JSON) as { config: Record<string, unknown>; collections: TokenCollection[] }
const large = JSON.parse(LARGE_INSPECT) as { config: Record<string, unknown> }

describe('reading the decision brief', () => {
  test('the structure, decisions, checks and brands come out of the recorded brief', () => {
    const parsed = parseBrief(playbackFrom({ exitCode: 0, stdout: BRIEF_STDOUT, stderr: '' }).brief)
    expect(parsed.collections.map(c => c.name)).toEqual(['Primitives', 'Device', 'Brand', 'Platform'])
    expect(parsed.collections[1]?.modes).toBe('Mobile, Desktop')
    expect(parsed.decisions[0]?.decision).toBe('Contrast target')
    expect(parsed.checks).toBe('46 pairs checked, 0 failing.')
    expect(parsed.failing).toEqual([])
    expect(parsed.brands).toMatch(/### Acme/)
    expect(parsed.brands).not.toMatch(/Accessibility/)
  })

  test('playback exit codes: 0 is ok, 1 keeps the brief as failing, 2 is an error with its last line', () => {
    expect(playbackFrom({ exitCode: 0, stdout: BRIEF_STDOUT, stderr: '' }).playback).toBe('ok')
    const failing = playbackFrom({ exitCode: 1, stdout: BRIEF_STDOUT, stderr: '' })
    expect(failing.playback).toBe('failing')
    expect(failing.brief).toContain('# Decision brief')
    const broken = playbackFrom({ exitCode: 2, stdout: '', stderr: 'config error: unknown preset\r\n' })
    expect(broken.playback).toBe('error')
    expect(broken.note).toBe('config error: unknown preset')
  })
})

describe('the answers', () => {
  test('every answer lands in the interview stage it belongs to, with its key path', () => {
    const answers = answersFrom(inspected.config)
    const find = (label: string) => answers.find(answer => answer.label === label)
    expect(find('system_type')?.stage).toBe(1)
    expect(find('Brand name')?.stage).toBe(2)
    expect(find('Acme · radius.button')?.stage).toBe(3)
    expect(find('dimensions')?.stage).toBe(4)
    expect(find('Acme · anchors.blue')?.stage).toBe(5)
    expect(find('Acme · radius.button')?.path).toEqual(['brands', '0', 'radius', 'button'])
    expect(find('Brand name')?.path).toEqual(['brands', '0', 'name'])
  })

  test('the change picker offers the settings the config does not have yet, and reads them back', () => {
    const answers = answersFrom(inspected.config)
    const values = pickOptions(answers).map(option => option.value)
    expect(values).toContain('new:color.contrast')
    expect(values).toContain('new:spacing.base')
    const pick = resolvePick(answers, 'new:color.contrast')
    expect(pick?.path).toEqual(['color', 'contrast'])
    expect(pick?.kind).toBe('text')
    expect(resolvePick(answers, 'answer:0')?.label).toBe(answers[0]?.label)
  })

  test('a setting named in the model tools resolves to an answer or to a setting the config lacks', () => {
    const answers = answersFrom(inspected.config)
    expect(pickFor(answers, 'brands.0.radius.button')).toBe(`answer:${answers.findIndex(answer => answer.label === 'Acme · radius.button')}`)
    expect(pickFor(answers, 'color.contrast')).toBe('new:color.contrast')
    expect(pickFor(answers, 'colour.nonsense')).toBeNull()
  })

  test('a config with more than 64 answers has more than a Select can hold, so the Answers tab draws buttons per stage', () => {
    const answers = answersFrom(large.config)
    const options = pickOptions(answers)
    // The engine refuses a Select above 64 options, and this config offers more than that.
    expect(options.length).toBeGreaterThan(64)
    const counts = new Map<number, number>()
    for (const option of options) counts.set(option.stage, (counts.get(option.stage) ?? 0) + 1)
    // Measured with answersFrom on the generic fixture: stages 1 to 6 hold 1, 4, 7, 28, 13 and 26 answers, 79 in all.
    expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 1], [2, 4], [3, 7], [4, 28], [5, 13], [6, 26]])
    // Per stage, the answers and the settings to add, counted as the Answers tab draws them.
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(STAGE_BUTTONS)
    expect(pickGroups(options).every(group => group.options.length <= STAGE_BUTTONS && group.more === 0)).toBe(true)
  })

  test('a stage with more options than it draws shows the first ones and counts the rest', () => {
    const many: Answer[] = Array.from({ length: STAGE_BUTTONS + 5 }, (_, i) => ({
      stage: 4,
      label: `device.k${i}`,
      value: String(i),
      path: ['device', `k${i}`],
    }))
    const groups = pickGroups(pickOptions(many))
    const variation = groups.find(group => group.stage === 4)
    expect(variation?.options.length).toBe(STAGE_BUTTONS)
    expect(variation?.more).toBe(5)
    expect(variation?.name).toBe('Variation')
  })
})

describe('the stepper', () => {
  test('the first open stage is the current one, and later stages are not marked done', () => {
    const partial: Answer[] = [
      { stage: 1, label: 'system_type', value: 'product-marketing', path: ['system_type'] },
      { stage: 2, label: 'Brand name', value: 'Acme', path: ['brands', '0', 'name'] },
    ]
    const stages = buildStages(partial, 'none', '', '', false, false)
    expect(stages.find(stage => stage.state === 'current')?.name).toBe('Levers')
    expect(stages.find(stage => stage.name === 'Playback')?.state).toBe('todo')
  })
})

describe('the token tree', () => {
  test('a collection groups into a tree, and every variable is a leaf', () => {
    const brand = inspected.collections.find(c => c.name === 'Brand')
    const tree = treeOf(brand as TokenCollection)
    expect(countLeaves(tree)).toBe(54)
    expect(tree.children.map(child => child.name)).toContain('color')
  })

  test('an alias resolves to the hex of the primitive it names, so the token shows a real swatch', () => {
    const index = indexVariables(inspected.collections)
    const action = index.get('color/action/primary/default')
    expect(action).toBeDefined()
    expect(swatchOf(action as NonNullable<typeof action>, index)).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('the Claude Design link', () => {
  test('a link file names its design system, and an unlink reads as no link', () => {
    expect(linkFrom(LINKED)).toEqual({
      title: 'Acme Brand',
      url: 'https://claude.ai/artifact/abc123',
      linkedAt: '2026-10-09T00:00:00.000Z',
      source: 'claude-design',
    })
    expect(linkFrom(unlinkRecord('2026-10-09T00:00:00.000Z'))).toBeNull()
    expect(linkFrom(null)).toBeNull()
    expect(linkFrom('not json')).toBeNull()
  })

  test('a name typed without a link is a title with an empty url, and reads back as that link', () => {
    expect(linkTarget('  Acme Brand  ')).toEqual({ title: 'Acme Brand', url: '' })
    const written = linkRecord({ title: 'Acme Brand', url: '' }, '2026-10-09T00:00:00.000Z')
    expect(linkFrom(written)).toEqual({ title: 'Acme Brand', url: '', linkedAt: '2026-10-09T00:00:00.000Z', source: 'claude-design' })
    // A link made from a Figma file says so.
    const fromFigma = linkRecord({ title: 'Acme Design System', url: 'https://www.figma.com/design/AbC123xyz/X' }, '2026-10-10T00:00:00.000Z', 'figma')
    expect(linkFrom(fromFigma)?.source).toBe('figma')
  })

  test('a pasted https link is the url, titled by its last path segment, and a blank text is no link', () => {
    expect(linkTarget('https://claude.ai/artifact/abc123?x=1')).toEqual({
      title: 'abc123',
      url: 'https://claude.ai/artifact/abc123?x=1',
    })
    expect(linkTarget('https://claude.ai/')).toEqual({ title: 'Claude Design design system', url: 'https://claude.ai/' })
    expect(linkTarget('   ')).toBeNull()
  })
})

describe('what the rest of Claude Code reads', () => {
  const base: PanelView = { ...EMPTY_VIEW, hasConfig: true, signoff: 'none', answers: answersFrom(inspected.config) }

  test('the indicator stays off with no design system, and names the design system and its failing pairs when there is one', () => {
    expect(indicatorText(EMPTY_VIEW)).toBeUndefined()
    expect(indicatorText({ ...base, link: { title: 'Acme Brand', url: 'x', linkedAt: '', source: 'claude-design' } })).toBe(
      'Acme Brand · 0/9 stages · not signed off · 0 failing pairs',
    )
    expect(indicatorText({ ...base, failing: ['FAIL text/muted'] })).toMatch(/· 1 failing pair$/)
    expect(indicatorText({ ...base, signoff: 'current' })).toBe('Acme · 0/9 stages · signed off · 0 failing pairs')
  })

  test('the turn note tells the model while the sign-off does not hold, and is silent once it does', () => {
    expect(turnNote(base)).toMatch(/build.py --approve is refused/)
    expect(turnNote({ ...base, signoff: 'current' })).toBeUndefined()
    expect(turnNote(EMPTY_VIEW)).toBeUndefined()
  })
})

describe('the side panel', () => {
  test('the overview draws the defining stage on the terminal and on the desktop', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML, 'ds-out/build-plan.md': '# Build plan' }, world(BRIEF_STDOUT, INSPECT_JSON))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'defsystem', surface, component: 'Pane', requestId: 'defsystem', props: PANE })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: /Defining stage/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 Brand/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /46 pairs checked/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the tabs switch the body: the Figma steps, and the token tree', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML, 'ds-out/build-plan.md': '# Build plan' }, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'desktop', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'tab-figma' })
    expect(await ui.find({ type: 'Text', text: /Into Figma/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Figma steps: ds-out\/build-plan.md/ })).toBeDefined()
    await ui.press({ key: 'tab-tokens' })
    expect(await ui.find({ type: 'Button', text: /Brand · 54 tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /primary/ })).toBeUndefined()
    await ui.press({ key: 'Brand' })
    expect(await ui.find({ type: 'Button', text: /color · 38/ })).toBeDefined()
    await ui.press({ key: 'Brand/color' })
    expect(await ui.find({ type: 'Button', text: /action/ })).toBeDefined()
    await ui.unmount()
  })

  test('the Answers tab previews a change as a diff, and Apply writes it only then', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'tab-answers' })
    expect(await ui.find({ type: 'Button', text: /system_type: product-marketing/ })).toBeDefined()
    await ui.press({ key: 'pick:new:color.contrast' })
    await ui.input({ key: 'value', text: 'AAA' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(disk.get('ds.config.yaml')).toBe(CONFIG_YAML)
    await ui.press({ key: 'apply' })
    expect(disk.get('ds.config.yaml')).toContain('contrast: AAA')
    await ui.unmount()
  })

  test('a failed preview shows the reason and offers no Apply', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const index = answersFrom(inspected.config).findIndex(answer => answer.label === 'Acme · radius.button')
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'tab-answers' })
    await ui.press({ key: `pick:answer:${index}` })
    await ui.input({ key: 'value', text: 'eight' })
    expect(await ui.find({ type: 'Text', text: /Cannot set brands \/ 0 \/ radius \/ button/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Apply change/ })).toBeUndefined()
    expect(disk.get('ds.config.yaml')).toBe(CONFIG_YAML)
    await ui.unmount()
  })

  test('Apply refuses when the config changed after the preview was made', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'tab-answers' })
    await ui.press({ key: 'pick:new:color.contrast' })
    await ui.input({ key: 'value', text: 'AAA' })
    disk.set('ds.config.yaml', `${CONFIG_YAML}# edited elsewhere\n`)
    await ui.press({ key: 'apply' })
    expect(await ui.find({ type: 'Text', text: /changed since this preview/ })).toBeDefined()
    expect(disk.get('ds.config.yaml')).toBe(`${CONFIG_YAML}# edited elsewhere\n`)
    await ui.unmount()
  })

  // Regression: a config with more than 64 answers (the generic fixture has 79 pick options). A Select above 64 options is
  // refused by the engine, which then draws its own pane, so the tabs vanished and the Answers tab looked empty. The tabs must stay drawn.
  test('the Answers tab draws a config with more than 64 answers on the terminal and on the desktop', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, LARGE_INSPECT))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'defsystem', surface, component: 'Pane', requestId: 'defsystem', props: PANE })
      await ui.press({ key: 'refresh' })
      await ui.press({ key: 'tab-answers' })
      expect(await ui.find({ type: 'Text', text: /Your answers/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Brand name: Acme Labs/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Answers/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Figma/ })).toBeDefined()
      await ui.press({ key: 'tab-stages' })
      expect(await ui.find({ type: 'Text', text: /Defining stage/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('with no design system the panel offers to use an existing one or to create one', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'desktop', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Set up a design system/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Create a new design system/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Approve this config/ })).toBeUndefined()
    await ui.press({ key: 'go-new' })
    expect(await ui.find({ type: 'Text', text: /Create a new design system/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start the interview in the chat/ })).toBeDefined()
    await ui.press({ key: 'back-new' })
    await ui.press({ key: 'go-existing' })
    expect(await ui.find({ type: 'Text', text: /Use an existing design system/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Standalone design systems are not visible to this chat/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Refresh list/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a linked design system shows its name, and Unlink writes the unlink record', async ($, on) => {
    const disk = machine(on, { [LINK]: LINKED }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Claude Design · Acme Brand/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start the interview in the chat/ })).toBeDefined()
    await ui.press({ key: 'unlink' })
    expect(disk.get(LINK)).toContain('unlinkedAt')
    expect(await ui.find({ type: 'Text', text: /Set up a design system/ })).toBeDefined()
    await ui.unmount()
  })

  test('mobile draws the overview, and says where the change form is', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'mobile', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Defining stage/ })).toBeDefined()
    await ui.press({ key: 'tab-answers' })
    expect(await ui.find({ type: 'Text', text: /on the terminal or the desktop/ })).toBeDefined()
    await ui.unmount()
  })
})

// The existing-design-system step: the person types a name or pastes a link into the field, and presses nothing else.
describe('the existing design system step', () => {
  const PANE_PROPS = { plugin: 'defsystem', requestId: 'defsystem', component: 'Pane', props: PANE } as const

  test('a name typed in the field is written as a title with an empty url, and the header names it', async ($, on) => {
    const disk = machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    const ui = await $.ui.mount({ ...PANE_PROPS, surface: 'terminal' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'go-existing' })
    await ui.input({ key: 'system-link', text: 'Acme Brand' })
    expect(disk.get(LINK)).toContain('"title": "Acme Brand"')
    expect(disk.get(LINK)).toContain('"url": ""')
    expect(await ui.find({ type: 'Text', text: /Claude Design · Acme Brand/ })).toBeDefined()
    await ui.unmount()
  })

  test('a pasted https link is written as the url, titled by its last segment', async ($, on) => {
    const disk = machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    const ui = await $.ui.mount({ ...PANE_PROPS, surface: 'terminal' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'go-existing' })
    await ui.input({ key: 'system-link', text: 'https://claude.ai/artifact/abc123' })
    expect(disk.get(LINK)).toContain('"url": "https://claude.ai/artifact/abc123"')
    expect(disk.get(LINK)).toContain('"title": "abc123"')
    expect(await ui.find({ type: 'Text', text: /Linked this project to abc123/ })).toBeDefined()
    await ui.unmount()
  })

  test('blank text links nothing, says so, and keeps the step open', async ($, on) => {
    const disk = machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    const ui = await $.ui.mount({ ...PANE_PROPS, surface: 'terminal' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'go-existing' })
    await ui.input({ key: 'system-link', text: '   ' })
    expect(disk.has(LINK)).toBe(false)
    expect(await ui.find({ type: 'Text', text: /Type the name of your design system, or paste its link, first/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Standalone design systems are not visible to this chat/ })).toBeDefined()
    await ui.unmount()
  })

  test('on mobile there is no field, and the card says where to link a design system', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    const ui = await $.ui.mount({ ...PANE_PROPS, surface: 'mobile' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'go-existing' })
    expect(await ui.find({ type: 'Text', text: /Link a design system on the terminal or the desktop/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('a refresh whose helper fails', () => {
  // What the helper answers in place of its JSON: text that is not JSON, and an ok false reply with no config in it.
  const BROKEN: Array<[string, RegExp]> = [
    ['this is not JSON', /printed nothing readable/],
    [JSON.stringify({ ok: false, error: 'helper could not start: JSONDecodeError: Unexpected UTF-8 BOM' }), /Unexpected UTF-8 BOM/],
  ]

  test('keeps the answers, the tokens and the Overview, shows the helper error, and the Overview comes back', async ($, on) => {
    let broken: string | null = null
    const good = world(BRIEF_STDOUT, INSPECT_JSON)
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, (argv, stdin) => {
      const inspecting = (argv[1] ?? '').endsWith('defsys_helper.py') && argv[argv.length - 1] === 'inspect'
      return inspecting && broken !== null ? { exitCode: 0, stdout: broken, stderr: '' } : good(argv, stdin)
    })
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })

    for (const [output, error] of BROKEN) {
      broken = output
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: error })).toBeDefined()
      await ui.press({ key: 'tab-answers' })
      expect(await ui.find({ type: 'Button', text: /system_type: product-marketing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Nothing answered yet/ })).toBeUndefined()
      await ui.press({ key: 'tab-stages' })
      expect(await ui.find({ type: 'Text', text: /Defining stage/ })).toBeDefined()
      await ui.press({ key: 'tab-tokens' })
      expect(await ui.find({ type: 'Text', text: /Tokens · 234 variables in 4 collections/ })).toBeDefined()
      await ui.press({ key: 'tab-stages' })
    }

    // Once the helper answers again, the error is gone from the panel.
    broken = null
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /printed nothing readable|Unexpected UTF-8 BOM/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Defining stage/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the interview button once the design system is complete', () => {
  test('a complete design system shows the review line in place of the Start button', async ($, on) => {
    // The helper's answers with one more top-level setting, so the Constraints stage has an answer as well.
    const complete = JSON.stringify({ ...inspected, config: { ...inspected.config, constraints: { touch_target: 44 } } })
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, complete))
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'desktop', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Button', text: /Start the interview in the chat/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review the brief and approve it/ })).toBeUndefined()

    disk.set('ds-out/decision-brief.md', '# Decision brief\n')
    disk.set('ds-out/build-plan.md', '# Build plan\n')
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Review the brief and approve it in the sign-off card below/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start the interview in the chat/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the /defsys command', () => {
  const origin = { kind: 'plugin' as const, name: 'defsystem' }
  const presentation = { isFullscreen: false, columns: 80 }

  test('help lists the sub-commands, and an unknown one is named and listed too', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const help = await $.command.run({ command: 'defsys', args: 'help', origin, presentation })
    expect(help.text).toMatch(/tokens/)
    expect(help.text).toMatch(/figma/)
    expect(help.text).toMatch(/existing/)
    const unknown = await $.command.run({ command: 'defsys', args: 'fly', origin, presentation })
    expect(unknown.text).toMatch(/Unknown sub-command "fly"/)
  })

  test('no command is registered when the session starts: /defsystem:defsys, the command file, is the one entry', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    // The plugin's session.start starts a clock, so the test gives it one; the engine's own answer to session.start is below.
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const registered: string[] = []
    on('command.register', (_, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([])
  })

  test('the typed name, the file command and the skill name all open the pane at once, placed at any width', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const typed = await $.command.run({ command: 'defsys', args: '', origin, presentation })
    const file = await $.command.run({ command: 'defsystem:defsys', args: '', origin, presentation })
    const canonical = await $.command.run({ command: 'design-system-definer:defsys', args: '', origin, presentation })
    expect(typed.text).toBeUndefined()
    expect(file.text).toBeUndefined()
    expect(canonical.text).toBeUndefined()
  })

  test('a pane the surface does not seat says to widen the terminal to 110 columns', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is 80 columns wide' } }))
    const answer = await $.command.run({ command: 'defsys', args: 'tokens', origin, presentation })
    expect(answer.text).toMatch(/110 columns/)
  })

  test('each tab sub-command opens the pane on its tab, and overview is the same as stages', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const cases: Array<[string, RegExp]> = [
      ['figma', /Into Figma/],
      ['answers', /Your answers/],
      ['tokens', /Tokens · /],
      ['overview', /Defining stage/],
      ['stages', /Defining stage/],
    ]
    for (const [sub, shown] of cases) {
      await $.command.run({ command: 'defsys', args: sub, origin, presentation })
      const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
      expect(await ui.find({ type: 'Text', text: shown })).toBeDefined()
      await ui.unmount()
    }
  })

  test('new and existing open the setup flow on that step', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'defsys', args: 'new', origin, presentation })
    let ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    expect(await ui.find({ type: 'Text', text: /Create a new design system/ })).toBeDefined()
    await ui.unmount()
    await $.command.run({ command: 'defsys', args: 'existing', origin, presentation })
    ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    expect(await ui.find({ type: 'Text', text: /Use an existing design system/ })).toBeDefined()
    await ui.unmount()
  })

  test('refresh, approve, withdraw and unlink each do their action and answer with its text', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML, [LINK]: LINKED }, world(BRIEF_STDOUT, INSPECT_JSON))
    mock.clock(on, { now: Date.UTC(2026, 9, 9) })
    const refreshed = await $.command.run({ command: 'defsys', args: 'refresh', origin, presentation })
    expect(refreshed.text).toMatch(/re-read from the folder/)
    const approved = await $.command.run({ command: 'defsys', args: 'approve', origin, presentation })
    expect(approved.text).toMatch(/Signed off/)
    expect(disk.get('ds-signoff.json')).toContain('"approvedAt": "2026-10-09T00:00:00.000Z"')
    const withdrawn = await $.command.run({ command: 'defsys', args: 'withdraw', origin, presentation })
    expect(withdrawn.text).toMatch(/Sign-off withdrawn/)
    expect(disk.get('ds-signoff.json')).toContain('withdrawnAt')
    const unlinked = await $.command.run({ command: 'defsys', args: 'unlink', origin, presentation })
    expect(unlinked.text).toMatch(/Unlinked this project/)
    expect(disk.get(LINK)).toContain('unlinkedAt')
  })

})

describe('the indicator above the chat, the interview and the bundled skill', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

  test('with a design system the indicator sits above the chat, with an Open button', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    // The band keeps core's own drawing beneath it: { type: 'engine', ref: 0 } draws the original props.
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    // The band shows the folder's state once the pane has read it, so the test reads it first.
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'refresh' })
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /✻ defsys/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Acme · \d\/9 stages · not signed off · 0 failing pairs/ })).toBeDefined()
    expect(await band.find({ type: 'Button', text: /Open/ })).toBeDefined()
    await band.unmount()
  })

  test('with no design system the band draws no defsys indicator', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'refresh' })
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /✻ defsys/ })).toBeUndefined()
    await band.unmount()
  })

  test('the interview section is in the system prompt only while the interview runs', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    // The engine's own section, beneath the plugin, so the defsys sections follow it.
    on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'engine section', scope: 'shared' as const }] }))
    const compose = () =>
      $.prompt.compose({
        model: 'claude-opus-5-5',
        promptModel: 'claude-opus-5-5',
        surfaces: ['terminal'],
        tools: [],
        outputStyle: { name: 'default', isKeepingCodingInstructions: true },
        traits: [],
      })
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect((await compose()).sections.find(section => section.id === 'defsys-interview')).toBeUndefined()

    await ui.press({ key: 'start-interview' })
    const during = (await compose()).sections.find(section => section.id === 'defsys-interview')
    expect(during?.scope).toBe('session')
    expect(during?.text).toContain(SKILL_MD)
    expect(during?.text).toMatch(/scripts\\build\.py/)
    expect(during?.text).toMatch(/never with --approve before/)

    await ui.press({ key: 'stop-interview' })
    expect((await compose()).sections.find(section => section.id === 'defsys-interview')).toBeUndefined()
    await ui.unmount()
  })

  test('the pane says so when the bundled scripts are missing from the mod', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    disk.delete(`${SKILL_SCRIPTS}/build.py`)
    const ui = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /scripts are missing from this mod/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the model tools', () => {
  test('status and brief answer from the folder, and name the sign-off rule', async ($, on) => {
    machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const status = await $.tool.call({ tool: 'mcp__defsystem__status' })
    const body = (status as unknown as { result: string }).result
    expect(body).toMatch(/"hasConfig": true/)
    expect(body).toMatch(/"signoff": "none"/)
    expect(body).toMatch(/Claude cannot sign off/)
    const brief = (await $.tool.call({ tool: 'mcp__defsystem__brief' })) as unknown as { result: string }
    expect(brief.result).toMatch(/# Decision brief \(defsys\)/)
  })

  test('preview reports the contrast check and writes nothing', async ($, on) => {
    const disk = machine(on, { 'ds.config.yaml': CONFIG_YAML }, world(BRIEF_STDOUT, INSPECT_JSON))
    const good = (await $.tool.call({
      tool: 'mcp__defsystem__preview',
      setting: 'color.contrast',
      value: 'AAA',
    })) as unknown as { result: string }
    expect(good.result).toMatch(/"ok": true/)
    expect(good.result).toMatch(/Nothing was written/)
    const bad = (await $.tool.call({
      tool: 'mcp__defsystem__preview',
      setting: 'brands.0.radius.button',
      value: 'eight',
    })) as unknown as { result: string }
    expect(bad.result).toMatch(/"ok": false/)
    expect(disk.get('ds.config.yaml')).toBe(CONFIG_YAML)
  })

  test('the system prompt carries the defsys note once, after the other sections', async ($, on) => {
    machine(on, {}, world(BRIEF_STDOUT, INSPECT_JSON))
    // The engine's own section, beneath the plugin, so the note follows it.
    on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'engine section', scope: 'shared' as const }] }))
    const composed = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: [],
      outputStyle: { name: 'default', isKeepingCodingInstructions: true },
      traits: [],
    })
    const note = composed.sections.find(section => section.id === 'defsystem')
    expect(note?.scope).toBe('session')
    expect(note?.text).toMatch(/mcp__defsystem__status/)
    expect(note?.text).toMatch(/mcp__defsystem__brief/)
    expect(note?.text).toMatch(/mcp__defsystem__preview/)
    // How the person opens the panel, and that Claude cannot open it or sign off.
    expect(note?.text).toMatch(/\/defsystem:defsys \(typing \/defsys finds it\) or the Open button in the indicator above the chat/)
    expect(note?.text).toMatch(/cannot open the panel/)
    expect(note?.text).toMatch(/cannot sign off/)
    expect(note?.text).toMatch(/ds-signoff\.json is written only by the Approve button/)
  })
})
