// Pure helpers for the defsys side panel. They read the decision brief and the config answers, shape the token tree,
// and work out what each part of the defining stage shows. No I/O in this file, so the tests can call it directly.
import type {
  Answer,
  CollectionRow,
  DecisionRow,
  DesignSystemLink,
  EditState,
  FigmaFile,
  FigmaInventory,
  ImproveState,
  ImproveStep,
  PanelView,
  Playback,
  SetupState,
  SignOff,
  StageRow,
  TokenCollection,
  TokenValue,
  TokenVariable,
} from '../types'

// How much of the answers and the brief the model is given in one tool result.
const ANSWER_LIMIT = 120
const BRIEF_LIMIT = 8000

export const STAGE_NAMES = [
  'Context',
  'Brand',
  'Levers',
  'Variation',
  'Anchors',
  'Constraints',
  'Playback',
  'Generate',
  'Into Figma',
]

// Settings a person can add when the config does not have them yet. kind tells the helper how to read the text.
export const NEW_SETTINGS: Array<{ key: string; path: string[]; label: string; kind: string; needsBrand: boolean }> = [
  { key: 'color.contrast', path: ['color', 'contrast'], label: 'Contrast target (AA or AAA)', kind: 'text', needsBrand: false },
  { key: 'spacing.base', path: ['spacing', 'base'], label: 'Spacing base in px', kind: 'number', needsBrand: false },
  { key: 'brands.0.density', path: ['brands', '0', 'density'], label: 'Brand density (default or roomy)', kind: 'text', needsBrand: true },
]

export const EMPTY_SETUP: SetupState = { step: 'choose', systems: [], systemsStatus: 'idle', systemsNote: '', selected: '' }

export const EMPTY_IMPROVE: ImproveState = { active: false, busy: false, step: 'off', hasFigma: false, file: null, inventory: null }

export const EMPTY_VIEW: PanelView = {
  folder: '',
  signoff: 'none',
  approvedAt: null,
  hasConfig: false,
  link: null,
  improve: EMPTY_IMPROVE,
  setup: EMPTY_SETUP,
  stages: STAGE_NAMES.map((name, i): StageRow => ({ no: i + 1, name, state: 'todo', summary: 'not yet' })),
  answers: [],
  collections: [],
  decisions: [],
  brands: '',
  checks: '',
  failing: [],
  playback: 'none',
  playbackNote: '',
  figma: [],
  tab: 'stages',
  tokens: [],
  tokensError: '',
  open: [],
  pick: '',
  edit: null,
  message: '',
  interview: false,
  fingerprint: '',
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Windows prints CRLF; every parser here works on LF.
const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

export function lastLine(text: string): string {
  return normalize(text).split('\n').map(line => line.trim()).filter(Boolean).pop() ?? ''
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// Version folders, newest first: 1.10.0 sorts after 1.9.0.
export const newestFirst = (a: string, b: string): number => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

// ---- the sign-off record (ds-signoff.json) ----

export type SignOffRecord = { approvedAt: string; config: string }

export function parseRecord(text: string | null): SignOffRecord | null {
  if (text === null) return null
  try {
    const data: unknown = JSON.parse(text)
    if (!isRecord(data)) return null
    const approvedAt = data.approvedAt
    const config = data.config
    return typeof approvedAt === 'string' && typeof config === 'string' ? { approvedAt, config } : null
  } catch {
    return null
  }
}

// The sign-off holds only while the config on disk is exactly the config that was approved.
export function signoffFrom(configText: string | null, recordText: string | null): { signoff: SignOff; approvedAt: string | null } {
  if (configText === null) return { signoff: 'no-config', approvedAt: null }
  const record = parseRecord(recordText)
  if (record === null) return { signoff: 'none', approvedAt: null }
  return { signoff: record.config === configText ? 'current' : 'stale', approvedAt: record.approvedAt }
}

// ---- the answers in ds.config.yaml, filed under the interview stages ----

type Leaf = { path: string[]; value: string }

// Scalars and lists of scalars are one line each; nested maps and lists of maps are walked.
function leaves(value: unknown, path: string[] = []): Leaf[] {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value)) {
    if (value.every(item => typeof item !== 'object' || item === null)) {
      const joined = value.map(item => String(item)).join(', ')
      return joined === '' ? [] : [{ path, value: joined }]
    }
    return value.flatMap((item, i) => leaves(item, [...path, String(i)]))
  }
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]))
  return [{ path, value: String(value) }]
}

const TOP_STAGE = new Map<string, number>([
  ['system_type', 1],
  ['preset', 1],
  ['dimensions', 4],
  ['base_mode', 4],
  ['base', 4],
  ['device', 4],
  ['platform', 4],
  ['a11y', 4],
  ['context', 4],
  ['locale', 4],
  ['theme', 4],
  ['custom_dimensions', 4],
  ['density', 4],
])

const BRAND_STAGE = new Map<string, number>([
  ['essence', 2],
  ['never', 2],
  ['extends', 2],
  ['slug', 2],
  ['radius', 3],
  ['density', 3],
  ['border', 3],
  ['easing', 3],
  ['anchors', 5],
  ['fonts', 5],
  ['weights', 5],
  ['primary', 5],
  ['neutral', 5],
])

// The interview stage a key path belongs to. answersFrom files each answer with this rule, and so does a setting the
// config lacks, so it is listed under the stage its answer would land in.
export function stageOf(path: string[]): number {
  if (path[0] === 'brands' && path.length >= 3) return BRAND_STAGE.get(path[2] ?? '') ?? 2
  return TOP_STAGE.get(path[0] ?? '') ?? 6
}

// Every key the config can hold lands in one stage. Anything not listed is a system-level setting (stage 6).
export function answersFrom(config: Record<string, unknown>): Answer[] {
  const out: Answer[] = []
  for (const [key, value] of Object.entries(config)) {
    if (key === 'brands' && Array.isArray(value)) {
      value.forEach((raw, i) => {
        const brand = isRecord(raw) ? raw : {}
        const name = String(brand.name ?? `brand ${i + 1}`)
        const base = ['brands', String(i)]
        out.push({ stage: 2, label: 'Brand name', value: name, path: [...base, 'name'] })
        for (const [field, item] of Object.entries(brand)) {
          if (field === 'name') continue
          const stage = stageOf([...base, field])
          for (const leaf of leaves(item)) {
            out.push({
              stage,
              label: `${name} · ${[field, ...leaf.path].join('.')}`,
              value: leaf.value,
              path: [...base, field, ...leaf.path],
            })
          }
        }
      })
      continue
    }
    const stage = stageOf([key])
    for (const leaf of leaves(value)) {
      out.push({ stage, label: [key, ...leaf.path].join('.'), value: leaf.value, path: [key, ...leaf.path] })
    }
  }
  return out
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((part, i) => part === b[i])

// The Answers tab draws one Button per option, not a Select: the engine refuses a Select above 64 options, and a real
// config has more answers than that. A label is the answer's label and value, clipped; a setting to add says "(add)".
export const PICK_LABEL = 90
// The most Buttons one stage draws. A stage with more shows the first of them and names the rest in a line.
export const STAGE_BUTTONS = 40

export type PickOption = { value: string; label: string; stage: number }

// The options for "change which answer": every answer, then the settings the config does not have yet.
export function pickOptions(answers: Answer[]): PickOption[] {
  const options: PickOption[] = answers.map((answer, i) => ({
    value: `answer:${i}`,
    label: clip(`${answer.label}: ${answer.value}`, PICK_LABEL),
    stage: answer.stage,
  }))
  const hasBrand = answers.some(answer => answer.path[0] === 'brands')
  for (const setting of NEW_SETTINGS) {
    if (setting.needsBrand && !hasBrand) continue
    if (answers.some(answer => sameList(answer.path, setting.path))) continue
    options.push({ value: `new:${setting.key}`, label: `${setting.label} (add)`, stage: stageOf(setting.path) })
  }
  return options
}

export type PickGroup = { stage: number; name: string; options: PickOption[]; more: number }

// The options under their interview stage, in stage order. A stage draws at most STAGE_BUTTONS; more is how many it leaves out.
export function pickGroups(options: PickOption[]): PickGroup[] {
  const stages = [...new Set(options.map(option => option.stage))].sort((a, b) => a - b)
  return stages.map(stage => {
    const own = options.filter(option => option.stage === stage)
    return {
      stage,
      name: STAGE_NAMES[stage - 1] ?? '',
      options: own.slice(0, STAGE_BUTTONS),
      more: Math.max(0, own.length - STAGE_BUTTONS),
    }
  })
}

export type Pick = { path: string[]; kind: string; label: string; current: string }

export function resolvePick(answers: Answer[], pick: string): Pick | null {
  if (pick.startsWith('answer:')) {
    const answer = answers[Number(pick.slice('answer:'.length))]
    return answer ? { path: answer.path, kind: '', label: answer.label, current: answer.value } : null
  }
  if (pick.startsWith('new:')) {
    const setting = NEW_SETTINGS.find(item => `new:${item.key}` === pick)
    return setting ? { path: setting.path, kind: setting.kind, label: setting.label, current: '' } : null
  }
  return null
}

// ---- the decision brief (the playback output of build.py) ----

export type Playbacked = { playback: Playback; brief: string; note: string }

// build.py prints the brief and exits 0; exits 1 when a contrast pair fails (the brief still prints);
// exits 2 for a config error (the message goes to stderr). Anything else is an error with its last line.
export function playbackFrom(run: { exitCode: number; stdout: string; stderr: string }): Playbacked {
  const brief = normalize(run.stdout).replace(/\n\(nothing written:[^\n]*\)\s*$/, '').trim()
  if (run.exitCode === 0 && brief !== '') return { playback: 'ok', brief, note: '' }
  if (run.exitCode === 1 && brief !== '') return { playback: 'failing', brief, note: '' }
  const why = lastLine(run.stderr) || lastLine(run.stdout) || `build.py exited with ${run.exitCode}`
  return { playback: 'error', brief: '', note: why }
}

// The lines under one "## title" heading, up to the next "## " heading.
export function sectionLines(md: string, title: string): string[] {
  const out: string[] = []
  let inside = false
  for (const line of normalize(md).split('\n')) {
    if (line.startsWith('## ')) {
      inside = line.slice(3).trim() === title
      continue
    }
    if (inside) out.push(line)
  }
  return out
}

// The body rows of a markdown table: the header and the --- separator are dropped.
export function tableRows(lines: string[]): string[][] {
  const rows = lines
    .filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
  return rows.slice(1).filter(cells => !cells.every(cell => /^:?-+:?$/.test(cell)))
}

export function parseBrief(md: string): { collections: CollectionRow[]; decisions: DecisionRow[]; checks: string; failing: string[]; brands: string } {
  const collections = tableRows(sectionLines(md, 'Structure'))
    .map(([name = '', modes = '', why = '']) => ({ name, modes, why }))
    .filter(row => row.name !== '')
  const decisions = tableRows(sectionLines(md, 'Decisions'))
    .map(([decision = '', value = '']) => ({ decision, value }))
    .filter(row => row.decision !== '')
  const accessibility = sectionLines(md, 'Accessibility')
  const checks = accessibility.find(line => line.includes('pairs checked'))?.trim() ?? ''
  const failing = accessibility.filter(line => line.startsWith('- FAIL')).map(line => line.slice(2).trim())
  const brands = sectionLines(md, 'Brands').join('\n').trim()
  return { collections, decisions, checks, failing, brands }
}

// ---- the token tree ----

export type TreeNode = { name: string; key: string; leaf: TokenVariable | null; children: TreeNode[] }

const compareNames = (a: string, b: string): number => {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b)
}

// Groups a collection's variables by their slash path: color/action/primary/default sits under color > action > primary.
export function treeOf(collection: TokenCollection): TreeNode {
  const root: TreeNode = { name: collection.name, key: collection.name, leaf: null, children: [] }
  for (const variable of collection.variables) {
    const parts = variable.path.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, i) => {
      let child = node.children.find(item => item.name === part)
      if (!child) {
        child = { name: part, key: `${node.key}/${part}`, leaf: null, children: [] }
        node.children.push(child)
      }
      if (i === parts.length - 1) child.leaf = variable
      node = child
    })
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => compareNames(a.name, b.name))
    node.children.forEach(sort)
  }
  sort(root)
  return root
}

export function countLeaves(node: TreeNode): number {
  return (node.leaf ? 1 : 0) + node.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

// Every variable in every collection, by its path. Aliases are followed through this index.
export function indexVariables(collections: TokenCollection[]): Map<string, TokenVariable> {
  const index = new Map<string, TokenVariable>()
  for (const collection of collections) {
    for (const variable of collection.variables) {
      if (!index.has(variable.path)) index.set(variable.path, variable)
    }
  }
  return index
}

// The literal behind a value: an alias is followed to the variable it names (a few hops at most).
export function resolveValue(value: TokenValue, index: Map<string, TokenVariable>, depth = 0): TokenValue {
  if (value === null || typeof value !== 'object') return value
  if (depth > 5) return null
  const target = index.get(value.alias)
  const first = target ? Object.values(target.values)[0] : undefined
  return first === undefined ? null : resolveValue(first, index, depth + 1)
}

const HEX = /^#[0-9a-f]{3,8}$/i

// The colour a variable shows as a swatch, or null when it is not a colour.
export function swatchOf(variable: TokenVariable, index: Map<string, TokenVariable>): string | null {
  for (const value of Object.values(variable.values)) {
    const literal = resolveValue(value, index)
    if (typeof literal === 'string' && HEX.test(literal)) return literal
  }
  return null
}

function formatValue(value: TokenValue): string {
  if (value === null) return '—'
  if (typeof value === 'object') return `→ ${value.alias}`
  return String(value)
}

// One line per variable: the value for each mode, or the single value when there is one mode.
export function variableText(variable: TokenVariable): string {
  const entries = Object.entries(variable.values)
  const [only] = entries
  if (entries.length === 1 && only) return formatValue(only[1])
  return entries.map(([mode, value]) => `${mode} ${formatValue(value)}`).join(' · ')
}

// A unified diff without the --- / +++ file headers, which the Code element does not need.
export function hunksOnly(diff: string): string {
  const lines = normalize(diff).split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))
  return first < 0 ? diff : lines.slice(first).join('\n')
}

// ---- what the stepper shows ----

export function buildStages(
  answers: Answer[],
  playback: Playback,
  note: string,
  checks: string,
  hasBrief: boolean,
  hasPlan: boolean,
): StageRow[] {
  const done: boolean[] = []
  const summary: string[] = []

  for (let no = 1; no <= 6; no++) {
    const group = answers.filter(answer => answer.stage === no)
    done.push(group.length > 0)
    summary.push(group.length > 0 ? clip(group.slice(0, 3).map(answer => answer.value).join(' · ')) : 'not answered yet')
  }

  const hasBriefNow = playback === 'ok' || playback === 'failing'
  done.push(hasBriefNow)
  summary.push(hasBriefNow ? checks || 'brief ready' : playback === 'error' ? clip(note) : 'answer the stages above first')

  done.push(hasBrief)
  summary.push(hasBrief ? 'files written to ds-out' : 'after sign-off, Generate writes ds-out')

  done.push(hasPlan)
  summary.push(hasPlan ? 'build plan ready in ds-out' : 'after Generate, the Figma steps appear here')

  const firstOpen = done.indexOf(false)
  return STAGE_NAMES.map((name, i): StageRow => ({
    no: i + 1,
    name,
    state: done[i] ? 'done' : i === firstOpen ? 'current' : 'todo',
    summary: summary[i] ?? '',
  }))
}

export function figmaLines(collections: CollectionRow[], hasPlan: boolean): string[] {
  const lines = collections.length > 0 ? [`Variable collections in Figma: ${collections.map(c => c.name).join(', ')}`] : []
  lines.push(hasPlan ? 'Figma steps: ds-out/build-plan.md, run its phases in order.' : 'Figma steps appear after sign-off and Generate.')
  return lines
}

export function editSummary(edit: EditState): string {
  return edit.ok ? `${edit.label}: ${edit.failing.length === 0 ? 'the file still passes every check' : `${edit.failing.length} contrast pair(s) would fail`}` : edit.error
}

// ---- the Claude Design link (ds-design-system.json in the project folder) ----

// A link holds a title, an address, or both: the name the person typed, and the url when a link was pasted. An unlink
// writes only unlinkedAt, so a file with neither a title nor a url is no link.
export function linkFrom(text: string | null): DesignSystemLink | null {
  if (text === null) return null
  try {
    const data: unknown = JSON.parse(text)
    if (!isRecord(data)) return null
    const { title, url, linkedAt, source } = data
    const name = typeof title === 'string' ? title.trim() : ''
    const address = typeof url === 'string' ? url.trim() : ''
    if (name === '' && address === '') return null
    return {
      title: name !== '' ? name : address,
      url: address,
      linkedAt: typeof linkedAt === 'string' ? linkedAt : '',
      source: source === 'figma' ? 'figma' : 'claude-design',
    }
  } catch {
    return null
  }
}

// What the person typed into the link field: a title, and a url when the text is a link.
export type LinkTarget = { title: string; url: string }

// The title a pasted link gets when its address has no last path segment.
export const LINK_FALLBACK_TITLE = 'Claude Design design system'

// A value that starts with http:// or https:// is the url, titled by its last path segment. Anything else is the name,
// kept as the title with no url. Blank text is no target at all.
export function linkTarget(text: string): LinkTarget | null {
  const value = text.trim()
  if (value === '') return null
  if (!/^https?:\/\//i.test(value)) return { title: value, url: '' }
  // Split into scheme, empty part, host, then the path. A query or a fragment is not part of the title.
  const segments = value.replace(/[?#].*$/, '').split('/').slice(3).filter(part => part !== '')
  return { title: segments[segments.length - 1] ?? LINK_FALLBACK_TITLE, url: value }
}

export function linkRecord(target: LinkTarget, linkedAt: string, source: 'claude-design' | 'figma' = 'claude-design'): string {
  return JSON.stringify({ source, title: target.title, url: target.url, linkedAt }, null, 2) + '\n'
}

// ---- "Improve a Figma design system file": the file's link (ds-figma.json) and what Claude read from it ----

// A Figma file link: the file's key sits after /design/, /file/, /board/, /slides/, /make/ or /proto/.
const FIGMA_URL = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|slides|make|proto)\/([A-Za-z0-9]+)[^\s<>"')]*/i

// The first Figma file link in a text, or null. A link to Figma's home page or to a team page has no key and is none.
export function findFigmaUrl(text: string): string | null {
  const found = FIGMA_URL.exec(text)
  return found === null ? null : found[0]
}

export function figmaKeyOf(url: string): string | null {
  const found = FIGMA_URL.exec(url)
  return found === null ? null : (found[1] ?? null)
}

// The file's name as its link spells it: the segment after the key, with dashes as spaces. Empty when the link has none.
function figmaTitleOf(url: string): string {
  const path = url.replace(/[?#].*$/, '').split('/').filter(part => part !== '')
  const at = path.findIndex(part => /^(design|file|board|slides|make|proto)$/i.test(part))
  const name = at >= 0 ? (path[at + 2] ?? '') : ''
  try {
    return decodeURIComponent(name).replace(/[-_+]+/g, ' ').trim()
  } catch {
    return name.replace(/[-_+]+/g, ' ').trim()
  }
}

export function figmaRecord(url: string, requestedAt: string): string | null {
  const fileKey = figmaKeyOf(url)
  if (fileKey === null) return null
  return JSON.stringify({ url, fileKey, title: figmaTitleOf(url) || 'Figma file', requestedAt }, null, 2) + '\n'
}

export function figmaDisconnectRecord(disconnectedAt: string): string {
  return JSON.stringify({ disconnectedAt }, null, 2) + '\n'
}

export function figmaFileFrom(text: string | null): FigmaFile | null {
  if (text === null) return null
  try {
    const data: unknown = JSON.parse(text)
    if (!isRecord(data)) return null
    const { url, title, requestedAt } = data
    if (typeof url !== 'string') return null
    const fileKey = figmaKeyOf(url)
    if (fileKey === null) return null
    return {
      url,
      fileKey,
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Figma file',
      requestedAt: typeof requestedAt === 'string' ? requestedAt : '',
    }
  } catch {
    return null
  }
}

const COUNT_LABELS: Array<[string, string]> = [
  ['pages', 'pages'],
  ['collections', 'collections'],
  ['variables', 'variables'],
  ['styles', 'styles'],
  ['components', 'components'],
]

const stringsOf = (value: unknown, limit: number): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, limit) : []

// What Claude wrote after it read the file. Claude writes this file, so it is read with care: it counts only when it has
// a readAt, and only for the file that was asked for (a different key means an older file's inventory). Counts, fonts
// and colours are taken when they have the right type, and left out otherwise.
export function inventoryFrom(text: string | null, file: FigmaFile | null): FigmaInventory | null {
  if (text === null || file === null) return null
  try {
    const data: unknown = JSON.parse(text)
    if (!isRecord(data)) return null
    const { url, readAt, fileName, summary, notes } = data
    if (typeof readAt !== 'string' || readAt.trim() === '') return null
    if (typeof url === 'string' && figmaKeyOf(url) !== file.fileKey) return null
    const sums = isRecord(summary) ? summary : {}
    const counts: Array<{ label: string; value: number }> = []
    for (const [key, label] of COUNT_LABELS) {
      const value = sums[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counts.push({ label, value: Math.round(value) })
    }
    return {
      fileName: typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : file.title,
      readAt,
      counts,
      fonts: stringsOf(sums.fonts, 8),
      colours: stringsOf(sums.colours, 12),
      notes: typeof notes === 'string' ? notes.trim() : '',
    }
  } catch {
    return null
  }
}

// Where the flow stands. The inventory wins: once the file was read it is connected. Without it, the flow runs only while
// the person has it open, and asks for what is missing in order: the Figma connection, then the file's link.
export function improveStep(active: boolean, hasFigma: boolean, file: FigmaFile | null, inventory: FigmaInventory | null): ImproveStep {
  if (file !== null && inventory !== null) return 'connected'
  if (!active) return 'off'
  if (!hasFigma) return 'connect'
  if (file === null) return 'link'
  return 'reading'
}

// The tools of Figma's connector, whatever the server is called: they end in one of these names.
const FIGMA_TOOL = /__(use_figma|get_metadata|get_design_context|get_variable_defs)$/

export function hasFigmaTools(names: readonly string[]): boolean {
  return names.some(name => FIGMA_TOOL.test(name))
}

// The count line of a read file: "3 collections · 120 variables · 14 styles".
export function inventoryLine(inventory: FigmaInventory): string {
  const parts = inventory.counts.map(count => `${count.value} ${count.label}`)
  return parts.length > 0 ? parts.join(' · ') : 'read, with no counts'
}

// One line on where the option stands, for the panel's card and for the /defsys improve answer.
export function improveStatus(im: ImproveState): string {
  if (im.busy) return 'Checking the Figma connection…'
  switch (im.step) {
    case 'connect':
      return 'Figma is not connected to this chat. Connect it in Settings, under Connectors (or run /mcp in a terminal). This updates by itself once Figma is connected.'
    case 'link':
      return 'Figma is connected. Paste the link of the file to improve, here or in the band above the chat.'
    case 'reading':
      return `Claude is reading ${im.file?.title ?? 'the file'} in the chat. The details appear here when it has written ds-figma-inventory.json.`
    case 'connected':
      return `Connected to ${im.inventory?.fileName ?? 'the Figma file'}${im.inventory ? `: ${inventoryLine(im.inventory)}` : ''}.`
    default:
      return 'Read a Figma file and see how its design system can be improved. Claude fetches the details in the chat, and nothing in the file is changed.'
  }
}

// The request the model reads when the link is given. It names the files the model writes, and says what not to touch.
export function readRequest(file: FigmaFile, templatePath: string): string {
  return [
    `Read this Figma file for the defsys design system, read-only: ${file.url}`,
    '',
    'Use the Figma tools (use_figma, get_metadata). List its pages, its variable collections, its styles and its components.',
    `Then run the inventory template ${templatePath} through use_figma on the page that holds the screens, for the fonts and colours the file really uses.`,
    'Do not change anything in the Figma file.',
    '',
    'When you have read it, write ds-figma-inventory.json in the project folder as JSON:',
    `{ "url": "${file.url}", "readAt": "<the time now, ISO 8601>", "fileName": "<the file's name>",`,
    '  "summary": { "pages": n, "collections": n, "variables": n, "styles": n, "components": n,',
    '    "fonts": ["family", ...], "colours": ["#rrggbb", ...] }, "notes": "<two sentences on what the file has and lacks>" }',
    'Then say, in a short list, what you would improve in this design system. Do not edit ds.config.yaml yet.',
  ].join('\n')
}

// The request "Improve with Claude" puts in the prompt box once the file was read.
export function improveRequest(file: FigmaFile, inventory: FigmaInventory): string {
  return [
    `Improve the design system in this Figma file: ${file.url}`,
    `It was read already (${inventoryLine(inventory)}; details in ds-figma-inventory.json).`,
    'Compare it with ds.config.yaml if there is one. Propose the changes in order of value, one at a time, with the reason for each.',
    'Change nothing in Figma or in the config until I say yes to a change.',
  ].join('\n')
}

export function unlinkRecord(unlinkedAt: string): string {
  return JSON.stringify({ unlinkedAt }, null, 2) + '\n'
}

// ---- what the rest of Claude Code reads: the indicator above the chat, the turn note and the tools ----

const SIGN_TEXT: Record<SignOff, string> = {
  none: 'not signed off',
  current: 'signed off',
  stale: 'changed since sign-off',
  'no-config': 'no config yet',
}

const failingText = (count: number): string => (count === 0 ? '' : ` · ${count} failing pair${count === 1 ? '' : 's'}`)

const doneCount = (v: PanelView): number => v.stages.filter(stage => stage.state === 'done').length

// The indicator above the chat: the name, the stage count, the sign-off and the failing pairs. Undefined when the
// folder has no design system, so the band draws nothing for it.
export function indicatorText(v: PanelView): string | undefined {
  if (!v.hasConfig && v.link === null) return undefined
  const brand = v.answers.find(answer => answer.path.join('.') === 'brands.0.name')?.value
  const name = v.link?.title ?? brand ?? 'design system'
  const pairs = `${v.failing.length} failing pair${v.failing.length === 1 ? '' : 's'}`
  return `${name} · ${doneCount(v)}/${v.stages.length} stages · ${SIGN_TEXT[v.signoff]} · ${pairs}`
}

// A line the prompt carries for the model while the sign-off does not hold. Undefined when it holds or there is none.
export function turnNote(v: PanelView): string | undefined {
  if (!v.hasConfig || v.signoff === 'current') return undefined
  return (
    `defsys (design-system-definer): this project's design system is ${SIGN_TEXT[v.signoff]} ` +
    `(${doneCount(v)}/${v.stages.length} stages${failingText(v.failing.length)}). ` +
    'build.py --approve is refused until the person presses Approve in /defsys.'
  )
}

// The state the model reads from mcp__defsystem__status. It never carries the sign-off record itself.
export function statusJson(v: PanelView): string {
  return JSON.stringify(
    {
      folder: v.folder,
      linkedTo: v.link === null ? null : { title: v.link.title, url: v.link.url },
      hasConfig: v.hasConfig,
      signoff: v.signoff,
      approvedAt: v.approvedAt,
      stages: v.stages.map(stage => ({ no: stage.no, name: stage.name, state: stage.state, summary: stage.summary })),
      checks: v.checks,
      failing: v.failing,
      playback: v.playback,
      playbackNote: v.playbackNote,
      decisions: v.decisions,
      collections: v.collections,
      answers: v.answers.slice(0, ANSWER_LIMIT).map(answer => ({ setting: answer.path.join('.'), value: answer.value })),
      note: 'Only the Approve button in /defsys writes the sign-off. Claude cannot sign off.',
    },
    null,
    2,
  )
}

// The decision brief as text, for mcp__defsystem__brief. Capped so one call cannot flood the context.
export function briefText(v: PanelView): string {
  const lines = ['# Decision brief (defsys)', '', '## Structure']
  for (const row of v.collections) lines.push(`- ${row.name} (${row.modes}): ${row.why}`)
  lines.push('', '## Decisions', ...v.decisions.map(row => `- ${row.decision}: ${row.value}`))
  lines.push('', '## Checks', v.checks || 'not run yet', ...v.failing.map(line => `- ${line}`))
  if (v.brands !== '') lines.push('', '## Brands', v.brands)
  if (v.playback === 'error') lines.push('', `Playback error: ${v.playbackNote}`)
  return lines.join('\n').slice(0, BRIEF_LIMIT)
}

// The setting a model names in mcp__defsystem__preview: an answer's dotted path, or a setting the config lacks.
export function pickFor(answers: Answer[], setting: string): string | null {
  const wanted = setting.split('.').filter(Boolean).join('.')
  const index = answers.findIndex(answer => answer.path.join('.') === wanted)
  if (index >= 0) return `answer:${index}`
  return NEW_SETTINGS.some(item => item.key === wanted) ? `new:${wanted}` : null
}
