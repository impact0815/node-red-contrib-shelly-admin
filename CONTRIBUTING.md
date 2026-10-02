# Contributing

Contributions are welcome. Code, comments, JSDoc, commit messages and technical documentation must be written in English. User-facing editor/help/runtime text must keep `en-US` as the complete default/fallback and provide a matching `de` translation.

## Development

1. Fork and create a focused branch.
2. Run `npm install`.
3. Add tests for behavior changes.
4. Run `npm run check`.
5. Update both READMEs and the changelog when user-visible behavior changes.
6. Open a pull request explaining safety impact and validation.

## Design rules

- Do not read or write Node-RED private context files; use the Context API.
- Do not introduce a mandatory MQTT broker.
- Preserve structured, versioned outputs.
- Keep risky actions dry-run by default and fail closed when authorization is ambiguous.
- Automatic output shutdown requires an exact device policy; never add default automatic re-enable.
- Keep anomaly reasons transparent. Do not add an unexplained aggregate risk score or claim deterministic failure prediction.
- Avoid copying third-party code. Cite public documentation and respect licenses.

## Testing devices

Use isolated lab equipment where possible. Never run network scans, firmware updates, reboots or output actions on a network or device without authorization. Record firmware/model details in bug reports, but redact IPs, MACs, credentials and cloud keys.
