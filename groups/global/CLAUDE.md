# Jordan Shared Memory

This file is the shared memory layer used across Jordan's assistant surfaces.

## Purpose

Use shared memory for:

- stable facts about your organization, product, or workflows
- reusable tone, preferences, and conventions
- cross-surface guidance that should help in more than one group

Do not use shared memory for:

- one-off thread context
- temporary incidents or debugging notes
- secrets or highly sensitive heuristics

## Company Graph Relationship

The company graph at `/workspace/project/docs/company-graph/` is the canonical documentation layer.

- Put canonical product and workflow knowledge in the company graph.
- Put concise reminders, conventions, and reusable preferences here.
- If the graph is missing something durable, ask Atlas to update it instead of duplicating long explanations here.

### Reflect Notes

This block is maintained by the background Reflect process. Keep edits concise and durable.

<!-- REFLECT:START -->

- No background-maintained shared notes yet.
<!-- REFLECT:END -->
