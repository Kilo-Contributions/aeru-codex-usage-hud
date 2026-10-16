# Workglass: Aeru usage-summary adapter (experimental)

[Msg⛛{AERU-WORKGLASS-EXPERIMENT-20261016}]

This experiment is **not** part of Aeru upstream and is **not enabled**
by its local HTTP server. It is a deterministic, read-only function that
normalizes an in-memory `scanCodexUsage()` result. It does not connect to
OpenAI, Claude, Copilot, Ollama, a fleet bus or any cloud service.

## Use

```js
const { scanCodexUsage } = require('../../usage');
const { normalizeAeruSummary } = require('./normalize-aeru');
const localSummary = await scanCodexUsage({ codexDir: '/PATH/TO/TEST_HISTORY' });
const observation = normalizeAeruSummary(localSummary);
```

By default the module makes **no file, HTTP, database or network writes**.
If the caller chooses to persist or transmit the returned object, that is a
separate, authorization- and privacy-sensitive operation.

## Evidence and interpretation

- Source: `LOCAL_CLI_HISTORY_SUMMARY` with `authenticated=false`.
  Aggregated counts represent the local scanner's findings, not provider-signed
  invoices or externally authenticated telemetry.
- Model identity: `null`. The scanner assigns a whole session to its last
  observed `turn_context.model`; this is insufficient to establish
  per-model usage if a session switches models.
- Costs: `billedUsd=null`; an optional estimated API-equivalent USD value is
  clearly separate, and absent values remain `null`, **not zero**.
- Causal effect, task outcomes, operator time and "tokens saved":
  `null` / `NOT_ESTABLISHED`. Those need matched tasks, provider receipts,
  independent correctness checks, and measurements of the complete workflow.
- Privacy: reports only aggregated numeric counters and aggregate scan counts.
  No raw file paths, project names, session IDs, model names, prompts, command
  text, tokens or local history records cross the adapter boundary.

This **does not** provide Claude, Copilot or local model adapters yet.
Future provider adapters must produce the same minimum measurement quality and
preserve provider-specific cost semantics (subscription quota, billed API
usage, local compute); they must not manufacture token savings.

## Validation

```sh
node --test test/workglass-normalize.test.js
npm run check
```

Fixtures cover private project/token canaries, invalid counters, missing cost,
and an actual local scanner invocation over synthetic history. CI should
validate Linux and Windows before any promotion. Source and experimental
branches intentionally remain separate from the targeted upstream Codex
parser contribution.
