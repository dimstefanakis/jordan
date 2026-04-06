# Jordan

Jordan is a general-purpose assistant starter built around a small, hackable orchestration layer:

- `Jordan` as the main assistant
- `Atlas` as the company-graph maintainer
- `Reflect` as the background memory consolidator
- a neutral `docs/company-graph/` scaffold you can adapt to your product or organization

It keeps the container-isolated execution model, per-group memory, scheduler, and Slack support from the original project, while removing the previous domain-specific custom layer.

## What’s Included

- container-isolated agent execution
- per-group `CLAUDE.md` memory
- shared global memory
- scheduled tasks
- Slack channel support
- manual company-graph maintenance through Atlas
- a starter company-graph taxonomy: `product`, `flows`, `concepts`, `operations`, `support`

## What Was Removed

- previous domain-specific support guidance and docs
- BERT and the commit-watcher pipeline
- Gmail triage extension and bridge
- domain-specific internal-data skill
- external watched-repo assumptions

## Quick Start

```bash
cd jordan
npm install
claude
```

Then run `/setup`.

## Suggested First Customizations

1. Rewrite `docs/company-graph/product/overview.md` for your actual domain.
2. Add your first real flow doc in `docs/company-graph/flows/`.
3. Update `groups/main/CLAUDE.md` with the tone and policies you want Jordan to follow.
4. Add any raw notes or imported docs to `groups/main/knowledge/`, then normalize them into the company graph.

## Key Files

- `src/index.ts` - main orchestrator
- `src/container-runner.ts` - container execution
- `src/ipc.ts` - task and tool IPC
- `src/reflect.ts` - background memory maintenance
- `src/company-graph-maintainer.ts` - Atlas company-graph updates
- `groups/main/CLAUDE.md` - Jordan's main prompt
- `groups/global/CLAUDE.md` - shared memory
- `docs/company-graph/` - canonical documentation layer

## Notes

This repo is intentionally a starter. The company graph is mostly placeholder structure so you can adapt it to your own product instead of inheriting someone else's domain knowledge.
