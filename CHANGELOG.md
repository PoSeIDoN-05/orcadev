# Changelog

## 0.3.0

- Public release preparation.
- Removed OAuth-token support and the automatic reading of other tools' token files (`~/.claude-oauth-token`, `~/.claude-nl-token`). Only an Anthropic API key (SecretStorage or `ANTHROPIC_API_KEY`) is used.
- User interface, commands, settings descriptions and messages translated to English; README is English with a Russian section.
- Extension is disabled in untrusted and virtual workspaces.
- Added marketplace metadata (publisher, repository, keywords, PNG icon) and a changelog.

## 0.2.0

- Renamed from "Claude Code Lite" to OrcaDev (new extension id, command and setting prefixes `orcaDev.*`).

## 0.1.0

- First working version: chat panel, agent loop, six tools, approvals with diff preview.
