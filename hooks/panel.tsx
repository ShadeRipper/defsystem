// The defsys side panel. With no design system it is a setup flow, in the order Claude Design uses: choose a start,
// then link a Claude Design design system by its name or its link, or create a new one. With one, it is four tabs and
// a sign-off card.
//
// The look follows Claude Code's own interface: quiet, with one accent. The ✻ mark and the current stage are the only
// things drawn in the accent colour. A card has a round border in the prompt-box colour, a bold title and dim secondary
// text; the sign-off card and the updater above the chat borrow their border colour from their state. Items inside a
// card are rows, not boxes: nothing is boxed inside a box, and a list is separated by space. A token group is
// indented under its parent. Marks are Claude Code's own: ✻ ❯ ⎿ ✔ ●. Colours are theme keys, so the panel follows
// the terminal and the desktop theme. Swatches are the one exception: they show the colour.
//
// Option-list limit: the engine refuses a Select with more than 64 options ("Select pick options must be 1 to 64
// entries"). When it refuses a tree, it draws its own version of the whole pane, so the tabs disappear and the person
// cannot get back. A real config can have more than 64 answers, so the Answers tab draws a Button per
// answer, grouped under its interview stage, at most 40 Buttons to a stage. Never use a Select, or any element with an
// option list that could be longer than 64 entries, and keep every list in this file within those limits.
import type { EngineInterface } from 'claude-code'

import type { ImproveStep, PanelView, SetupStep, SignOff, StageState, Tab, TokenCollection } from '../types'
import {
  countLeaves,
  editSummary,
  hunksOnly,
  improveStatus,
  indexVariables,
  inventoryLine,
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
  // "Improve a Figma design system file": start or re-check, give the link, ask Claude again, stop (disconnect), link the
  // project to the file that was read, and put the improvement request in the prompt box.
  improveStart: () => unknown
  improveLink: (text: string) => unknown
  improveAsk: () => unknown
  improveStop: () => unknown
  improveConnect: () => unknown
  improveWith: () => unknown
}

export type ImproveActions = Pick<
  Actions,
  'improveStart' | 'improveLink' | 'improveAsk' | 'improveStop' | 'improveConnect' | 'improveWith'
>

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const MARK = '✻'
const DETAIL = '⎿'
const LINKED = '↗'
const MARKER = '│'
const TREE_LIMIT = 200

// The border of a card at rest: the colour of the prompt box, so the panel sits quietly beside the chat.
const LINE = 'promptBorder'
// A card: a round border in that colour, one cell of padding at the sides. Spread onto a Box.
const CARD = { flexDirection: 'column', borderStyle: 'round', borderColor: LINE, paddingX: 1 } as const
// A Box that holds a list of rows inside a card, indented under a heading.
const INDENT = { flexDirection: 'column', paddingLeft: 2 } as const
const LABEL_WIDTH = 18

const IMPROVE_TITLE = 'Improve a Figma design system file'
const IMPROVE_LABEL: Record<ImproveStep, string> = {
  off: `${IMPROVE_TITLE}   ›`,
  connect: 'Connect Figma to continue',
  link: 'Waiting for the Figma link',
  reading: 'Reading the file…',
  connected: 'Connected',
}
const FIGMA_LINK_PLACEHOLDER = 'https://www.figma.com/design/…'
const HEX = /#[0-9a-fA-F]{6}\b/

// The updater above the chat for the Figma option. Null while the option is off, so the band draws nothing for it. It
// asks for what is missing, in order: the Figma connection, then the file's link; then it waits for Claude to read
// the file; and last it shows the file's counts and a Connected button. It is drawn in the band, so it holds only a few
// rows: a title, one line, the field and the buttons. Its border says what it wants: the accent when it asks the
// person for something, the prompt colour while Claude works, green once the file is connected.
export function improveUpdater(els: Elements, v: PanelView, act: ImproveActions) {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const im = v.improve
  if (!im.busy && im.step === 'off') return null
  const tone = im.busy || im.step === 'reading' ? LINE : im.step === 'connected' ? 'success' : 'claude'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="claude" bold>{`${MARK} defsys`}</Text>
        <Text dimColor>{`· ${IMPROVE_TITLE}`}</Text>
      </Box>
      {im.busy ? (
        <Text dimColor wrap="wrap">{`${DETAIL} Loading… checking the Figma connection.`}</Text>
      ) : im.step === 'connect' ? (
        <Box flexDirection="column">
          <Text color="warning" wrap="wrap">Figma is not connected to this chat.</Text>
          <Text dimColor wrap="wrap">{`${DETAIL} ${improveStatus(im)}`}</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="band-check" label="Check again" onPress={act.improveStart} />
            <Button key="band-cancel" label="Cancel" plain onPress={act.improveStop} />
          </Box>
        </Box>
      ) : im.step === 'link' ? (
        <Box flexDirection="column">
          <Text wrap="wrap">Paste the link of the Figma file to improve.</Text>
          {Input !== undefined ? (
            <Input
              key="band-link"
              label="Figma file link"
              placeholder={FIGMA_LINK_PLACEHOLDER}
              submitLabel="Read the file"
              onSubmit={act.improveLink}
            />
          ) : (
            <Text dimColor wrap="wrap">{`${DETAIL} Paste the link in the chat box and press Enter.`}</Text>
          )}
          <Button key="band-cancel" label="Cancel" plain onPress={act.improveStop} />
        </Box>
      ) : im.step === 'reading' ? (
        <Box flexDirection="column">
          <Text wrap="wrap">{`Claude is reading ${im.file?.title ?? 'the file'} in the chat…`}</Text>
          <Text dimColor wrap="wrap">{`${DETAIL} The details appear here when Claude has written ds-figma-inventory.json.`}</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="band-ask" label="Ask again" onPress={act.improveAsk} />
            <Button key="band-cancel" label="Cancel" plain onPress={act.improveStop} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="success" wrap="wrap">{`✔ ${im.inventory?.fileName ?? 'Figma file'} · ${im.inventory ? inventoryLine(im.inventory) : ''}`}</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="band-connected" label="Connected" variant="primary" onPress={act.improveConnect} />
            <Button key="band-disconnect" label="Disconnect" plain onPress={act.improveStop} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

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

// The sign-off card's border: green while the sign-off holds, amber while it lapsed, the prompt colour otherwise.
const SIGNOFF_TONE: Record<SignOff, string> = { none: LINE, current: 'success', stale: 'warning', 'no-config': LINE }

const GLYPH: Record<StageState, string> = { done: '✔', current: '❯', todo: '◦' }
const GLYPH_COLOR: Record<StageState, string> = { done: 'success', current: 'claude', todo: 'subtle' }
const DOT: Record<StageState, string> = { done: '●', current: '●', todo: '○' }

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
  const current = resolvePick(v.answers, v.pick)
  const totalVariables = v.tokens.reduce((sum, collection) => sum + collection.variables.length, 0)
  const complete = v.hasConfig && v.stages.every(stage => stage.state === 'done')

  // A card's top row: its title in bold, and a short dim hint at the right.
  const heading = (title: string, hint?: string) => (
    <Box flexDirection="row" justifyContent="space-between" gap={2}>
      <Text bold>{title}</Text>
      {hint !== undefined && <Text dimColor>{hint}</Text>}
    </Box>
  )

  // A line of dim secondary text under a heading, with the ⎿ mark Claude Code puts under a result.
  const note = (text: string, color?: string) =>
    color === undefined ? <Text dimColor wrap="wrap">{`${DETAIL} ${text}`}</Text> : <Text color={color} wrap="wrap">{`${DETAIL} ${text}`}</Text>

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

  // A group of the token tree: its button, then, once it is open, its own leaf and its children, indented one step. A
  // node with no children is a leaf, and is drawn as a marker row.
  const branch = (node: TreeNode) => {
    if (node.children.length === 0) return leafRow(node)
    const isOpen = v.open.includes(node.key)
    return (
      <Box key={`box:${node.key}`} flexDirection="column">
        <Button
          key={node.key}
          label={`${isOpen ? '▾' : '▸'} ${node.name} · ${countLeaves(node)}`}
          plain
          onPress={() => act.toggle(node.key)}
        />
        {isOpen && (
          <Box {...INDENT}>
            {node.leaf !== null && leafRow(node)}
            {node.children.slice(0, TREE_LIMIT).map(child => branch(child))}
          </Box>
        )}
      </Box>
    )
  }

  // One collection of the token structure: a card whose one button opens its tree.
  const collection = (c: TokenCollection) => {
    const tree = treeOf(c)
    const isOpen = v.open.includes(tree.key)
    return (
      <Box key={`box:${tree.key}`} {...CARD}>
        <Button
          key={tree.key}
          label={`${isOpen ? '▾' : '▸'} ${c.name} · ${countLeaves(tree)} tokens · ${c.modes.join(', ')}`}
          plain
          onPress={() => act.toggle(tree.key)}
        />
        {isOpen && <Box {...INDENT}>{tree.children.map(child => branch(child))}</Box>}
      </Box>
    )
  }

  // The stages as dots, one each: green when done, the accent for the one in progress, an open circle when not begun.
  const dots = (
    <Box flexDirection="row">
      {v.stages.map(stage => (
        <Text key={`dot-${stage.no}`} color={GLYPH_COLOR[stage.state]}>{DOT[stage.state]}</Text>
      ))}
      <Text dimColor>{` ${done}/${v.stages.length} stages`}</Text>
    </Box>
  )

  // The header is not a card: the mark and the name, the folder (its end is kept when it is long), the sign-off state
  // beside the stage dots, and, under them, the link, the last message and any error.
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color="claude" bold>{`${MARK} defsys`}</Text>
        <Text dimColor>design-system-definer</Text>
      </Box>
      <Text dimColor wrap="truncate-start">{v.folder || 'No project folder'}</Text>
      <Box flexDirection="row" gap={2}>
        {hasDesign ? (
          <Text color={chip.color} bold wrap="wrap">{`● ${chip.text}${v.approvedAt ? ` · approved ${v.approvedAt.slice(0, 10)}` : ''}`}</Text>
        ) : (
          <Text color="warning" bold>● No design system yet</Text>
        )}
        {hasDesign && dots}
      </Box>
      {v.link !== null && (
        <Text color="suggestion" wrap="wrap">{`${LINKED} ${v.link.source === 'figma' ? 'Figma' : 'Claude Design'} · ${v.link.title}`}</Text>
      )}
      {v.message !== '' && note(v.message)}
      {v.tokensError !== '' && note(v.tokensError, 'error')}
    </Box>
  )

  // The tabs are a row of Buttons with no card: the chosen one is the primary Button.
  const tabs = (
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
  )

  // One stage of the defining stage: its mark, its name, and under the name what has been answered.
  const stageRow = (stage: PanelView['stages'][number]) => (
    <Box key={`stage-${stage.no}`} flexDirection="row" gap={1}>
      <Text color={GLYPH_COLOR[stage.state]}>{GLYPH[stage.state]}</Text>
      <Box flexDirection="column" flexShrink={1}>
        <Text bold={stage.state === 'current'} dimColor={stage.state === 'todo'}>{`${stage.no} ${stage.name}`}</Text>
        {stage.state !== 'todo' && stage.summary !== '' && <Text dimColor wrap="wrap">{stage.summary}</Text>}
      </Box>
    </Box>
  )

  // A decision: its name in a dim column, its value beside it.
  const decisionRow = (row: PanelView['decisions'][number], i: number) => (
    <Box key={`decision-${i}`} flexDirection="row" gap={1}>
      <Box width={LABEL_WIDTH}>
        <Text dimColor wrap="wrap">{row.decision}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="wrap">{row.value}</Text>
      </Box>
    </Box>
  )

  const overview = (
    <Box flexDirection="column" gap={1}>
      {!v.hasConfig && (
        <Box {...CARD}>
          {heading('Next')}
          {note('Linked to Claude Design. Start the interview below to write ds.config.yaml.')}
        </Box>
      )}

      <Box {...CARD}>
        {heading('Defining stage', `${done}/${v.stages.length}`)}
        {v.stages.map(stage => stageRow(stage))}
        {v.playback === 'error' && note(v.playbackNote, 'error')}
      </Box>

      <Box {...CARD}>
        {heading('Decisions')}
        {v.decisions.length === 0 && note('The decisions appear once the brief plays back.')}
        {v.decisions.map((row, i) => decisionRow(row, i))}
      </Box>

      <Box {...CARD}>
        {heading('Checks')}
        {v.checks === '' && note('The checks appear once the brief plays back.')}
        {v.checks !== '' && (
          <Text color={v.failing.length > 0 ? 'error' : 'success'} wrap="wrap">{`${v.failing.length > 0 ? '✘' : '✔'} ${v.checks}`}</Text>
        )}
        {v.failing.map((line, i) => (
          <Text key={`fail-${i}`} color="error" wrap="wrap">{`${DETAIL} ${line}`}</Text>
        ))}
      </Box>

      <Box {...CARD}>
        {heading('Brands')}
        {v.brands === '' && note('The brands appear once the brief plays back.')}
        {v.brands !== '' && (
          <Button
            key="brands"
            label={`${v.open.includes('brands') ? '▾' : '▸'} ${v.open.includes('brands') ? 'Hide' : 'Show'} brand details`}
            plain
            onPress={() => act.toggle('brands')}
          />
        )}
        {v.brands !== '' && v.open.includes('brands') && (
          <Box {...INDENT}>
            <Markdown text={v.brands} />
          </Box>
        )}
      </Box>
    </Box>
  )

  const tokensView = (
    <Box flexDirection="column" gap={1}>
      <Box {...CARD}>
        {heading(`Tokens · ${totalVariables} variables in ${v.tokens.length} collections`)}
        {v.tokensError !== '' && note(v.tokensError, 'error')}
        {v.tokens.length === 0 && v.tokensError === '' && note('The tokens appear once the config plays back.')}
        {v.tokens.length > 0 && <Button key="collapse" label="Collapse all" plain onPress={act.collapse} />}
      </Box>
      {v.tokens.map(c => collection(c))}
    </Box>
  )

  // The change the person previewed: a card with the pending-decision border Claude Code gives a request that waits
  // for a yes, the diff, what the checks say, and the two buttons.
  const previewView = v.edit !== null && (
    <Box key="preview" flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
      {heading(`Preview · ${v.edit.label}`)}
      {v.edit.ok ? (
        v.edit.diff === '' ? (
          note('No change to the file.')
        ) : (
          <Code source={hunksOnly(v.edit.diff)} format="diff" />
        )
      ) : (
        note(v.edit.error, 'error')
      )}
      {v.edit.ok && (
        <Text color={v.edit.failing.length > 0 ? 'warning' : 'success'} wrap="wrap">{`${v.edit.failing.length > 0 ? '●' : '✔'} ${editSummary(v.edit)}`}</Text>
      )}
      {note("Apply rewrites ds.config.yaml in the skill's format. Comments in the file are not kept.")}
      <Box flexDirection="row" gap={2}>
        {v.edit.ok && <Button key="apply" label="Apply change" variant="primary" onPress={act.apply} />}
        <Button key="discard" label="Discard" plain onPress={act.discard} />
      </Box>
    </Box>
  )

  // The answers under their interview stage. On the terminal and the desktop each answer is a Button that picks it, and a
  // setting the config lacks is listed under its stage as "(add)". Mobile draws no Button for them, so the answers are
  // text there, and the line below says where to change them. An answer is a plain Button, so a long list reads as a
  // list; the one picked is the primary Button.
  const offered = interactive ? pickOptions(v.answers) : pickOptions(v.answers).filter(option => option.value.startsWith('answer:'))
  const groups = pickGroups(offered)

  const answersView = (
    <Box flexDirection="column" gap={1}>
      <Box {...CARD}>
        {heading('Your answers', v.answers.length > 0 ? `${v.answers.length} set` : undefined)}
        {v.answers.length === 0 && note('Nothing answered yet.')}
        {groups.map((group, g) => (
          <Box key={`stage-${group.stage}`} flexDirection="column" marginTop={g === 0 ? 0 : 1}>
            <Text bold dimColor wrap="wrap">{`${group.stage} ${group.name}`}</Text>
            {group.options.map(option =>
              interactive ? (
                <Button
                  key={`pick:${option.value}`}
                  label={option.label}
                  {...(option.value === v.pick ? { variant: 'primary' as const } : { plain: true as const })}
                  onPress={() => act.pick(option.value)}
                />
              ) : (
                <Text key={`pick:${option.value}`} wrap="wrap">{option.label}</Text>
              ),
            )}
            {group.more > 0 && note(`${group.more} more in ds.config.yaml`)}
          </Box>
        ))}
      </Box>

      <Box {...CARD}>
        {heading('Change an answer')}
        {Input === undefined && note('Pick and change answers on the terminal or the desktop.')}
        {Input !== undefined && current === null && note('Press an answer above to change it.')}
        {current !== null && note(`now: ${current.current || 'not set'}`)}
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

  // The option to improve a Figma file: one card with one Button. Its label follows the flow: the option, Loading, what
  // is missing (Figma, then the link), Reading, and Connected once Claude has read the file. Connected links the project
  // to the file. The link field is here too while the link is asked for.
  const im = v.improve
  const improveCard = (
    <Box {...CARD}>
      {heading(IMPROVE_TITLE)}
      {note(improveStatus(im))}
      <Button
        key="improve"
        label={im.busy ? 'Loading…' : im.step === 'connected' ? `Connected · ${im.inventory?.fileName ?? 'Figma file'}` : IMPROVE_LABEL[im.step]}
        {...primaryIf(im.step === 'connected' && !im.busy)}
        onPress={im.step === 'connected' ? act.improveConnect : act.improveStart}
      />
      {im.step === 'link' && !im.busy && Input !== undefined && (
        <Input
          key="improve-link"
          label="Figma file link"
          placeholder={FIGMA_LINK_PLACEHOLDER}
          submitLabel="Read the file"
          onSubmit={act.improveLink}
        />
      )}
    </Box>
  )

  // What Claude read from the Figma file, as rows, with the three things the person can do next.
  const figmaFileCard =
    im.step === 'connected' && im.file !== null && im.inventory !== null ? (
      <Box {...CARD} borderColor="success">
        {heading('Figma file', `read ${im.inventory.readAt.slice(0, 10)}`)}
        <Text wrap="wrap">{im.inventory.fileName}</Text>
        <Text dimColor wrap="wrap">{im.file.url}</Text>
        <Text dimColor wrap="wrap">{inventoryLine(im.inventory)}</Text>
        {im.inventory.fonts.length > 0 && <Text dimColor wrap="wrap">{`Fonts: ${im.inventory.fonts.join(', ')}`}</Text>}
        {im.inventory.colours.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Colours</Text>
            {im.inventory.colours.map((colour, i) => {
              const hex = HEX.exec(colour)
              return hex === null ? (
                <Text key={`colour-${i}`} dimColor>{colour}</Text>
              ) : (
                <Text key={`colour-${i}`} backgroundColor={hex[0]}>{'   '}</Text>
              )
            })}
          </Box>
        )}
        {im.inventory.notes !== '' && note(im.inventory.notes)}
        <Box flexDirection="row" gap={2}>
          <Button key="improve-with" label="Improve with Claude" variant="primary" onPress={act.improveWith} />
          <Button key="improve-again" label="Read again" onPress={act.improveAsk} />
          <Button key="improve-stop" label="Disconnect" plain onPress={act.improveStop} />
        </Box>
      </Box>
    ) : null

  const figmaView = (
    <Box flexDirection="column" gap={1}>
      {improveCard}
      {figmaFileCard}
      <Box {...CARD}>
        {heading('Variable collections')}
        {v.collections.length === 0 && note('The collections appear once the brief plays back.')}
        {v.collections.map((row, i) => (
          <Box key={`collection-${i}`} flexDirection="row" gap={1}>
            <Box width={LABEL_WIDTH}>
              <Text wrap="wrap">{row.name}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text dimColor wrap="wrap">{row.modes}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Box {...CARD}>
        {heading('Into Figma')}
        {v.figma.map((line, i) => (
          <Text key={`figma-${i}`} dimColor wrap="wrap">{`${DETAIL} ${line}`}</Text>
        ))}
      </Box>
    </Box>
  )

  // The sign-off card: its border is green while the sign-off holds and amber when it lapsed. Approve is the one
  // primary Button, on purpose a button: nothing signs off by accident.
  const signoffCard = (
    <Box {...CARD} borderColor={SIGNOFF_TONE[v.signoff]}>
      {heading('Sign-off', v.approvedAt ? `approved ${v.approvedAt.slice(0, 10)}` : undefined)}
      <Box flexDirection="row" gap={2}>
        {v.hasConfig && <Button key="approve" label="Approve this config" variant="primary" onPress={act.approve} />}
        {canWithdraw && <Button key="withdraw" label="Withdraw" onPress={act.withdraw} />}
        <Button key="refresh" label="Refresh" hotkey="r" plain onPress={act.refresh} />
        {v.link !== null && (
          <Button key="unlink" label={`Unlink ${v.link.source === 'figma' ? 'Figma' : 'Claude Design'}`} plain onPress={act.unlink} />
        )}
      </Box>
      {v.hasConfig && note('Approve is a button on purpose: nothing signs off by accident.')}
    </Box>
  )

  // The link field: the person types a name, or pastes the link of a design system from Claude Design. Nothing is read
  // from the account. On mobile there is no field, so the card says where to link one.
  const linkField = (
    <Box {...CARD}>
      {heading('Claude Design link')}
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
        note('Link a design system on the terminal or the desktop.')
      )}
    </Box>
  )

  const howItRuns = (
    <Box {...CARD}>
      {heading('How it runs')}
      {STAGE_NAMES.slice(0, 7).map((name, i) => (
        <Text key={`how-${i}`} dimColor wrap="wrap">{`${i + 1} ${name}`}</Text>
      ))}
      {note('Say "express" in the chat instead if you already have a brand guide or a filled config.')}
    </Box>
  )

  // The setup flow: the step's title and lead (no card), a Back button, then the step's own option cards.
  const setupView = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{SETUP_TITLE[v.setup.step]}</Text>
        <Text dimColor wrap="wrap">{SETUP_LEAD[v.setup.step]}</Text>
        {v.setup.step === 'existing' && <Button key="back" label="‹ Back" plain onPress={() => act.step('choose')} />}
        {v.setup.step === 'new' && <Button key="back-new" label="‹ Back" plain onPress={() => act.step('choose')} />}
      </Box>
      {v.setup.step === 'choose' && (
        <Box flexDirection="column" gap={1}>
          <Box {...CARD}>
            {heading('Use an existing design system')}
            {note('From your Claude Design account. Paste its link to link it to this project.')}
            <Button key="go-existing" label="Use an existing design system   ›" onPress={() => act.step('existing')} />
          </Box>
          <Box {...CARD}>
            {heading('Create a new design system')}
            {note('The interview runs in this chat. Nothing is built until you sign off.')}
            <Button key="go-new" label="Create a new design system   ›" variant="primary" onPress={() => act.step('new')} />
          </Box>
        </Box>
      )}
      {v.setup.step === 'existing' && linkField}
      {v.setup.step === 'existing' && improveCard}
      {v.setup.step === 'existing' && figmaFileCard}
      {v.setup.step === 'new' && howItRuns}
    </Box>
  )

  // The interview, in one row with no card. While it runs: the line that says so, with a Stop button. Once the design
  // system is complete, the line that sends the person to the sign-off card, with no Start button. Otherwise: a Start
  // button that puts the request in the prompt box. Only one is ever drawn.
  const interviewControl = v.interview ? (
    <Box flexDirection="row" gap={2}>
      <Text color="claude">{`${MARK} The interview runs in this chat.`}</Text>
      <Button key="stop-interview" label="Stop the interview" plain onPress={act.stopInterview} />
    </Box>
  ) : complete ? (
    <Text color="success" wrap="wrap">✔ Review the brief and approve it in the sign-off card below</Text>
  ) : (
    <Button key="start-interview" label="Start the interview in the chat" {...primaryIf(!hasDesign)} onPress={act.startInterview} />
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
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={act.refresh} />
        </Box>
      )}
    </Box>
  )
}
