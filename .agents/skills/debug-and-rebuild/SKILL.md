---
name: debug-and-rebuild
description: Reproduce application failures, identify root causes, make the smallest safe fix, rebuild or restart when required, and retest the affected and related flows until the issue is fixed or clearly blocked.
---

# debug-and-rebuild

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

## Debug loop

For each failure: reproduce -> capture exact error -> trace root cause -> make smallest safe correction -> run relevant checks -> restart/rebuild if needed -> reproduce again -> regression test. Avoid symptom-only patches when the root cause can be safely identified.
