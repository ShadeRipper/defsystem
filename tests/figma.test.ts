import { describe, expect, mock, test } from 'claude-code/testing'

import { figmaFileFrom, figmaKeyOf, figmaRecord, findFigmaUrl, hasFigmaTools, improveStep, inventoryFrom } from '../hooks/brief'
import { machine, world } from './fake-machine'
import { BRIEF_STDOUT, INSPECT_JSON } from './fixtures'

// "Improve a Figma design system file": the link and the read file in two files, the Figma connection from the tool list,
// the updater above the chat, and the option in the panel.

const PANE = { title: 'defsys', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

const FIGMA_URL = 'https://www.figma.com/design/AbC123xyz/Acme-Design-System?node-id=0-1'
const INVENTORY = JSON.stringify({
  url: 'https://www.figma.com/design/AbC123xyz/Acme-Design-System',
  readAt: '2026-10-10T10:00:00.000Z',
  fileName: 'Acme Design System',
  summary: { pages: 4, collections: 3, variables: 120, styles: 14, components: 40, fonts: ['Inter', 'Poppins'], colours: ['#12362b x40', '#ffffff x90'] },
  notes: 'Has variables, no text styles.',
})
const WITH_FIGMA = [
  { name: 'Bash', description: 'shell', mcp: false },
  { name: 'mcp__figma__use_figma', description: 'run the Plugin API', mcp: true },
  { name: 'mcp__figma__get_metadata', description: 'metadata', mcp: true },
]
const WITHOUT_FIGMA = [
  { name: 'Bash', description: 'shell', mcp: false },
  { name: 'mcp__other__search', description: 'search', mcp: true },
]

type On = Parameters<typeof machine>[0]

// A folder with no design system, the engine's own band beneath ours, and the tools the chat has.
function setup(on: On, tools: typeof WITH_FIGMA, files: Record<string, string> = {}) {
  const disk = machine(on, files, world(BRIEF_STDOUT, INSPECT_JSON))
  mock.clock(on, { now: Date.UTC(2026, 9, 10) })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('tool.list', () => ({ value: tools }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return { disk, sent }
}

describe('reading a Figma file', () => {
  test('a Figma link is found in text, and its key and name are read from it', () => {
    expect(findFigmaUrl(`please read ${FIGMA_URL} now`)).toBe(FIGMA_URL)
    expect(findFigmaUrl('https://www.figma.com/files/team/123/recents')).toBeNull()
    expect(findFigmaUrl('no link here')).toBeNull()
    expect(figmaKeyOf(FIGMA_URL)).toBe('AbC123xyz')
    const file = figmaFileFrom(figmaRecord(FIGMA_URL, '2026-10-10T09:00:00.000Z'))
    expect(file?.fileKey).toBe('AbC123xyz')
    expect(file?.title).toBe('Acme Design System')
    expect(figmaFileFrom('{"disconnectedAt":"2026-10-10"}')).toBeNull()
    expect(figmaFileFrom('not json')).toBeNull()
  })

  test('what Claude wrote counts only when it is for this file, has a readAt, and has the right types', () => {
    const file = figmaFileFrom(figmaRecord(FIGMA_URL, ''))
    const read = inventoryFrom(INVENTORY, file)
    expect(read?.fileName).toBe('Acme Design System')
    expect(read?.counts).toEqual([
      { label: 'pages', value: 4 },
      { label: 'collections', value: 3 },
      { label: 'variables', value: 120 },
      { label: 'styles', value: 14 },
      { label: 'components', value: 40 },
    ])
    expect(read?.fonts).toEqual(['Inter', 'Poppins'])
    // No readAt: the read is not finished. Another file's key: it is an older file's inventory. Wrong types are left out.
    expect(inventoryFrom(JSON.stringify({ url: FIGMA_URL, summary: {} }), file)).toBeNull()
    expect(inventoryFrom(JSON.stringify({ url: 'https://www.figma.com/design/OTHER99/X', readAt: 'now' }), file)).toBeNull()
    expect(inventoryFrom(JSON.stringify({ readAt: 'now', summary: { pages: 'four' } }), file)?.counts).toEqual([])
    expect(inventoryFrom(JSON.stringify({ readAt: 'now', summary: { fonts: [1, 'Inter'] } }), file)?.fonts).toEqual(['Inter'])
    expect(inventoryFrom(INVENTORY, null)).toBeNull()
    expect(inventoryFrom('nope', file)).toBeNull()
  })

  test('the step asks for Figma first, then the link, then waits, and a read file is connected whatever else', () => {
    const file = figmaFileFrom(figmaRecord(FIGMA_URL, ''))
    const read = inventoryFrom(INVENTORY, file)
    expect(improveStep(false, false, null, null)).toBe('off')
    expect(improveStep(false, true, file, null)).toBe('off')
    expect(improveStep(true, false, null, null)).toBe('connect')
    expect(improveStep(true, true, null, null)).toBe('link')
    expect(improveStep(true, true, file, null)).toBe('reading')
    expect(improveStep(true, true, file, read)).toBe('connected')
    expect(improveStep(false, false, file, read)).toBe('connected')
  })

  test('Figma is connected when a tool of its connector is among the tools, whatever the server is called', () => {
    expect(hasFigmaTools(WITH_FIGMA.map(tool => tool.name))).toBe(true)
    expect(hasFigmaTools(['mcp__0db1fb3a-37d4__use_figma'])).toBe(true)
    expect(hasFigmaTools(WITHOUT_FIGMA.map(tool => tool.name))).toBe(false)
    expect(hasFigmaTools([])).toBe(false)
  })
})

describe('the Figma option in the panel and above the chat', () => {
  test('the option is in the existing step, and without Figma the band asks to connect it', async ($, on) => {
    setup(on, WITHOUT_FIGMA)
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'go-existing' })
    expect(await pane.find({ type: 'Button', text: /Improve a Figma design system file/ })).toBeDefined()
    await pane.press({ key: 'improve' })
    expect(await pane.find({ type: 'Button', text: /Connect Figma to continue/ })).toBeDefined()
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /Figma is not connected to this chat/ })).toBeDefined()
    expect(await band.find({ type: 'Button', text: /Check again/ })).toBeDefined()
    await band.unmount()
    await pane.unmount()
  })

  // Every step of the updater is drawn on the desktop surface too, where the person works: a tree that did not validate
  // there would be replaced by the engine's own band, and the indicator would go with it.
  test('each step of the updater draws on the terminal and on the desktop', async ($, on) => {
    const { disk } = setup(on, WITH_FIGMA)
    for (const surface of ['terminal', 'desktop'] as const) {
      disk.delete('ds-figma.json')
      disk.delete('ds-figma-inventory.json')
      const pane = await $.ui.mount({ plugin: 'defsystem', surface, component: 'Pane', requestId: 'defsystem', props: PANE })
      // The setup step is kept by the session's state, so the second pass is already on it.
      if (surface === 'terminal') await pane.press({ key: 'go-existing' })
      await pane.press({ key: 'improve' })
      const asking = await $.ui.mount({ plugin: 'defsystem', surface, component: 'AbovePrompt', props: BAND })
      expect(await asking.find({ type: 'Input' })).toBeDefined()
      expect(await asking.find({ type: 'Button', text: /Cancel/ })).toBeDefined()
      await asking.unmount()
      disk.set('ds-figma.json', figmaRecord(FIGMA_URL, '') ?? '')
      await pane.press({ key: 'refresh' })
      const reading = await $.ui.mount({ plugin: 'defsystem', surface, component: 'AbovePrompt', props: BAND })
      expect(await reading.find({ type: 'Button', text: /Ask again/ })).toBeDefined()
      await reading.unmount()
      disk.set('ds-figma-inventory.json', INVENTORY)
      await pane.press({ key: 'refresh' })
      const connected = await $.ui.mount({ plugin: 'defsystem', surface, component: 'AbovePrompt', props: BAND })
      expect(await connected.find({ type: 'Button', text: /Connected/ })).toBeDefined()
      await connected.unmount()
      await pane.press({ key: 'tab-figma' }).catch(() => undefined)
      await pane.unmount()
    }
  })

  test('with Figma connected the band asks for the link, and the link starts the reading', async ($, on) => {
    const { disk, sent } = setup(on, WITH_FIGMA)
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'go-existing' })
    await pane.press({ key: 'improve' })
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /Paste the link of the Figma file/ })).toBeDefined()
    await band.input({ key: 'band-link', text: 'not a figma link' })
    expect(disk.has('ds-figma.json')).toBe(false)
    await band.input({ key: 'band-link', text: FIGMA_URL })
    expect(JSON.parse(disk.get('ds-figma.json') ?? '{}').fileKey).toBe('AbC123xyz')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/Read this Figma file/)
    expect(sent[0]).toContain(FIGMA_URL)
    expect(sent[0]).toMatch(/ds-figma-inventory\.json/)
    expect(sent[0]).toMatch(/inventory\.js/)
    await band.unmount()
    const reading = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await reading.find({ type: 'Text', text: /Claude is reading Acme Design System/ })).toBeDefined()
    expect(await reading.find({ type: 'Button', text: /Ask again/ })).toBeDefined()
    await reading.unmount()
    await pane.unmount()
  })

  test('once Claude has written what it read, the band shows the file and a Connected button that links the project', async ($, on) => {
    const { disk } = setup(on, WITH_FIGMA, { 'ds-figma.json': figmaRecord(FIGMA_URL, '2026-10-10T09:00:00.000Z') ?? '' })
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'go-existing' })
    await pane.press({ key: 'improve' })
    disk.set('ds-figma-inventory.json', INVENTORY)
    await pane.press({ key: 'refresh' })
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /Acme Design System · 4 pages · 3 collections · 120 variables · 14 styles · 40 components/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /Connected · Acme Design System/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Has variables, no text styles/ })).toBeDefined()
    await band.press({ key: 'band-connected' })
    const link = JSON.parse(disk.get('ds-design-system.json') ?? '{}')
    expect(link.source).toBe('figma')
    expect(link.title).toBe('Acme Design System')
    expect(link.url).toBe(FIGMA_URL)
    await band.unmount()
    await pane.unmount()
    // The project now has a design system: the indicator above the chat names the Figma file.
    const after = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await after.find({ type: 'Text', text: /Acme Design System · \d\/9 stages/ })).toBeDefined()
    await after.unmount()
  })

  test('Disconnect forgets the file and what was read from it, and the band goes quiet', async ($, on) => {
    const { disk } = setup(on, WITH_FIGMA, {
      'ds-figma.json': figmaRecord(FIGMA_URL, '2026-10-10T09:00:00.000Z') ?? '',
      'ds-figma-inventory.json': INVENTORY,
    })
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'go-existing' })
    await pane.press({ key: 'improve-stop' })
    expect(JSON.parse(disk.get('ds-figma.json') ?? '{}').disconnectedAt).toBeTruthy()
    expect(JSON.parse(disk.get('ds-figma-inventory.json') ?? '{}').disconnectedAt).toBeTruthy()
    const band = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /Improve a Figma design system file/ })).toBeUndefined()
    await band.unmount()
    await pane.unmount()
  })

  test('a Figma link typed in the chat box answers the question and becomes the request to read the file', async ($, on) => {
    const { disk, sent } = setup(on, WITH_FIGMA)
    const pane = await $.ui.mount({ plugin: 'defsystem', surface: 'terminal', component: 'Pane', requestId: 'defsystem', props: PANE })
    await pane.press({ key: 'go-existing' })
    await pane.press({ key: 'improve' })
    // The person's own Enter at the prompt.
    await $.prompt.submit({ text: `${FIGMA_URL} please`, wait: false, origin: { kind: 'composer' } })
    expect(JSON.parse(disk.get('ds-figma.json') ?? '{}').fileKey).toBe('AbC123xyz')
    expect(sent.at(-1)).toMatch(/Read this Figma file/)
    expect(sent.at(-1)).toMatch(/The person also wrote: please/)
    await pane.unmount()
  })

  test('/defsys improve starts the flow and says where it stands', async ($, on) => {
    setup(on, WITHOUT_FIGMA)
    const origin = { kind: 'plugin' as const, name: 'defsystem' }
    const answer = await $.command.run({ command: 'defsys', args: 'improve', origin, presentation: { isFullscreen: false, columns: 80 } })
    expect(answer.text).toMatch(/Figma is not connected to this chat/)
  })
})
