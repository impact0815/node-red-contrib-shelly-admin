# Security policy

## Supported versions

Security fixes are provided for the latest published minor release. This initial package is pre-1.0; interfaces may evolve with clear changelog entries.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving credential exposure, authentication bypass, unsafe relay/firmware action, network scanning escalation or persisted sensitive data. Use GitHub Security Advisories for `impact0815/node-red-contrib-shelly-admin`:

https://github.com/impact0815/node-red-contrib-shelly-admin/security/advisories/new

Include affected version, Node.js/Node-RED versions, device generation/model/firmware, reproduction steps and impact. Remove credentials, cloud keys, real public IP addresses and unnecessary MAC addresses. Expect acknowledgement within 7 days; remediation timing depends on severity and reproducibility.

## Operational guidance

- Run Node-RED on a trusted, patched host and protect its editor/admin API.
- Store device credentials only in Node-RED credentials; restrict access to the flow credential secret.
- Segment IoT devices and permit only required management traffic.
- Shelly devices commonly expose local HTTP. Digest authentication protects the password exchange but does not encrypt response data; untrusted networks require additional controls.
- Limit CIDR sizes/concurrency and scan only authorized networks.
- Keep dry-run enabled until exact device selection and policy behavior have been reviewed.
- Treat firmware, reboot and relay/shutdown operations as privileged changes.
- Use a supported file-based Context store with suitable filesystem permissions and backups.

This project is not a certified fire-protection or life-safety system.
