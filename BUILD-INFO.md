# Build and verification information

Build date: 2026-10-02
Version: 0.2.0
Source baseline: confirmed complete 0.1.4.1 release archive
Node.js used for local verification: v24.16.0
State schema: 2
History schema: 2
Observation schema: `shelly-admin.observation/2`

Completed checks:

- dependency-free source/JSON lint: passed (56 source files and JSON examples validated before packaging);
- Node.js test runner: 80 passed, 0 failed;
- experimental coverage: 85.27% lines, 69.03% branches, 86.78% functions;
- 0.1.x config migration, including `firmwareCheckTimeoutMs: ""` to 2500: passed;
- state-schema migration with section isolation and inventory preservation: passed;
- recovery/error open-repeat-clear lifecycle and resolved-error persistence: passed;
- sparse raw history, aggregate coverage, retention, sample and byte compaction: passed;
- synthetic 20-day aggregate baseline continuity across export/import: passed;
- median/MAD/percentiles, warm-up, isolated peaks, consecutive trigger/clear and cooldown lifecycle: passed;
- conservative peer grouping and insufficient-group behavior: passed;
- simultaneous fleet latency degradation/network-factor annotation: passed;
- temperature trend/load context and separate static safety classification: passed;
- expected/unexpected restart history and repeated-unexpected pattern: passed;
- RAM/filesystem missing-value behavior and sustained resource trends: passed;
- zero-power suppression, voltage rules, repeated energy-counter decrease and derived energy-rate logic: passed;
- monitor current/transitions/both filtering and legacy three-output registration: passed;
- exact 5000 ms firmware timeout propagation, per-device error continuation and lock release regressions: passed;
- Stable-only/Allow-beta policy, Gen1–Gen4 normalization and Context-store behavior: passed;
- English/German locale key parity and guarded runtime/editor translation: passed;
- package/lock/release-note version consistency: passed;
- `npm pack --dry-run`: passed;
- clean offline tarball install and all four Node-RED module registration smoke tests: passed;
- project ZIP and GitHub release ZIP integrity plus external SHA-256 verification: passed.

No hardware-in-the-loop test was run from this build container. The existing 24-device practical-test behavior from 0.1.4.1 is retained by regression tests, but device APIs and firmware vary. Use Stable only, dry-run, backups and a supervised pilot rollout.
