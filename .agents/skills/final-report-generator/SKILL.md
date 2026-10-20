---
name: final-report-generator
description: Create or update REPORT.md from actual inspection, build, test, debugging, UI, API/database, security, and regression evidence. Never invent successful tests; clearly mark PASS, FAIL, BLOCKED, or NOT RUN.
---

# final-report-generator

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

## REPORT.md contract

Create `REPORT.md` with: Executive Summary; Repository/Architecture Inspection; Requirements/UI Specification; Implementation Changes; Build and Static Verification; Browser/Functional Testing; UI Verification; API/Database Verification; Debugging/Rebuild History; Security Review; Code Quality Review; Regression Testing; Final Acceptance Matrix; Known Limitations/Remaining Work; Conclusion.

Use tables with Check/Test, Method/Steps, Expected, Actual, Status, Evidence where useful.

### Evidence policy
PASS = actually performed and passed. FAIL = performed and failed. BLOCKED = could not be performed because of a documented blocker. NOT RUN = intentionally not performed. Never convert BLOCKED or NOT RUN to PASS. Never invent screenshots, logs, URLs, coverage, performance numbers, or security results.
