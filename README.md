# defsystem

Bundles the `design-system-definer` skill (its `defsys` interview and build) and wires it into Claude Code. The mod needs no other plugin. It gives you a side panel to set up or review a design system, an indicator above the chat, read-only tools the model can call, and the sign-off gate. The skill still runs the interview and the build; the mod shows the state, previews changes, and holds the sign-off.

## Keep the separate plugin disabled

If `design-system-definer@shaderipper` is installed, keep it **disabled**. It can own the `defsys` name, and then the typed `/defsys` may reach that plugin instead of this mod. Enabling it is never needed for this mod.

## Install (once)

In Claude Code, install it from the public marketplace:

```
/plugin install defsystem --marketplace ShadeRipper/defsystem
```

## Develop from a local folder

Use a Claude Code build 2.1.293 or later in a terminal. Replace `<path to claude.exe>` with the path to your `claude.exe`, and `<path to the defsystem folder>` with the path to this folder. In PowerShell, run these two commands:

```powershell
& "<path to claude.exe>" plugin marketplace add "<path to the defsystem folder>"
```

```powershell
& "<path to claude.exe>" plugin install defsystem@defsystem
```

## After a change to the folder

Chats load the copy that the install record points to, not the folder. `/reload-plugins` does not switch it. After you edit the mod, raise `version` in `.claude-plugin/plugin.json`, then run this in PowerShell and start a new chat (a chat that is already running keeps the copy it started with):

```powershell
& "<path to claude.exe>" plugin update defsystem@defsystem
```

## What is bundled

- `resources/defsys/` is the skill: `SKILL.md`, `scripts/` (build and checks), `references/`, `templates/`, `presets/`, `examples/`. It is a copy, not a skills folder, so it registers no command of its own.
- `helpers/defsys_helper.py` runs the skill's own code for the panel. It writes nothing into the project.
- If the bundled `scripts/build.py` is missing, the panel says so and the sign-off refuses. Reinstall the mod.

## Commands

The command is `/defsys`. Its typeahead line names the skill and shows no argument hint. Sub-commands follow it as words, and `/defsys help` lists them.

Version history is in [CHANGELOG.md](CHANGELOG.md).

Two names reach the same handler. `/defsystem:defsys` comes from `commands/defsys.md`, which the engine lists when the plugin loads, so it is in the typeahead from the first `/` of a new chat. The bare `/defsys` is registered when the session starts, and a chat resolves it only from its first prompt on. The list shows only `defsystem:defsys`: the bare `/defsys` is hidden from it, but it still runs when typed, from the second prompt on. Type `/defs` in a new chat and pick `defsystem:defsys`.

| Command | What it does |
| --- | --- |
| `/defsys` | Opens the side panel |
| `/defsys overview` or `/defsys stages` | Opens it on the overview |
| `/defsys tokens` | Opens it on the token tree |
| `/defsys answers` | Opens it on your answers, to change them |
| `/defsys figma` | Opens it on the Figma steps |
| `/defsys new` | Opens the setup flow on creating a design system |
| `/defsys existing` | Opens the setup flow on linking a Claude Design design system |
| `/defsys improve` | Starts "Improve a Figma design system file" and says where it stands |
| `/defsys refresh` | Re-reads the project folder |
| `/defsys approve` | Signs the config off (typed by you; Claude cannot approve) |
| `/defsys withdraw` | Withdraws the sign-off |
| `/defsys unlink` | Unlinks this project from Claude Design |
| `/defsys help` | Lists the sub-commands |

The panel opens as soon as the command is entered. The folder is read in the background, and the panel refreshes when it is ready.

## The indicator above the chat

With a design system in the folder, a band above the chat shows `✻ defsys`, the design system's name, its stage count, the sign-off, the failing pairs, and an **Open** button. With no design system, nothing is drawn. The band keeps the drawing of other mods.

## Improve a Figma design system file

In the setup flow, under **Use an existing design system**, and on the Figma tab, the **Improve a Figma design system file** button starts a flow that reads a Figma file through the Figma connector:

1. **Loading.** The button checks whether Figma's tools are among the tools the chat can call.
2. **Connect Figma.** If they are not, a card above the chat says so, with **Check again** and **Cancel**. It rechecks by itself every few seconds. Connecting is done in Settings, under Connectors (or `/mcp` in a terminal); the mod cannot connect Figma for you.
3. **The link.** Once Figma is connected, the card above the chat asks for the file's link, in a field. A Figma link typed in the chat box answers it too.
4. **Reading.** The link goes to `ds-figma.json`, and the mod submits a request that tells Claude to read the file, read-only: its pages, collections, styles and components, and the fonts and colours the skill's `inventory.js` finds. Claude writes what it found to `ds-figma-inventory.json`. Nothing in the Figma file is changed.
5. **Connected.** When that file exists for the same Figma file, the card above the chat shows the counts and a **Connected** button. Pressing it links the project to the Figma file and opens the Figma tab, which shows the file's counts, fonts, colours and notes, with **Improve with Claude** (puts the request in the prompt box), **Read again** and **Disconnect**.

`ds-figma-inventory.json` is written by Claude, so the mod reads it with care: it counts only with a `readAt`, and only for the file that was asked for. **Disconnect** forgets both files.

## The interview

The panel's **Start the interview in the chat** button puts the interview request in the prompt box. Press Enter to send it. While the interview is on, the skill's own text (`SKILL.md`) joins the system prompt for the session, so the model follows the skill. **Stop the interview** removes it. A sign-off that holds ends the interview. When every stage is done, the button is replaced by the line "Review the brief and approve it in the sign-off card below".

If a read of the folder fails, the panel keeps the answers, tokens and collections of the last good read and shows the helper's error under the message line.

## Setting up a design system

With no `ds.config.yaml` and no link, the panel is a setup flow:

1. **Use an existing design system** links a Claude Design design system to this project. You paste its link into the **Name or link** field and press Enter (or type its name, and the name is kept with no link). The link is kept in `ds-design-system.json`. Standalone design systems are not listed: this chat cannot see them, so open the design system in Claude Design settings, copy its link, and paste it there.
2. **Create a new design system** shows how the interview runs. Start puts the request in the prompt box. Nothing is built until you sign off.

Once a link or a config exists, the panel shows four tabs: **Overview**, **Tokens**, **Answers**, and **Figma**, and a sign-off card at the bottom.

## What the model can see

The model does not get the sign-off. It gets three read-only tools, and a short note in the system prompt:

| Tool | What it returns |
| --- | --- |
| `mcp__defsystem__status` | Stages, sign-off, failing contrast pairs, the answers, and the link. It says Claude cannot sign off. |
| `mcp__defsystem__brief` | The decision brief: structure, decisions, checks, brands |
| `mcp__defsystem__preview` | One change to an answer, with its diff and whether the contrast checks still pass. It writes nothing. |

While the sign-off does not hold, each prompt carries a line that says so, so the model knows before it runs a build. The shell guard still refuses `build.py --approve` until the sign-off holds, and nothing the model does can write `ds-signoff.json`.

## The panel

- **Overview:** the nine steps of the defining stage with a progress bar, the decisions, the checks, and the brands (press Brands to open them)
- **Tokens:** every collection as a tree. Press a collection or a group to open it. Colours show a swatch, and an alias shows the colour it resolves to.
- **Answers:** press an answer under its interview stage (or a setting marked "(add)" that you have not set yet), type the new value, press Enter. Each stage draws at most 40 answers; any more are named in a line and stay in `ds.config.yaml`. The panel shows the change as a diff. Apply writes `ds.config.yaml`; Discard drops it. Apply refuses if the config changed after the preview.
- **Figma:** the variable collections and the Figma steps from `ds-out/build-plan.md`
- **Sign-off:** Approve, Withdraw, Unlink and Refresh. Approve is a button on purpose.

## Notes

- Apply rewrites `ds.config.yaml` in the skill's format. Comments in the file are not kept.
- Changing an answer makes an earlier sign-off stale, so approve again after a change. The panel says so in a toast when it happens.
- Approve writes the sign-off record in the project folder. Claude cannot write that record; only the Approve button or `/defsys approve`, typed by you, can.
- A shell command that names the sign-off record is refused, even when it only writes documentation. Use the Write tool for documentation that mentions the record.
- Linking to Claude Design attaches the design system to the project. It does not copy its tokens into `ds.config.yaml`; the skill's interview still builds the config.
- If `/defsys` is refused as a name by the engine, the mod still answers the typed name through the canonical `design-system-definer:defsys`. The reason for a refused registration is written once per session to the transcript as `defsys: could not register /defsys: <reason>`.
- With the separate plugin enabled, its own `/design-system-definer:defsys` would also be answered by this panel. That is one more reason to keep the separate plugin disabled.

## License

defsystem is licensed under the Apache License 2.0 (see `LICENSE`). It bundles the `design-system-definer` skill in `resources/defsys`, which is MIT licensed (see `resources/defsys/LICENSE`). The vendored PyYAML in `resources/defsys/scripts/_vendor` is MIT licensed (see `resources/defsys/scripts/_vendor/PyYAML-LICENSE.txt`). `NOTICE` gives the copyright lines.
