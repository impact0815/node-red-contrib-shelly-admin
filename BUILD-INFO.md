# Build and verification information

Build date: 2026-10-03
Version: 0.3.0
Source baseline: complete 0.3.0 project archive; improved before any new commit or version bump
Node.js used for local verification: v24.16.0
npm used for local verification: 11.19.1
State schema: 2
History schema: 2
Observation schema: `shelly-admin.observation/2`
Run lifecycle schema: `shelly-admin.lifecycle/1`

Completed checks:

- dependency-free source/JSON lint: passed (64 source files and JSON examples validated);
- Node.js test runner: 107 passed, 0 failed, 0 skipped, 0 cancelled;
- experimental coverage: 88.68% lines, 67.26% branches, 89.19% functions;
- inherited 0.2.0 discovery, persistence, history, baseline, lifecycle, firmware, recovery, anomaly, Stable/Beta, temperature, Gen1/Gen2+ and migration regressions: passed;
- unified node-specific action validation and unsupported-action errors: passed;
- editor Start/Cancel controls and authenticated deployed-node action endpoint: passed;
- message status, cancel and Monitor enable/disable control: passed;
- discovery cancellation: active HTTP abort, no new targets, completed-probe retention, unprocessed count and no false full-scan completion: passed;
- monitor cancellation: active HTTP abort, completed-data retention, no false unreachable record for unstarted devices and no fleet anomaly evaluation on an incomplete sample: passed;
- maintenance cancellation through the public runtime API, lock release, lifecycle and auditable termination: passed;
- AbortSignal destruction of a live pending HTTP request: passed;
- firmware timeout propagation, per-device continuation, guarded update/reboot, validation and recovery regressions: passed;
- normal 0 W periods, cyclic off/load profiles, first activation after zero history, sustained active-load deviation and correlated electrical de-duplication regressions: passed;
- all-selected firmware pre-check, policy-eligible-only mutation, immediate no-policy-eligible-update skips, candidate-scoped progress and no-wait dry-run planning regressions: passed;
- functional four-tab Monitor editor navigation, click/panel switching, refresh calls, loading/error/empty/finding rendering and English/German labels: passed;
- functional four-tab Maintenance editor navigation, Current Status, policy-aware Device Overview, filters, History, loading/error/empty rendering and English/German labels: passed;
- no periodic Monitor/Maintenance editor refresh, first-selection/reopen/manual-refresh request rules and scroll/filter/device-selection preservation: passed;
- grouped human-readable findings, separate resource/electrical groups, severity/lifecycle styling, additive summaries/cards and read-protected editor endpoint regressions: passed;
- bounded persisted finding transitions and maintenance runs plus safe Device Details/Maintenance snapshots, including missing-value-versus-zero handling and credential-leak checks: passed;
- complete English/German example JSON, wire targets, required node coverage and embedded Function-node syntax: passed;
- English/German locale key parity and guarded runtime/editor translation: passed;
- `npm pack --dry-run`: passed; required docs, examples and release notes present;
- full project ZIP integrity and content checks: passed;
- all four Node-RED module registrations and protected Admin routes: passed.

Environment limitations:

- Docker CLI/daemon was not installed in the build environment, so the supplied Docker smoke-test commands were not executed here.
- No hardware-in-the-loop Shelly test was run from this build container. The confirmed 0.2.0 behavior and existing practical-test-derived regressions remain covered, but device APIs and firmware vary.

Operational recommendation: use Stable-only, dry-run, backups, exact pilot selection, stable power/network, authorized scan ranges and supervised rollout. Cancellation prevents new work and aborts cooperative requests/waits, but cannot undo an update or reboot already accepted by a device.
