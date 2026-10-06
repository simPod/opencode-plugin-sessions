# 0004: pnpm package management and native declaration patches

## Status

Accepted. Requested by the user. Refines the declaration-patch mechanism in
[ADR 0001](0001-file-backed-transcript-archives.md).

## Context

The repository used npm and a postinstall script that patched a hoisted
`@opencode/ai` dependency. The user requested pnpm. Its isolated dependency
layout does not expose undeclared transitive packages at the project root.
Strict library checking still requires the existing SDK declaration fix.

## Decision

Pin pnpm 10.33.3 in `packageManager`, import the npm lockfile, and use the pnpm
lockfile for local installation and CI. CI installs with `--frozen-lockfile` and
keeps the same Node 26 runtime, typecheck, tests, and build.

Use pnpm's version-specific `patchedDependencies` in `pnpm-workspace.yaml` to
apply the existing declaration-only patch to `@opencode/ai@2.0.24`. Keep the
patch contents, remove the hoisting-dependent postinstall script, and do not add
a direct SDK dependency merely to locate its transitive files.

## Consequences

Developers need the pinned pnpm version. Dependency resolution remains locked,
and native patch application is checked during installation. SDK upgrades must
review the patch. Strict compiler settings and plugin behavior are unchanged.
