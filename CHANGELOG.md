# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-02

### Added

- Modular Node-RED configuration, discovery, monitoring and maintenance nodes.
- Automatic local IPv4 subnet detection and manual CIDR/range/address targets with safety limits.
- Shelly Gen1 and Gen2+ probing, normalization, model/type evidence and health extraction.
- Inventory persistence through named Node-RED Context stores, verified fallback and durability reporting.
- Incremental startup validation with periodic/explicit full inventory scans.
- Bounded raw history, time-bucket aggregation and change-aware warm-up.
- Transparent median/MAD anomaly hints, peer comparison, data quality, hysteresis and cooldown.
- Temperature notification and exact-device opt-in shutdown with no automatic re-enable.
- Firmware checks, dry-run, confirmation gates, sequential updates and conditional reboots.
- Complete English and German editor labels, runtime messages, help and README documentation.
- Tests, ESLint configuration, examples and GitHub Actions for CI and npm publishing preparation.

[Unreleased]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/impact0815/node-red-contrib-shelly-admin/releases/tag/v0.1.0
