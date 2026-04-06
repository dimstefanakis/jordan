# Company Graph Conventions

This document defines the structure, placement rules, and chapter conventions for the company graph.

## Five Families

| Family | Question it answers | Audience |
|--------|---------------------|----------|
| `product/` | What does the system do? | Anyone reasoning about the product |
| `flows/` | How do users move through it? | Anyone reasoning about user experience |
| `concepts/` | What is X and how does it work? | Anyone who needs a canonical definition |
| `operations/` | How do we do internal things? | Operators and internal agents |
| `support/` | How do we help people? | Human and AI support agents |

## Decision Tree

When placing new knowledge, check in this order:

1. Is this about how a user experiences something? → `flows/`
2. Is this about how to respond to someone asking for help? → `support/`
3. Is this a reusable definition referenced from multiple places? → `concepts/`
4. Is this about how to perform an internal procedure? → `operations/`
5. Is this about what the system does or how it is constrained? → `product/`

## Chapter Shape By Family

### product/

```
## What It Is
## How It Works
## Constraints
## Support-Relevant Notes
```

### flows/

```
## Flow Goal
## Steps
## Branches And Edge Cases
## Support-Relevant Truths
```

### concepts/

```
## Definition
## How It Works
## Where It Shows Up
## Disclosure Boundary
```

### operations/

```
## When To Use This
## Prerequisites
## Steps
## What To Verify After
```

### support/playbooks/

```
### Classification
### Customer-Safe Guidance
### Human/Admin Action
### Notes
```

## Durability Boundary

The company graph is for durable knowledge only:

- how the system works
- how to respond to recurring situations
- how to perform repeatable procedures
- canonical concept definitions

The company graph is not for:

- active incidents
- one-off debugging notes
- private brainstorming
- speculative plans

## Frontmatter

Every chapter should include:

```yaml
---
id: kebab-case-unique-id
type: product | flow | concept | operations | support-playbook | support-policy | support-index | index
owner: jordan
status: active | draft | placeholder
last_updated: YYYY-MM-DD
intent_tags: []
related: []
---
```
