# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**, or go straight to https://github.com/engramic-ai/claude-plugin/security/advisories/new.

Please include what you found, the steps to reproduce it, the plugin version (in `plugins/engramic/.claude-plugin/plugin.json`) and your Claude Code version. We will acknowledge your report and tell you what we decide.

## Scope

This policy covers the code in this repository: the hook (`plugins/engramic/hooks/engramic-hook.mjs`), the setup scan (`plugins/engramic/skills/setup/scan.mjs` and `workspace.mjs`), the skills and the manifests.

Problems with the Engramic service or its MCP server are outside this repository. Contact Engramic through https://engramic.ai.

## Supported versions

Only the latest published version is supported.
