// The defsys side panel. With no design system it is a setup flow, in the order Claude Design uses: choose a start,
// then link a Claude Design design system by its name or its link, or create a new one. With one, it is four tabs and
// a sign-off card. Every section is a card: a round border, with its title in the accent colour at the top. An item
// inside a card is a sub-box (a single border, or a dimmed marker for a token leaf), and long text wraps inside its box.
// It is drawn with the parts Claude Code's own panels use: Buttons for every choice, Text with ✻ ❯ ⎿ ✔ ◦ for the
// marks, a Code block that shows a diff before anything is applied, and an Input for a new value. Colours are theme
// keys, so the panel follows the terminal and the desktop theme. Swatches are the one exception: they show the colour.
//
// Option-list limit: the engine refuses a Select with more than 64 options ("Select pick options must be 1 to 64
// entries"). When it refuses a tree, it draws its own version of the whole pane, so the tabs disappear and the person
// cannot get back. A real config can have more than 64 answers, so the Answers tab draws a Button per
// answer, grouped under its interview stage, at most 40 Buttons to a stage. Never use a Select, or any element with an
// option list that could be longer than 64 entries, and keep every list in this file within those limits.
import type { EngineInterface } from 'claude-code'

import type { PanelView, SetupStep, SignOff, StageState, Tab, TokenCollection } from '../types'
import {
  countLeaves,
  editSummary,
  hunksOnly,
  indexVariables,
  pickGroups,
  pickOptions,
  resolvePick,
  STAGE_NAMES,
  swatchOf,
  treeOf,
  variableText,
  type TreeNode,
} from './brief'

export type Actions = {
  tab: (value: Tab) => unknown
  pick: (value: string) => unknown
  preview: (text: string) => unknown
  apply: () => unknown
  discard: () => unknown
  toggle: (key: string) => unknown
  collapse: () => unknown
  approve: () => unknown
  withdraw: () => unknown
  refresh: () => unknown
  step: (value: SetupStep) => unknown
  link: (text: string) => unknown
  unlink: () => unknown
  startInterview: () => unknown
  stopInterview: () => unknown
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const MARK = '✻'
const DETAIL = '⎿'
const LINKED = '↗'
const MARKER = '│'
const TREE_LIMIT = 200

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'stages', label: 'Overview' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'answers', label: 'Answers' },
  { value: 'figma', label: 'Figma' },
]

const CHIP: Record<SignOff, { text: string; color: string }> = {
  none: { text: 'Not signed off', color: 'warning' },
  current: { text: 'Signed off', color: 'success' },
  stale: { text: 'Changed since sign-off', color: 'warning' },
  'no-config': { text: 'No ds.config.yaml yet', color: 'error' },
}

const GLYPH: Record<StageState, string> = { done: '✔', current: '❯', todo: '◦' }
const GLYPH_COLOR: Record<StageState, string> = { done: 'success', current: 'claude', todo: 'subtle' }

// A Button is primary only when asked. An undefined variant is a prop the element does not take, so the tree would fail.
const primaryIf = (on: boolean): { variant?: 'primary' } => (on ? { variant: 'primary' } : {})

const SETUP_TITLE: Record<SetupStep, string> = {
  choose: 'Set up a design system',
  existing: 'Use an existing design system',
  new: 'Create a new design system',
}

const SETUP_LEAD: Record<SetupStep, string> = {
  choose: 'A design system holds the colours, type, spacing and rules that Figma and your code share. Choose where to start.',
  existing: 'Link a design system from your Claude Design account to this project. Nothing is copied.',
  new: 'The defsys skill interviews you one question at a time in this chat, then plays back a brief for your sign-off.',
}

// The line above the link field. The chat cannot read a standalone design system, so the person pastes its link.
const STANDALONE_NOTE =
  'Standalone design systems are not visible to this chat. Open the design system in Claude Design settings, copy its link, and paste it here.'

export function panel(els: Elements, v: PanelView, act: Actions, surface: string) {
  const { Box, Text, Button, Markdown, Code } = els
  // Mobile draws no Select and no Input, although its element table lists them on this build. So the decision is
  // made by the surface: there the pick and the change form become text, and the panel says where to use them.
  const interactive = surface !== 'mobile'
  const Input = interactive && 'Input' in els ? els.Input : undefined
  const hasDesign = v.hasConfig || v.link !== null
  const chip = CHIP[v.signoff]
  const canWithdraw = v.signoff === 'current' || v.signoff === 'stale'
  const index = indexVariables(v.tokens)
  const done = v.stages.filter(stage => stage.state === 'done').length
  const bar = `${'█'.repeat(done)}${'░'.repeat(v.stages.length - done)}`
  const current = resolvePick(v.answers, v.pick)
  const totalVariables = v.tokens.reduce((sum, collection) => sum + collection.variables.length, 0)
  const complete = v.hasConfig && v.stages.every(stage => stage.state === 'done')

  // A leaf of the token tree: its name, a swatch when it is a colour, and its value. A dimmed marker stands at its left.
  const leafRow = (node: TreeNode) => {
    const leaf = node.leaf
    if (leaf === null) return null
    const swatch = swatchOf(leaf, index)
    return (
      <Box key={`leaf:${node.key}`} flexDirection="row" gap={1}>
        <Text dimColor>{MARKER}</Text>
        <Text wrap="wrap">{node.name}</Text>
        {swatch !== null && <Text backgroundColor={swatch}>{'   '}</Text>}
        <Text dimColor wrap="wrap">{variableText(leaf)}</Text>
      </Box>
    )
  }

  // A group of the token tree is a sub-box: its button, then, once it is open, its own leaf and its children. A node
  // with no children is a leaf, and is drawn as a marker row.
  const branch = (node: TreeNode) => {
    if (node.children.length === 0) return leafRow(node)
    const isOpen = v.open.includes(node.key)
    return (
      <Box key={`box:${node.key}`} flexDirection="column" borderStyle="single" paddingX={1}>
        <Button
          key={node.key}
          label={`${isOpen ? '▾' : '▸'} ${node.name} · ${countLeaves(node)}`}
          plain
          onPress={() => act.toggle(node.key)}
        />
        {isOpen && node.leaf !== null && leafRow(node)}
        {isOpen && node.children.slice(0, TREE_LIMIT).map(child => branch(child))}
      </Box>
    )
  }

  // One collection of the token structure: a round card with its name at the top, and a button that opens its tree.
  const collection = (c: TokenCollection) => {
    const tree = treeOf(c)
    const isOpen = v.open.includes(tree.key)
    return (
      <Box key={`box:${tree.key}`} flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>{c.name}</Text>
        <Button
          key={tree.key}
          label={`${isOpen ? '▾' : '▸'} ${c.name} · ${countLeaves(tree)} tokens · ${c.modes.join(', ')}`}
          onPress={() => act.toggle(tree.key)}
        />
        {isOpen && tree.children.map(child => branch(child))}
      </Box>
    )
  }

  const header = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>{`${MARK} defsys · design-system-definer`}</Text>
      <Text dimColor wrap="wrap">{v.folder || 'No project folder'}</Text>
      {hasDesign ? (
        <Text color={chip.color} wrap="wrap">{`● ${chip.text}${v.approvedAt ? ` · approved ${v.approvedAt.slice(0, 10)}` : ''}`}</Text>
      ) : (
        <Text color="warning">● No design system yet</Text>
      )}
      {hasDesign && <Text dimColor>{`${bar} ${done}/${v.stages.length} stages`}</Text>}
      {v.message !== '' && <Text dimColor wrap="wrap">{`${DETAIL} ${v.message}`}</Text>}
      {v.tokensError !== '' && <Text color="error" wrap="wrap">{`${DETAIL} ${v.tokensError}`}</Text>}
      {v.link !== null && <Text color="suggestion" wrap="wrap">{`${LINKED} Claude Design · ${v.link.title}`}</Text>}
    </Box>
  )

  const tabs = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>View</Text>
      <Box flexDirection="row" gap={1}>
        {TABS.map((item, i) => (
          <Button
            key={`tab-${item.value}`}
            label={item.label}
            hotkey={String(i + 1)}
            {...primaryIf(item.value === v.tab)}
            onPress={() => act.tab(item.value)}
          />
        ))}
      </Box>
    </Box>
  )

  const overview = (
    <Box flexDirection="column" gap={1}>
      {!v.hasConfig && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color="claude" bold>Next</Text>
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text dimColor wrap="wrap">{`${DETAIL} Linked to Claude Design. Start the interview below to write ds.config.yaml.`}</Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Defining stage</Text>
        {v.stages.map(stage => (
          <Box key={`stage-${stage.no}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={GLYPH_COLOR[stage.state]}>{GLYPH[stage.state]}</Text>
              <Text bold={stage.state === 'current'} dimColor={stage.state === 'todo'}>{`${stage.no} ${stage.name}`}</Text>
            </Box>
            <Text dimColor wrap="wrap">{`${DETAIL} ${stage.summary}`}</Text>
          </Box>
        ))}
        {v.playback === 'error' && (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text color="error" wrap="wrap">{`${DETAIL} ${v.playbackNote}`}</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Decisions</Text>
        {v.decisions.length === 0 && <Text dimColor wrap="wrap">{`${DETAIL} The decisions appear once the brief plays back.`}</Text>}
        {v.decisions.map((row, i) => (
          <Box key={`decision-${i}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text dimColor wrap="wrap">{row.decision}</Text>
            <Text wrap="wrap">{row.value}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Checks</Text>
        {v.checks === '' && <Text dimColor wrap="wrap">{`${DETAIL} The checks appear once the brief plays back.`}</Text>}
        {v.checks !== '' && (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text color={v.failing.length > 0 ? 'error' : 'success'} wrap="wrap">{`${v.failing.length > 0 ? '✘' : '✔'} ${v.checks}`}</Text>
          </Box>
        )}
        {v.failing.map((line, i) => (
          <Box key={`fail-${i}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text color="error" wrap="wrap">{`${DETAIL} ${line}`}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Brands</Text>
        {v.brands === '' && <Text dimColor wrap="wrap">{`${DETAIL} The brands appear once the brief plays back.`}</Text>}
        {v.brands !== '' && (
          <Button
            key="brands"
            label={`${v.open.includes('brands') ? '▾' : '▸'} ${v.open.includes('brands') ? 'Hide' : 'Show'} brand details`}
            plain
            onPress={() => act.toggle('brands')}
          />
        )}
        {v.brands !== '' && v.open.includes('brands') && (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Markdown text={v.brands} />
          </Box>
        )}
      </Box>
    </Box>
  )

  const tokensView = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>{`Tokens · ${totalVariables} variables in ${v.tokens.length} collections`}</Text>
        {v.tokensError !== '' && <Text color="error" wrap="wrap">{`${DETAIL} ${v.tokensError}`}</Text>}
        {v.tokens.length === 0 && v.tokensError === '' && (
          <Text dimColor wrap="wrap">{`${DETAIL} The tokens appear once the config plays back.`}</Text>
        )}
        {v.tokens.length > 0 && <Button key="collapse" label="Collapse all" onPress={act.collapse} />}
      </Box>
      {v.tokens.map(c => collection(c))}
    </Box>
  )

  const previewView = v.edit !== null && (
    <Box key="preview" flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="claude" bold>{`Preview · ${v.edit.label}`}</Text>
      {v.edit.ok ? (
        v.edit.diff === '' ? (
          <Text dimColor wrap="wrap">{`${DETAIL} No change to the file.`}</Text>
        ) : (
          <Code source={hunksOnly(v.edit.diff)} format="diff" />
        )
      ) : (
        <Text color="error" wrap="wrap">{`${DETAIL} ${v.edit.error}`}</Text>
      )}
      {v.edit.ok && (
        <Text color={v.edit.failing.length > 0 ? 'warning' : 'success'} wrap="wrap">{`${v.edit.failing.length > 0 ? '●' : '✔'} ${editSummary(v.edit)}`}</Text>
      )}
      <Text dimColor wrap="wrap">{`${DETAIL} Apply rewrites ds.config.yaml in the skill's format. Comments in the file are not kept.`}</Text>
      <Box flexDirection="row" gap={2}>
        {v.edit.ok && <Button key="apply" label="Apply change" variant="primary" onPress={act.apply} />}
        <Button key="discard" label="Discard" onPress={act.discard} />
      </Box>
    </Box>
  )

  // The answers under their interview stage. On the terminal and the desktop each answer is a Button that picks it, and a
  // setting the config lacks is listed under its stage as "(add)". Mobile draws no Button for them, so the answers are
  // text there, and the line below says where to change them.
  const offered = interactive ? pickOptions(v.answers) : pickOptions(v.answers).filter(option => option.value.startsWith('answer:'))
  const groups = pickGroups(offered)

  const answersView = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Your answers</Text>
        {v.answers.length === 0 && <Text dimColor wrap="wrap">{`${DETAIL} Nothing answered yet.`}</Text>}
        {groups.map(group => (
          <Box key={`stage-${group.stage}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text bold wrap="wrap">{`${group.stage} ${group.name}`}</Text>
            {group.options.map(option =>
              interactive ? (
                <Button
                  key={`pick:${option.value}`}
                  label={option.label}
                  {...primaryIf(option.value === v.pick)}
                  onPress={() => act.pick(option.value)}
                />
              ) : (
                <Text key={`pick:${option.value}`} wrap="wrap">{option.label}</Text>
              ),
            )}
            {group.more > 0 && <Text dimColor wrap="wrap">{`${DETAIL} ${group.more} more in ds.config.yaml`}</Text>}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Change an answer</Text>
        {Input === undefined && <Text dimColor wrap="wrap">{`${DETAIL} Pick and change answers on the terminal or the desktop.`}</Text>}
        {Input !== undefined && current === null && <Text dimColor wrap="wrap">{`${DETAIL} Press an answer above to change it.`}</Text>}
        {current !== null && <Text dimColor wrap="wrap">{`${DETAIL} now: ${current.current || 'not set'}`}</Text>}
        {current !== null && Input !== undefined && (
          <Input
            key="value"
            label={`New value for ${current.label}`}
            placeholder="type a value, then press Enter to preview"
            submitLabel="Preview"
            onSubmit={act.preview}
          />
        )}
        {previewView}
      </Box>
    </Box>
  )

  const figmaView = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Variable collections</Text>
        {v.collections.length === 0 && (
          <Text dimColor wrap="wrap">{`${DETAIL} The collections appear once the brief plays back.`}</Text>
        )}
        {v.collections.map((row, i) => (
          <Box key={`collection-${i}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text wrap="wrap">{row.name}</Text>
            <Text dimColor wrap="wrap">{row.modes}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>Into Figma</Text>
        {v.figma.map((line, i) => (
          <Box key={`figma-${i}`} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text dimColor wrap="wrap">{`${DETAIL} ${line}`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )

  const signoffCard = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>Sign-off</Text>
      <Box flexDirection="row" gap={2}>
        {v.hasConfig && <Button key="approve" label="Approve this config" variant="primary" onPress={act.approve} />}
        {canWithdraw && <Button key="withdraw" label="Withdraw" onPress={act.withdraw} />}
        {v.link !== null && <Button key="unlink" label="Unlink Claude Design" plain onPress={act.unlink} />}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={act.refresh} />
      </Box>
      {v.hasConfig && <Text dimColor wrap="wrap">{`${DETAIL} Approve is a button on purpose: nothing signs off by accident.`}</Text>}
    </Box>
  )

  // The link field: the person types a name, or pastes the link of a design system from Claude Design. Nothing is read
  // from the account. On mobile there is no field, so the card says where to link one.
  const linkField = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>Claude Design link</Text>
      <Text dimColor wrap="wrap">{STANDALONE_NOTE}</Text>
      {Input !== undefined ? (
        <Input
          key="system-link"
          label="Name or link"
          placeholder="Paste the link to the design system, or type its name"
          submitLabel="Link"
          onSubmit={act.link}
        />
      ) : (
        <Text dimColor wrap="wrap">{`${DETAIL} Link a design system on the terminal or the desktop.`}</Text>
      )}
    </Box>
  )

  const howItRuns = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>How it runs</Text>
      {STAGE_NAMES.slice(0, 7).map((name, i) => (
        <Box key={`how-${i}`} flexDirection="column" borderStyle="single" paddingX={1}>
          <Text dimColor wrap="wrap">{`${DETAIL} ${i + 1} ${name}`}</Text>
        </Box>
      ))}
      <Text dimColor wrap="wrap">{`${DETAIL} Say "express" in the chat instead if you already have a brand guide or a filled config.`}</Text>
    </Box>
  )

  // The setup flow: a card with the step's title, its lead and a Back button, then the step's own option cards.
  const setupView = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="claude" bold>{SETUP_TITLE[v.setup.step]}</Text>
        <Text dimColor wrap="wrap">{SETUP_LEAD[v.setup.step]}</Text>
        {v.setup.step === 'existing' && <Button key="back" label="‹ Back" plain onPress={() => act.step('choose')} />}
        {v.setup.step === 'new' && <Button key="back-new" label="‹ Back" plain onPress={() => act.step('choose')} />}
      </Box>
      {v.setup.step === 'choose' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text color="claude" bold>Use an existing design system</Text>
            <Text dimColor wrap="wrap">{`${DETAIL} From your Claude Design account. Paste its link to link it to this project.`}</Text>
            <Button key="go-existing" label="Use an existing design system   ›" onPress={() => act.step('existing')} />
          </Box>
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text color="claude" bold>Create a new design system</Text>
            <Text dimColor wrap="wrap">{`${DETAIL} The interview runs in this chat. Nothing is built until you sign off.`}</Text>
            <Button key="go-new" label="Create a new design system   ›" variant="primary" onPress={() => act.step('new')} />
          </Box>
        </Box>
      )}
      {v.setup.step === 'existing' && linkField}
      {v.setup.step === 'new' && howItRuns}
    </Box>
  )

  // The interview, in one card. While it runs: the line that says so, with a Stop button. Once the design system is
  // complete, the line that sends the person to the sign-off card, with no Start button. Otherwise: a Start button that
  // puts the request in the prompt box. Only one is ever drawn.
  const interviewControl = (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="claude" bold>Interview</Text>
      {v.interview ? (
        <Box flexDirection="row" gap={2}>
          <Text color="claude">{`${MARK} The interview runs in this chat.`}</Text>
          <Button key="stop-interview" label="Stop the interview" plain onPress={act.stopInterview} />
        </Box>
      ) : complete ? (
        <Text color="success" wrap="wrap">Review the brief and approve it in the sign-off card below</Text>
      ) : (
        <Button
          key="start-interview"
          label="Start the interview in the chat"
          {...primaryIf(!hasDesign)}
          onPress={act.startInterview}
        />
      )}
    </Box>
  )

  const body = v.tab === 'tokens' ? tokensView : v.tab === 'answers' ? answersView : v.tab === 'figma' ? figmaView : overview

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {header}
      {hasDesign && tabs}
      {hasDesign ? body : setupView}
      {(hasDesign || v.setup.step === 'new') && interviewControl}
      {hasDesign && signoffCard}
      {!hasDesign && (
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={act.refresh} />
        </Box>
      )}
    </Box>
  )
}
