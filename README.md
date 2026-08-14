# qq newspaper

An ambient newspaper for projects linked to qq.

Three scheduled editions share one newsroom:

- hourly checks on the hour and publishes when the previous hour contains commits;
- daily publishes at 05:00 from the previous calendar day;
- weekly publishes Monday at 06:00 from the prior seven daily editions.

The writer chooses the story and may send read-only investigators into linked repositories or the public web. The editor receives the evidence, investigations, and draft. Both run with small replacement system prompts under `prompts/services/`.

Three side-by-side Herdr panes display the current editions. Programmatic lifecycle auditing retains evidence, investigator findings, drafts, final editions, and sanitized event logs for seven days. Model reasoning content is excluded.

## Install

```text
bin/qq-newspaper-install
```

The installer enables the user timers and opens the newspaper tab in the qq Herdr workspace. Repository coverage is configured in `config/newspaper-repositories`.

## Validate

```text
npm test
```
