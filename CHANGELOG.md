# Changelog

All notable changes to WebBrain are documented in this file.

This changelog was generated from the repository Git history and release tags. Versions without a Git tag are inferred from version-bump commits and the current `package.json` / browser manifest versions.

## [23.0.0] - 2026-07-12

### Added
- Added subscription resume action, including scheduled resume task detection, mode sync before resume, and render subscription actions for restored runs.

### Changed
- Injected trusted runtime clock into agent runs for reliable scheduling.
- Kept runtime context out of planner history and stripped runtime context from derived task state.
- Preserved mode for subscription error resumes.

## [22.4.0] - 2026-07-11