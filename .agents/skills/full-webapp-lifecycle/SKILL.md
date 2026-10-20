---
name: full-webapp-lifecycle
description: Orchestrate a complete web-app lifecycle: inspect the repository, plan, build, run, test, debug, rebuild, verify the UI against the supplied specification, run regression checks, and produce an evidence-based REPORT.md.
---

# full-webapp-lifecycle

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

## Autonomous lifecycle

Execute: inspect -> requirements/UI spec -> plan -> build -> static checks -> start -> browser QA -> debug -> rebuild/restart -> UI verification -> API/database verification -> regression -> security/code review -> final acceptance -> REPORT.md.

Do not stop after a successful build. A successful build is not proof that the app works end-to-end.
