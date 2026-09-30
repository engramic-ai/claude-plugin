# claude-plugin

Claude Code plugins for working with [Engramic](https://engramic.ai).

## engramic

Records key decisions and milestones from Claude Code sessions to Engramic over MCP, and audits a repo's Engramic setup. See [plugins/engramic/README.md](plugins/engramic/README.md) for how it works.

Requires the Engramic MCP server to be connected in Claude Code.

### Install

    /plugin marketplace add engramic-ai/claude-plugin
    /plugin install engramic@engramic-ai

### Where it runs

| Surface | Skills | Hooks | Setup scan | Status |
|---|---|---|---|---|
| Claude Code (terminal, VS Code, desktop app Code tab) | Yes | Yes | Yes | Tested. Needs Node 20 or later on the machine. |
| Claude Desktop Chat tab, claude.ai | `record` only, with the Engramic connector on | No (hooks run in Cowork and Claude Code, not chat) | No (needs a local repo) | From the docs, untested |
| Cowork | Yes | Documented, but unverified: a reported issue says plugin hooks did not fire on Windows, and Node availability in the Cowork VM is unknown | Unverified | Untested |

The value of the plugin is in Claude Code. Elsewhere, expect the recording skill and little else.

### Develop

    claude --plugin-dir ./plugins/engramic
    node --test plugins/engramic/test/hook.test.mjs plugins/engramic/test/scan.test.mjs plugins/engramic/test/workspace.test.mjs

The hooks and the setup scan are deterministic and tested. The skills' judgement is Markdown, tested by use: run `engramic:setup` in a real repo and see what it finds.

## Licence

MIT licence, copyright Engramic Ltd (see [LICENSE](LICENSE)). The licence covers this code, not the ENGRAMIC name or logo, which are trademarks. You can use, modify and share the code; please don't use the name to suggest your fork is the official plugin.

## Layout

    .claude-plugin/marketplace.json     marketplace manifest
    plugins/engramic/                   the plugin
      .claude-plugin/plugin.json
      hooks/                            hook config and the Node shim
      skills/record, skills/setup        (setup includes scan.mjs)
      config.json                       milestone and decision-phrase rules
      test/                             node:test suites for the hook shim and the scan
