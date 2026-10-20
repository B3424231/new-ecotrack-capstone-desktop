---
name: web-app-builder
description: Inspect an existing web project and implement or modify its frontend, backend, database integration, APIs, authentication, and configuration while preserving working behavior and avoiding unnecessary rewrites.
---

# web-app-builder

## Operating rules

1. Inspect the existing repository before changing files.
2. Identify the framework, package manager, entry points, scripts, environment configuration, database/API architecture, and existing tests.
3. Preserve working behavior. Prefer minimal, targeted changes over unnecessary rewrites.
4. Reuse existing components, utilities, styles, services, and dependencies when appropriate.
5. Do not invent files, commands, test results, screenshots, URLs, credentials, or runtime evidence.
6. Never claim a test passed unless it was actually run and observed.
7. If a required tool, server, credential, dependency, or environment is unavailable, mark the result as BLOCKED and explain the exact blocker.
8. After meaningful changes, run the narrowest relevant checks first, then broader regression checks.
9. Keep changes compatible with the project's existing architecture unless the requested work explicitly requires an architectural change.
10. Report concrete file paths and observable outcomes when summarizing work.

## Implementation workflow

- Detect the framework and package manager from existing files.
- Read relevant source before modifying it.
- Trace UI -> state/service -> API -> database paths before implementation.
- Follow established project patterns.
- Run existing formatting, lint, type-check, test, and build commands.
- Do not add dependencies when an existing solution is suitable.
