# Build and verification information

Build date: 2026-10-02
Version: 0.1.0
Node.js used for local verification: 22.x

Completed checks:

- dependency-free source/JSON lint: passed;
- Node.js test runner: 15 passed, 0 failed;
- experimental line coverage: 59.23% overall (core normalization, safety and anomaly modules have focused coverage);
- English/German locale key parity: passed;
- required disclaimer presence: passed;
- `npm pack --dry-run`: passed;
- generated npm tarball installed into an empty project in offline mode: passed;
- all four installed Node-RED modules registered successfully with a registration harness.

Not performed: live hardware-in-the-loop tests against every Shelly model/firmware combination. Device APIs vary by model and firmware; use dry-run and a supervised pilot rollout.
