# Changelog

All notable changes to defsystem. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions are those of `.claude-plugin/plugin.json`.

## 0.8.0

### Changed
- **The panel is redrawn in Claude Code's own design language.** Quiet, with one accent.
  - Cards have a round border in the prompt-box colour, a bold title and dim secondary text. The accent colour is only the
    ✻ mark and the stage in progress; card titles are no longer orange.
  - Nothing is boxed inside a box. The stages, decisions, collections and Figma lines are rows; a token group is
    indented under its parent instead of nested in its own border.
  - The header is not a card. It shows the mark, the name, the folder (its end is kept when it is long), the sign-off
    state, and one dot per stage (green done, accent in progress, open not begun) in place of the grey block bar.
  - The tabs sit in a row with no card around them.
  - Answers are plain rows, and the one picked is the primary button. The change preview takes the pending-decision
    border colour that Claude Code uses for a request waiting for a yes.
  - The sign-off card's border shows its state: green while it holds, amber when it lapsed.
  - The interview is one row, not a card.
  - The updater above the chat borders in the accent while it asks for something, in the prompt colour while Claude
    reads, and in green once the file is connected.
- Switching tabs clears the last message line, so an old message no longer stays in the header.

## 0.7.2

### Fixed
- The typeahead shows one `defsys` entry. 0.7.1 hid the bare `/defsys` with a hidden flag, but the app's command list does
  not honour it, so both entries stayed. The mod now registers no command of its own, and `/defsystem:defsys` (from
  `commands/defsys.md`) is the only one.

### Changed
- A bare `/defsys` typed in full is no longer a command of this mod. Type `/defs` and pick `defsystem:defsys`.
- Removed the "could not register /defsys" message and the state it needed.

## 0.7.1

### Changed
- The bare `/defsys` was marked hidden in the typeahead, so a chat's list would show one entry instead of two. The app
  did not honour the flag; 0.7.2 removes the bare command.

## 0.7.0

### Added
- **Improve a Figma design system file.** A new option in the setup flow's existing-design-system step and on the Figma
  tab. It checks that Figma's tools are in the chat, asks for the file's link in the band above the chat (or asks to
  connect Figma first), has Claude read the file read-only, and then shows the file's counts and a **Connected** button.
  - The link is kept in `ds-figma.json`; what Claude read is written to `ds-figma-inventory.json`. The mod accepts the
    inventory only with a `readAt` and only for the file that was asked for.
  - **Connected** links the project to the Figma file and opens the Figma tab, which shows the counts, fonts, colours
    and notes, with **Improve with Claude**, **Read again** and **Disconnect**.
  - The "connect Figma" card rechecks every few seconds, because connectors finish connecting a moment after startup.
  - A Figma link typed in the chat box answers the question too.
- `/defsys improve` starts the flow and says where it stands.
- A design system link now records its source: Claude Design or Figma. The header, the indicator and the Unlink button
  name it.

## 0.6.1

### Fixed
- `/defsys` is in the typeahead from the first `/` of a new chat. A command registered in `session.start` is not listed
  until the chat's first prompt, so the plugin now ships `commands/defsys.md`, which the engine lists when the plugin
  loads as `/defsystem:defsys`. Its run is answered by the same handler as the bare `/defsys`.

## 0.6.0

The first public release. The mod was named defsys-designer before this version; its earlier versions are not part of
this repository's history.

### Added
- Apache License 2.0 for the mod, with `NOTICE`, and the MIT license of the bundled skill kept in `resources/defsys`.
- The marketplace manifest, so the mod installs with `/plugin install defsystem --marketplace ShadeRipper/defsystem`.

### Changed
- Renamed from defsys-designer to **defsystem**: the plugin, its marketplace, its state key and its tool names
  (`mcp__defsystem__status`, `brief`, `preview`).
- The design-system-definer (defsys) skill is bundled in `resources/defsys`, so the mod needs no other plugin.

### Fixed
- The Answers tab no longer comes up empty. The engine refuses a Select with more than 64 options and then draws its own
  pane, which removed the tabs. Answers are Buttons grouped by interview stage, at most 40 to a stage.
- A failed read keeps the last good answers, tokens and Overview, and shows the helper's error.
- The helper reads a config written with a byte order mark.

### The panel, as of this version
- Tabs: Overview, Tokens, Answers and Figma, with a sign-off card; a setup flow to link a Claude Design design system
  by its link or name, or to start the interview for a new one; sections as cards and sub-boxes.
- An indicator above the chat with an Open button, and read-only tools for the model.
- Sign-off: Approve is a button; a shell command or a write that names `ds-signoff.json`, and a build with `--approve`
  before sign-off, are refused.
