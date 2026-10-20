---
name: ui-spec-enforcer
description: Treat the supplied UI specification as the source of truth and implement or verify layout, navigation, components, styling, responsive behavior, states, accessibility, and visual consistency without inventing conflicting UI.
---

# ui-spec-enforcer

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

## UI specification rules

Look for `UI_SPEC.md`, `UI-INSTRUCTIONS.md`, `DESIGN_SPEC.md`, project documentation, or the specification supplied in the task.

Verify page structure, navigation, spacing, typography, colors, borders, shadows, components, responsive behavior, required labels/controls, states, accessibility, and consistency. Do not replace the specification with personal design preferences. Document conflicts and changes.
