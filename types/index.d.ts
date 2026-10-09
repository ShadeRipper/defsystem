// The side panel's contract. The hooks modules import its value types from here.

export type SignOff = 'none' | 'current' | 'stale' | 'no-config'

export type Playback = 'none' | 'ok' | 'failing' | 'error'

export type StageState = 'done' | 'current' | 'todo'

// One step of the defining stage. Steps 1 to 6 are the interview; 7 is the playback; 8 and 9 come after sign-off.
export type StageRow = { no: number; name: string; state: StageState; summary: string }

// One answer from ds.config.yaml, filed under the interview stage it belongs to. path is the key path in the file;
// list items are numbered from 0 (brands.0.essence).
export type Answer = { stage: number; label: string; value: string; path: string[] }

// One collection of the token structure, as the decision brief describes it.
export type CollectionRow = { name: string; modes: string; why: string }

export type DecisionRow = { decision: string; value: string }

// A token value as the helper reports it: a literal, or an alias to another variable's path.
export type TokenValue = string | number | boolean | null | { alias: string }

export type TokenVariable = { path: string; type: string; values: Record<string, TokenValue> }

export type TokenCollection = { name: string; modes: string[]; variables: TokenVariable[] }

// The tabs of the panel once a design system exists.
export type Tab = 'stages' | 'tokens' | 'answers' | 'figma'

// The setup flow, shown while there is no design system: choose a start, then link one by its name or link, or create one.
export type SetupStep = 'choose' | 'existing' | 'new'

// A design system row. No list is read any more (standalone design systems are not visible to the chat), so the
// systems field, its status and its note stay in the state for compatibility and are always empty.
export type DesignSystemRow = { id: string; title: string; url: string }

export type SystemsStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

export type SetupState = {
  step: SetupStep
  systems: DesignSystemRow[]
  systemsStatus: SystemsStatus
  systemsNote: string
  selected: string
}

// The Claude Design design system this project is linked to: ds-design-system.json in the project folder. The title is
// the name the person typed, or the last segment of the pasted link; url is the pasted link, or empty for a name only.
export type DesignSystemLink = { title: string; url: string; linkedAt: string }

// A change the person previewed and may apply. yaml is the whole new file; base is the file it was made from.
export type EditState = {
  path: string[]
  label: string
  kind: string
  text: string
  ok: boolean
  error: string
  diff: string
  yaml: string
  failing: string[]
  base: string
}

export type PanelView = {
  folder: string
  signoff: SignOff
  approvedAt: string | null
  hasConfig: boolean
  link: DesignSystemLink | null
  setup: SetupState
  stages: StageRow[]
  answers: Answer[]
  collections: CollectionRow[]
  decisions: DecisionRow[]
  brands: string
  checks: string
  failing: string[]
  playback: Playback
  playbackNote: string
  figma: string[]
  tab: Tab
  tokens: TokenCollection[]
  tokensError: string
  open: string[]
  pick: string
  edit: EditState | null
  message: string
  // True while the skill's interview runs in this chat: its text is then in the system prompt.
  interview: boolean
  fingerprint: string
}

declare module 'claude-code' {
  interface PluginState {
    'defsystem': {
      view: PanelView
      // Whether the "could not register /defsys" line was written this session.
      noted: boolean
    }
  }
}
