# @impact0815/node-red-contrib-shelly-admin 0.4.0

## Summary

0.4.0 adds opt-in, uptime-based scheduled reboots. The feature is disabled by default and uses a 7-day interval unless configured otherwise.

Scheduled reboot mode: immediate or next maintenance window.
Configurable local maintenance-window time, default 03:00.
Device overview exposes the next scheduled execution and waiting state.
Maintenance history records scheduled origin, uptime before reboot, success/failure, validation and recovery timestamp.

## Behavior

- Only reachable devices with available uptime telemetry are eligible.
- A device becomes due when `uptimeSec` reaches the configured interval.
- Reboots run sequentially with recovery validation before the next device.
- Active maintenance blocks the scheduler; no parallel firmware and reboot runs are started.
- Offline devices, devices without uptime and devices in retry cooldown are skipped.
- Per-device attempts, successful reboots, failures, retry eligibility and the latest run are persisted.
- Existing configurations migrate with `scheduledRebootEnabled=false` and `scheduledRebootIntervalDays=7`.

## Events

`scheduled-reboot-due`, `scheduled-reboot-completed`, `scheduled-reboot-failed`, and `scheduled-reboot-skipped` are emitted through the maintenance lifecycle output.

## Safety

Enabling the feature causes real device reboots. Test on a supervised pilot group and ensure local controls remain safe during temporary network and output interruption.
