# neo-agent Development Plan

This document tracks ongoing development status, priorities, and decisions. Update it before or during every meaningful feature change so the repository remains easy to resume.

## Current Status

Last updated: 2026-05-24

The project is an MVP terminal AI agent with:

- CLI entrypoint: `neo`
- Terminal REPL with slash commands
- DeepSeek main/small text model routing
- MiMo vision pre-analysis for image inputs
- Local memory with OpenViking retrieval fallback
- Skill discovery and auto-creation scaffold
- MCP stdio server connection scaffold
- Focused sub-agent runner
- JSONL logging system for debugging
- GitHub sync on `main`

## Development Rules

- Keep `DEVELOPMENT_PLAN.md` current when adding, removing, or reprioritizing work.
- Keep secrets out of git. API keys belong in `~/.neo-agent/config.json` or environment variables.
- Run `npm run typecheck` and `npm run build` before committing.
- Push completed commits to `origin/main` unless a branch is explicitly needed.
- Do not commit `node_modules/`, `dist/`, `.env`, local screenshots, or temporary skill experiments.

## Near-Term Milestones

### M1: Reliable Personal Agent Core

Status: in progress

- [x] Create TypeScript CLI project
- [x] Register simple `neo` startup command
- [x] Configure DeepSeek and MiMo model clients
- [x] Implement text/image model routing
- [x] Add local memory storage
- [x] Add OpenViking retrieval fallback
- [x] Add skill manager scaffold
- [x] Add MCP manager scaffold
- [x] Add sub-agent runner
- [x] Add JSONL logging
- [ ] Add conversation transcript persistence
- [ ] Add config validation command: `neo doctor`
- [ ] Add log rotation and retention policy
- [ ] Add smoke tests for CLI commands

### M2: Better Memory and Personalization

Status: planned

- [ ] Define memory schema for preferences, project facts, workflows, and sessions
- [ ] Add explicit memory commands: update, delete, pin, export
- [ ] Improve relevance scoring beyond simple keyword search
- [ ] Integrate OpenViking write path once local service contract is confirmed
- [ ] Add memory review flow to prevent low-value or wrong memories

### M3: Skill Lifecycle

Status: planned

- [ ] Add `neo skill list/show/edit/delete`
- [ ] Track skill usage counts and success signals
- [ ] Improve auto-skill creation criteria
- [ ] Add skill update suggestions after repeated similar tasks
- [ ] Separate global user skills from project-local skills

### M4: Tooling and MCP Execution

Status: planned

- [ ] Add safe tool-call protocol around MCP tool execution
- [ ] Add permission prompts for risky tools
- [ ] Add MCP config commands: add, remove, list, test
- [ ] Add tool result logging with redaction
- [ ] Add project-aware filesystem tool support

### M5: Terminal UX Parity with CC-Source Ideas

Status: planned

- [ ] Add richer TUI rendering for messages
- [ ] Add input history and multiline editing
- [ ] Add interrupt/cancel behavior
- [ ] Add status line with model, memory hits, and log path
- [ ] Add compact debug view for routing and retrieved context

## Backlog

- Add tests around `extractImageAttachments`.
- Add tests for `Logger` redaction.
- Add tests for memory search ranking.
- Add `neo config show --redacted`.
- Add `neo config set` for common settings.
- Add streaming model responses.
- Add retry/backoff around model requests.
- Add request timeout configuration.
- Add model usage/cost tracking.
- Add structured error codes for common setup issues.
- Add release script and versioning policy.

## Decision Log

### 2026-05-24: Start with a custom lightweight CLI instead of directly modifying CC-Source

CC-Source is large and extracted without package metadata. A focused TypeScript CLI lets the project run immediately while preserving room to migrate selected CC-Source terminal UX patterns later.

### 2026-05-24: Use local memory as source of truth first

OpenViking is treated as an optional retrieval backend until the local OpenViking server contract is confirmed. This keeps the agent usable even when OpenViking is not running.

### 2026-05-24: Use JSONL file logging

JSONL is easy to tail, grep, parse, and redact. The logger records operational metadata rather than full prompt payloads by default.

## Resume Checklist

Before starting a new development session:

1. Run `git status --short --branch`.
2. Read this plan's Current Status and Near-Term Milestones.
3. Pick the next unchecked item or add a new one if priorities changed.
4. Make the change.
5. Run `npm run typecheck` and `npm run build`.
6. Update this plan if status changed.
7. Commit and push.

## Open Questions

- What exact OpenViking API surface should be used for durable writes?
- Should project-local skills live under `.neo-agent/skills` or the user's global `~/.neo-agent/skills` by default?
- How much CC-Source UI code should be copied versus reimplemented in a smaller terminal UI layer?
- What is the desired permission model for MCP tools and future filesystem actions?
