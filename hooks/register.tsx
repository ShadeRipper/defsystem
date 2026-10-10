import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EditState, PanelView, SetupStep, Tab, TokenCollection } from '../types'
import {
  answersFrom,
  briefText,
  buildStages,
  EMPTY_VIEW,
  figmaLines,
  hunksOnly,
  indicatorText,
  lastLine,
  linkFrom,
  linkRecord,
  linkTarget,
  parseBrief,
  pickFor,
  playbackFrom,
  resolvePick,
  signoffFrom,
  statusJson,
  turnNote,
  unlinkRecord,
} from './brief'
import { panel } from './panel'

// Everything that takes $ lives in this file: the engine only follows $ into functions declared here. The state
// references are declared here too, so the engine can list what this module reads and writes.
const viewAtom = atom({ plugin: 'defsystem', key: 'view' } as const, EMPTY_VIEW)
// Whether the "could not register /defsys" line was written this session. The session's state keeps it across reloads.
const notedAtom = atom({ plugin: 'defsystem', key: 'noted' } as const, false)

const PANE = 'defsystem'
const COMMAND = 'defsys'
// The name the skill answers to. If the engine resolves a typed /defsys to it, the same handler answers it.
const CANONICAL = 'design-system-definer:defsys'
// The name of this plugin's own commands/defsys.md. The engine lists a file command at load, before any prompt, so the
// typeahead shows /defsys from the first slash. A command registered in session.start is listed only after it.
const FILE_COMMAND = 'defsystem:defsys'
// The typeahead line: the name and the skill it belongs to. The command has no argument hint.
const DESCRIPTION = 'design-system-definer: open the defsys panel to set up, review and sign off a design system'
const CONFIG = 'ds.config.yaml'
const RECORD = 'ds-signoff.json'
const LINK = 'ds-design-system.json'
const BRIEF_FILE = 'ds-out/decision-brief.md'
const PLAN_FILE = 'ds-out/build-plan.md'
// Bundled in this mod, under the plugin root. Not a skills folder, so the skill registers no command of its own.
const SKILL_FILE = 'resources/defsys/SKILL.md'
const SCRIPTS = 'resources/defsys/scripts'
const PYTHON_TIMEOUT_MS = 30_000
const HELPER_TIMEOUT_MS = 60_000
const REFRESH_MS = 2500
const WIDEN = 'Widen the terminal to 110 columns or more to see the defsys panel.'
const PANE_FAILED = 'defsys: the side panel failed to open. The debug log has the reason.'
const MISSING = 'The defsys scripts are missing from this mod (resources/defsys/scripts), so the skill cannot run. Reinstall defsystem.'
const INTERVIEW_REQUEST =
  'Start the defsys interview to define a design system for this project. Ask one question at a time, and follow the defsys skill in your context.'
// The paragraph that follows the skill's text while the interview runs.
const INTERVIEW_PARAGRAPH = [
  'The paths in this text are relative to resources\\defsys under the plugin root.',
  'Read the reference files with the Read tool when a stage needs them.',
  'Build with scripts\\build.py, and never with --approve before the person signs off in /defsys.',
].join(' ')
const TAB_FOR_SUB = new Map<string, Tab>([
  ['overview', 'stages'],
  ['stages', 'stages'],
  ['tokens', 'tokens'],
  ['answers', 'answers'],
  ['figma', 'figma'],
])
const TABS = new Set<string>(['stages', 'tokens', 'answers', 'figma'])
const SETUP_SUBS = new Set<string>(['new', 'existing'])

const RECORD_NOTE = 'ds-signoff.json is written only by the Approve button in /defsys. Claude cannot write it.'
const GUARD_FAILED = 'The design system guard failed, so the command did not run.'
const RECORD_FILE = /(^|[\\/])ds-signoff\.json$/i
const RECORD_IN_COMMAND = /ds-signoff\.json/i

const WHY_REFUSED = {
  'no-config': 'There is no ds.config.yaml in this folder, so there is nothing to build.',
  none: 'This design system is not signed off yet. Open /defsys, read the config and press Approve, then run the build again.',
  stale: 'The config changed after the last sign-off. Open /defsys, read the change and approve it again, then run the build again.',
}

// What the model is told once per session, in the system prompt. It is the same text every time, so it stays cached.
const MODEL_NOTE = {
  id: 'defsystem',
  scope: 'session' as const,
  text:
    'This project may use the defsys design-system skill (design-system-definer). ds.config.yaml holds the answers and ds-out/ ' +
    'the build. The person opens the defsys panel with /defsys or the Open button in the indicator above the chat. Claude ' +
    'cannot open the panel, so do not suggest any other command for it. Claude reads the state with the three ' +
    'mcp__defsystem__ tools, mcp__defsystem__status, mcp__defsystem__brief and mcp__defsystem__preview, ' +
    'and none of them writes a file. Claude cannot sign off: ds-signoff.json is written only by the Approve button in the panel, ' +
    'so never write it, and never run build.py with --approve before a sign-off holds.',
}

// Every sub-command of /defsys. A new one is one line here and one case in the command handler.
const SUB_HELP = [
  '/defsys sub-commands (type them after /defsys):',
  '  open       open the side panel (the default)',
  '  overview   open the panel on the overview (same as stages)',
  '  stages     open the panel on the overview',
  '  tokens     open the panel on the token tree',
  '  answers    open the panel on your answers, to change them',
  '  figma      open the panel on the Figma steps',
  '  new        open the setup flow on creating a design system',
  '  existing   open the setup flow on linking a Claude Design design system',
  '  refresh    re-read the project folder',
  '  approve    sign the config off (typed by you; Claude cannot approve)',
  '  withdraw   withdraw the sign-off',
  '  unlink     unlink this project from Claude Design',
  '  help       list these sub-commands',
].join('\n')

type Snapshot = { configText: string | null; recordText: string | null; linkText: string | null; hasBrief: boolean; hasPlan: boolean }
type Run = { exitCode: number; stdout: string; stderr: string }
type HelperResult = {
  ok: boolean
  error: string
  config?: Record<string, unknown>
  collections?: TokenCollection[]
  failing?: string[]
  yaml?: string
  diff?: string
}

let ticking = false
// The skill's SKILL.md, read once per load of this module.
let skillText: string | null | undefined

// The reason the engine gave for a refusal, whatever shape the thrown value has.
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

// The skill's scripts folder, bundled in this mod. Checked on each use, so a folder restored while the mod runs is found.
async function findScripts($: EngineInterface): Promise<string | null> {
  const dir = `${$.plugin.root}/${SCRIPTS}`
  return (await $.fs.exists(`${dir}/build.py`)) ? dir : null
}

// python, then the py launcher. A launcher that is not installed rejects, so the next one is tried.
async function python($: EngineInterface, args: string[], cwd: string): Promise<Run> {
  for (const launcher of [['python'], ['py', '-3']]) {
    try {
      const run = await $.process.run([...launcher, ...args], { cwd, timeoutMs: PYTHON_TIMEOUT_MS })
      if (run.exitCode !== 9009) return run
    } catch {
      // Not on the PATH under this name; try the next launcher.
    }
  }
  return { exitCode: -1, stdout: '', stderr: 'Python 3 was not found on this machine.' }
}

// The helper ships in this plugin (helpers/defsys_helper.py). It runs the skill's own code and writes nothing
// into the project. The payload goes in on stdin, so no value is ever quoted into a command line.
async function helper($: EngineInterface, action: 'inspect' | 'candidate', payload: Record<string, unknown>): Promise<HelperResult> {
  const folder = await $.session.cwd()
  const script = `${$.plugin.root}/helpers/defsys_helper.py`
  const stdin = JSON.stringify(payload)
  for (const launcher of [['python'], ['py', '-3']]) {
    try {
      const run = await $.process.run([...launcher, script, action], { cwd: folder, stdin, timeoutMs: HELPER_TIMEOUT_MS })
      if (run.exitCode === 9009) continue
      try {
        return JSON.parse(run.stdout) as HelperResult
      } catch {
        return { ok: false, error: lastLine(run.stderr) || `The helper printed nothing readable (exit ${run.exitCode}).` }
      }
    } catch {
      // This launcher is not installed; try the next.
    }
  }
  return { ok: false, error: 'Python 3 was not found on this machine.' }
}

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const configText = (await $.fs.exists(CONFIG)) ? await $.fs.read(CONFIG) : null
  const recordText = (await $.fs.exists(RECORD)) ? await $.fs.read(RECORD) : null
  const linkText = (await $.fs.exists(LINK)) ? await $.fs.read(LINK) : null
  return {
    configText,
    recordText,
    linkText,
    hasBrief: await $.fs.exists(BRIEF_FILE),
    hasPlan: await $.fs.exists(PLAN_FILE),
  }
}

// The playback: build.py with no flags prints the decision brief and writes nothing.
async function playback($: EngineInterface, folder: string, scripts: string): Promise<Run> {
  return python($, [`${scripts}/build.py`, CONFIG], folder)
}

// previous is the view the panel shows now. When the helper cannot be read (it fails, or prints nothing it can read),
// its answers, tokens and collections are kept from that view, so one failed read does not empty the panel.
async function buildView($: EngineInterface, snap: Snapshot, previous: PanelView): Promise<PanelView> {
  const folder = await $.session.cwd()
  const { signoff, approvedAt } = signoffFrom(snap.configText, snap.recordText)
  const head: PanelView = {
    ...EMPTY_VIEW,
    folder,
    signoff,
    approvedAt,
    hasConfig: snap.configText !== null,
    link: linkFrom(snap.linkText),
    fingerprint: JSON.stringify(snap),
  }
  if (snap.configText === null) {
    return { ...head, stages: buildStages([], 'none', '', '', snap.hasBrief, snap.hasPlan) }
  }

  const scripts = await findScripts($)
  if (scripts === null) {
    return {
      ...head,
      answers: previous.answers,
      collections: previous.collections,
      figma: figmaLines(previous.collections, snap.hasPlan),
      tokens: previous.tokens,
      playback: 'error',
      playbackNote: MISSING,
      tokensError: MISSING,
      stages: buildStages(previous.answers, 'error', MISSING, '', snap.hasBrief, snap.hasPlan),
    }
  }

  const inspected = await helper($, 'inspect', { scripts, config: CONFIG })
  // Without a config in the reply the helper did not read the file, so the answers of the last good view stay.
  const answers = inspected.config ? answersFrom(inspected.config) : previous.answers
  const played = playbackFrom(await playback($, folder, scripts))
  const parsed = parseBrief(played.brief)
  // The brief is missing while the config does not play back; the collections of the last good brief stay with it.
  const collections = parsed.collections.length > 0 ? parsed.collections : previous.collections
  const note = played.note || (inspected.ok ? '' : inspected.error)

  return {
    ...head,
    answers,
    collections,
    decisions: parsed.decisions,
    brands: parsed.brands,
    checks: parsed.checks,
    failing: parsed.failing,
    playback: played.playback,
    playbackNote: note,
    figma: figmaLines(collections, snap.hasPlan),
    tokens: inspected.ok ? (inspected.collections ?? []) : previous.tokens,
    tokensError: inspected.ok ? '' : inspected.error,
    stages: buildStages(answers, played.playback, note, parsed.checks, snap.hasBrief, snap.hasPlan),
  }
}

// Rebuilds what the panel and the indicator above the chat show from the folder. The view the person is in (tab,
// open branches, the pick, any preview, the setup step and the interview) is kept as it is, except that a sign-off
// that holds ends the interview.
async function refresh($: EngineInterface, message = ''): Promise<void> {
  const previous = await read($, viewAtom)
  const view = await buildView($, await snapshot($), previous)
  await update($, viewAtom, prev => ({
    ...view,
    tab: prev.tab,
    open: prev.open,
    pick: prev.pick,
    edit: prev.edit,
    setup: prev.setup,
    interview: view.signoff === 'current' ? false : prev.interview,
    message,
  }))
  // A sign-off that held before the change and does not hold now is said once, where the person is working.
  if (previous.signoff === 'current' && view.signoff === 'stale') {
    $.ui.toast('defsys: ds.config.yaml changed after the sign-off. Open /defsys to approve it again.')
  }
}

// Re-reads the folder for a tool call, keeping the message the panel already shows.
async function reload($: EngineInterface): Promise<void> {
  await refresh($, (await read($, viewAtom)).message)
}

// Approve writes the sign-off record. It refuses unless the brief plays back clean: no config error, no failing pair.
async function approve($: EngineInterface): Promise<string> {
  const snap = await snapshot($)
  if (snap.configText === null) return 'There is no ds.config.yaml here to approve.'
  const scripts = await findScripts($)
  if (scripts === null) return MISSING
  const folder = await $.session.cwd()
  const played = playbackFrom(await playback($, folder, scripts))
  if (played.playback === 'error') return `Fix the config first: ${played.note}`
  const { failing } = parseBrief(played.brief)
  if (failing.length > 0) return `Fix ${failing.length} failing contrast pair(s) before approving.`
  const approvedAt = new Date(await $.clock.now()).toISOString()
  await $.fs.write(RECORD, JSON.stringify({ approvedAt, config: snap.configText }, null, 2) + '\n')
  return 'Signed off. Claude can now run the build with --approve.'
}

async function withdraw($: EngineInterface): Promise<string> {
  const withdrawnAt = new Date(await $.clock.now()).toISOString()
  await $.fs.write(RECORD, JSON.stringify({ withdrawnAt }, null, 2) + '\n')
  return 'Sign-off withdrawn. Claude cannot run the build until you approve again.'
}

// Previews one answer change: the helper sets it in a copy, checks the copy, and returns the new file and a diff.
// Nothing is written here.
async function previewEdit($: EngineInterface, pick: string, text: string): Promise<{ edit: EditState | null; message: string }> {
  const view = await read($, viewAtom)
  const target = resolvePick(view.answers, pick)
  if (target === null) return { edit: null, message: 'Pick an answer first.' }
  const snap = await snapshot($)
  if (snap.configText === null) return { edit: null, message: 'There is no ds.config.yaml here to change.' }
  const scripts = await findScripts($)
  if (scripts === null) return { edit: null, message: MISSING }
  const result = await helper($, 'candidate', { scripts, config: CONFIG, path: target.path, kind: target.kind, text })
  return {
    edit: {
      path: target.path,
      label: target.label,
      kind: target.kind,
      text,
      ok: result.ok,
      error: result.error,
      diff: result.diff ?? '',
      yaml: result.yaml ?? '',
      failing: result.failing ?? [],
      base: snap.configText,
    },
    message: '',
  }
}

// Writes the previewed file, but only if the config is still the one the preview was made from.
async function applyEdit($: EngineInterface): Promise<{ applied: boolean; message: string }> {
  const edit = (await read($, viewAtom)).edit
  if (edit === null || !edit.ok) return { applied: false, message: 'Nothing to apply. Preview a valid change first.' }
  const snap = await snapshot($)
  if (snap.configText !== edit.base) {
    return { applied: false, message: 'The config changed since this preview. Preview the change again.' }
  }
  await $.fs.write(CONFIG, edit.yaml)
  return { applied: true, message: `Applied: ${edit.label}. Approve again to sign off the new config.` }
}

// ---- the setup flow: link a Claude Design design system by its name or link, or start the interview for a new one ----

async function setStep($: EngineInterface, step: SetupStep): Promise<void> {
  await update($, viewAtom, prev => ({ ...prev, setup: { ...prev.setup, step } }))
}

// Puts text in the prompt box for the person to send. Text already typed is kept, and the new text goes after it.
async function fillPrompt($: EngineInterface, text: string): Promise<boolean> {
  const draft = (await $.prompt.read()).text
  const next = draft.trim() === '' ? text : `${draft.replace(/\s+$/, '')}\n${text}`
  const filled = await $.prompt.fill({ text: next, mode: 'replace' })
  return filled.isFilled
}

// Links what the person typed into the field: a name, or a pasted link. A name is kept with no url; a link keeps its url.
// Blank text links nothing, and the reply says so while the field stays open.
async function linkSystem($: EngineInterface, text: string): Promise<string> {
  const target = linkTarget(text)
  if (target === null) return 'Type the name of your design system, or paste its link, first.'
  await $.fs.write(LINK, linkRecord(target, new Date(await $.clock.now()).toISOString()))
  await update($, viewAtom, prev => ({ ...prev, setup: { ...prev.setup, step: 'choose' as const } }))
  return `Linked this project to ${target.title}.`
}

async function unlink($: EngineInterface): Promise<string> {
  await $.fs.write(LINK, unlinkRecord(new Date(await $.clock.now()).toISOString()))
  return 'Unlinked from Claude Design.'
}

// ---- the interview: while it is on, the skill's own text is in the system prompt for the session ----

// Starts the interview: the request goes in the prompt box for the person to send, and the skill's text joins the prompt.
async function startInterview($: EngineInterface): Promise<void> {
  const filled = await fillPrompt($, INTERVIEW_REQUEST).catch(() => false)
  await update($, viewAtom, prev => ({
    ...prev,
    interview: true,
    message: filled
      ? 'The request is in the prompt box. Press Enter in the chat to start the interview.'
      : 'The interview is on. Type "Start the defsys interview" in the chat to begin.',
  }))
}

async function stopInterview($: EngineInterface): Promise<void> {
  await update($, viewAtom, prev => ({
    ...prev,
    interview: false,
    message: 'The interview is stopped. The skill text is no longer in the system prompt.',
  }))
}

// The skill's SKILL.md, read once per load of this module. An empty answer means the file is missing from the mod.
async function skillTextOf($: EngineInterface): Promise<string | null> {
  if (skillText === undefined) {
    const file = `${$.plugin.root}/${SKILL_FILE}`
    skillText = (await $.fs.exists(file)) ? await $.fs.read(file) : null
  }
  return skillText
}

// The section the prompt carries while the interview runs: the skill's text, then one paragraph about this mod.
async function interviewSection($: EngineInterface): Promise<string> {
  const text = await skillTextOf($)
  if (text === null) return `${INTERVIEW_PARAGRAPH} The defsys skill text is missing from this mod.`
  return `${text}\n\n${INTERVIEW_PARAGRAPH}`
}

// Shell commands: the sign-off record is never named, and a build with --approve runs only when signed off.
async function shellDenial($: EngineInterface, command: string): Promise<string | null> {
  if (RECORD_IN_COMMAND.test(command)) return RECORD_NOTE
  if (!(/build\.py/.test(command) && /--approve\b/.test(command))) return null
  const snap = await snapshot($)
  const { signoff } = signoffFrom(snap.configText, snap.recordText)
  return signoff === 'current' ? null : WHY_REFUSED[signoff]
}

// ---- the model's tools: what the defsys skill knows, read or previewed, never signed off ----

// A string argument of a tool call. The tool's arguments are plain fields of the call.
function argOf(e: unknown, name: string): string {
  const value = (e as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : ''
}

async function statusTool($: EngineInterface): Promise<string> {
  await reload($)
  return statusJson(await read($, viewAtom))
}

async function briefTool($: EngineInterface): Promise<string> {
  await reload($)
  const view = await read($, viewAtom)
  if (!view.hasConfig) return 'There is no ds.config.yaml in this folder yet, so there is no brief.'
  return briefText(view)
}

async function previewTool($: EngineInterface, e: unknown): Promise<string> {
  const setting = argOf(e, 'setting')
  const value = argOf(e, 'value')
  await reload($)
  const pick = pickFor((await read($, viewAtom)).answers, setting)
  if (pick === null) {
    return `No setting called "${setting}". Use a dotted path such as color.contrast or brands.0.radius.button.`
  }
  const { edit, message } = await previewEdit($, pick, value)
  if (edit === null) return message
  return JSON.stringify(
    {
      setting,
      value,
      ok: edit.ok,
      error: edit.error,
      diff: hunksOnly(edit.diff),
      failing: edit.failing,
      note: 'Nothing was written. The person applies a change with the Apply button in /defsys.',
    },
    null,
    2,
  )
}

// While the module is loaded it re-reads the folder every few seconds, and rebuilds only when the config, the
// sign-off record, the link or the outputs changed. The indicator above the chat follows the same rebuild.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const fingerprint = JSON.stringify(await snapshot($))
    const current = await read($, viewAtom)
    if (fingerprint !== current.fingerprint) await refresh($, current.message)
  } finally {
    ticking = false
  }
}

// Opens the panel. Asked by the person (a command they typed, a Button they pressed), it is placed at any width.
async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'defsys', focus: true, closeOnEscape: true })
  $.ui.invalidate('ui.render')
}

// The /defsys handler, shared by the command's name and the canonical name. The pane opens first: before any read of
// the folder and before any python, so the person sees it at once.
async function runCommand($: EngineInterface, args: string): Promise<{ text?: string }> {
  const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase() || 'open'
  if (sub === 'help') return { text: SUB_HELP }
  if (sub === 'refresh') {
    await refresh($, 'Re-read from the folder.')
    return { text: 'defsys: re-read from the folder.' }
  }
  if (sub === 'approve') {
    const text = await approve($)
    await refresh($, text)
    return { text }
  }
  if (sub === 'withdraw') {
    const text = await withdraw($)
    await refresh($, text)
    return { text }
  }
  if (sub === 'unlink') {
    const text = await unlink($)
    await refresh($, text)
    return { text }
  }
  const tab = TAB_FOR_SUB.get(sub)
  const setup = SETUP_SUBS.has(sub) ? (sub as SetupStep) : null
  if (sub !== 'open' && tab === undefined && setup === null) {
    return { text: `Unknown sub-command "${sub}".\n${SUB_HELP}` }
  }

  const opened = await $.ui.open({ id: PANE, title: 'defsys', focus: true, closeOnEscape: true })
  // The tab or the setup step is set before the first drawing, so the pane opens where the person asked.
  await update($, viewAtom, prev => ({
    ...prev,
    tab: tab ?? prev.tab,
    setup: setup === null ? prev.setup : { ...prev.setup, step: setup },
  }))
  // A pane that is already open keeps its last drawing. Ask for a fresh draw, so the code loaded now shows.
  $.ui.invalidate('ui.render')
  // The folder is read in the background; the drawing refreshes when it is ready.
  refresh($, 'Read from the folder.').catch(() => undefined)
  return opened.isPlaced ? {} : { text: WIDEN }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(REFRESH_MS, () => {
      tick($).catch(() => undefined)
    })
    // The indicator and the first read of the folder. Not awaited: the first prompt does not wait for python.
    refresh($).catch(() => undefined)
    // The model's tools come before the command. A refused tool is skipped, not fatal.
    await $.tool
      .register({
        name: 'status',
        description: 'The design system in this project: whether ds.config.yaml exists, its stages, sign-off, failing contrast pairs and answers. Read-only.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.tool
      .register({
        name: 'brief',
        description: "The decision brief of this project's design system: structure, decisions, checks and brands. Read-only.",
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.tool
      .register({
        name: 'preview',
        description: 'Preview one change to an answer in ds.config.yaml and say whether the contrast checks still pass. Writes nothing.',
        inputSchema: {
          type: 'object',
          properties: {
            setting: { type: 'string', description: 'A dotted path such as color.contrast or brands.0.radius.button' },
            value: { type: 'string', description: 'The new value, as the file should hold it' },
          },
          required: ['setting', 'value'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    // The command goes last. commands/defsys.md lists /defsystem:defsys from load; the bare /defsys exists only once it is
    // registered here. A name the engine refuses throws, so it is registered inside a try: the reason goes to the
    // transcript once per session, and the file command still answers.
    try {
      await $.command.register({ name: COMMAND, description: DESCRIPTION, immediate: true })
      // The typeahead keeps the command list it read for the session until its descriptions are invalidated. A chat
      // whose list was read before this name existed would not show /defsys, so ask for the list to be read again.
      $.ui.invalidate('command.describe')
    } catch (error) {
      if (!(await read($, notedAtom))) {
        await update($, notedAtom, () => true)
        $.ui.log(`defsys: could not register /${COMMAND}: ${reasonOf(error)}`)
      }
    }
    return next(e)
  })

  // The typeahead line for /defsys: its name and the skill it belongs to, and no argument hint.
  on('command.describe', { command: COMMAND }, () => ({ description: DESCRIPTION, isHidden: false }))

  // /defsys, and the canonical name in case the engine resolves a typed /defsys to it. Both run the same handler.
  on('command.run', { command: COMMAND }, ($, e) => runCommand($, e.args)).catch(($, e, next) =>
    next.called ? next(e) : { text: PANE_FAILED },
  )
  on('command.run', { command: CANONICAL }, ($, e) => runCommand($, e.args)).catch(($, e, next) =>
    next.called ? next(e) : { text: PANE_FAILED },
  )
  on('command.run', { command: FILE_COMMAND }, ($, e) => runCommand($, e.args)).catch(($, e, next) =>
    next.called ? next(e) : { text: PANE_FAILED },
  )

  // Tools the model calls. Each answers from the folder; none of them writes a file or signs anything off.
  on('tool.call', { tool: 'mcp__defsystem__status' }, async $ => ({ result: await statusTool($) })).catch(
    () => ({ result: 'defsys could not read the design system. The debug log has the reason.' }),
  )
  on('tool.call', { tool: 'mcp__defsystem__brief' }, async $ => ({ result: await briefTool($) })).catch(
    () => ({ result: 'defsys could not read the brief. The debug log has the reason.' }),
  )
  on('tool.call', { tool: 'mcp__defsystem__preview' }, async ($, e) => ({ result: await previewTool($, e) })).catch(
    () => ({ result: 'defsys could not preview the change. The debug log has the reason.' }),
  )

  // The system prompt carries the rule once. The static text keeps the prompt cache whole. While the interview runs,
  // the skill's own text follows it for the session.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections, MODEL_NOTE]
    if (!(await read($, viewAtom)).interview) return { sections }
    const text = await interviewSection($)
    return { sections: [...sections, { id: 'defsys-interview', text, scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))

  // While the sign-off does not hold, each prompt carries a line that says so, so the model knows before it acts.
  on('prompt.submit', async ($, e, next) => {
    const note = turnNote(await read($, viewAtom))
    if (note === undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const denial = await shellDenial($, e.command)
    if (denial !== null) return { deny: denial }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const denial = await shellDenial($, e.command)
    if (denial !== null) return { deny: denial }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  on('tool.call', { tool: 'Write' }, (_, e, next) =>
    RECORD_FILE.test(e.file_path) ? { deny: RECORD_NOTE } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  on('tool.call', { tool: 'Edit' }, (_, e, next) =>
    RECORD_FILE.test(e.file_path) ? { deny: RECORD_NOTE } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  // The indicator above the chat: the design system's name, its stages, the sign-off and the failing pairs, with an
  // Open button. Nothing is drawn when the folder has no design system, and the band keeps what other mods draw.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = indicatorText(await read($, viewAtom))
    if (text === undefined || e.props.hasSurvey) return next(e)
    const drawn = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="claude" bold>
          ✻ defsys
        </Text>
        <Text>{text}</Text>
        <Button key="open" label="Open" onPress={() => openPane($)} />
        {drawn}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const actions = {
      tab: (value: Tab) => update($, viewAtom, prev => (TABS.has(value) ? { ...prev, tab: value } : prev)),
      pick: (value: string) => update($, viewAtom, prev => ({ ...prev, pick: value, edit: null, message: '' })),
      preview: async (text: string) => {
        const { edit, message } = await previewEdit($, (await read($, viewAtom)).pick, text)
        await update($, viewAtom, prev => ({ ...prev, edit, message }))
      },
      apply: async () => {
        const { applied, message } = await applyEdit($)
        await update($, viewAtom, prev => ({ ...prev, edit: applied ? null : prev.edit }))
        await refresh($, message)
      },
      discard: () => update($, viewAtom, prev => ({ ...prev, edit: null, message: 'Change discarded.' })),
      toggle: (key: string) =>
        update($, viewAtom, prev => ({
          ...prev,
          open: prev.open.includes(key) ? prev.open.filter(item => item !== key) : [...prev.open, key],
        })),
      collapse: () => update($, viewAtom, prev => ({ ...prev, open: [] })),
      approve: async () => refresh($, await approve($)),
      withdraw: async () => refresh($, await withdraw($)),
      refresh: () => refresh($, 'Re-read from the folder.'),
      step: (value: SetupStep) => setStep($, value),
      link: async (text: string) => refresh($, await linkSystem($, text)),
      unlink: async () => refresh($, await unlink($)),
      startInterview: () => startInterview($),
      stopInterview: () => stopInterview($),
    }
    return panel($.ui.resolve(e), await read($, viewAtom), actions, e.surface)
  })
}
