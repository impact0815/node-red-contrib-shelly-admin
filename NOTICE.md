# Notices and operational safety

## Project status

`@impact0815/node-red-contrib-shelly-admin` is an unofficial community project. It is not affiliated with, endorsed by, or supported by Shelly or Allterco. Shelly and related names may be trademarks of their respective owners and are used only to describe interoperability.

## Use at your own risk – no warranty

The software is provided **“as is”** under the MIT License, without warranty of any kind. Device APIs and firmware can change. Discovery, firmware updates, reboots, relay actions and automatic shutdown can cause interruption, equipment or electrical damage, building or data damage, consequential loss, outages or costs. Use dry-run, a small pilot group, staged rollout, supervision, stable power/network service and professional electrical installation.

Temperature monitoring is not a certified fire-protection or life-safety system. It does not replace smoke alarms, protective equipment, inspection, supervision or applicable electrical/building requirements. Automatic switch-off is disabled unless enabled for an exact device and outputs are not automatically re-enabled.

## Technical references

The implementation was informed by publicly documented interfaces and architecture:

- Official Shelly API documentation: https://shelly-api-docs.shelly.cloud/
- `windkh/node-red-contrib-shelly`: https://github.com/windkh/node-red-contrib-shelly
- Node-RED Context Store documentation: https://nodered.org/docs/api/context/

No source code from the referenced Shelly Node-RED project is included or copied. Runtime dependencies are limited to Node.js and Node-RED APIs; MQTT is not required.

## Deutsch

**Nutzung auf eigene Gefahr – keine Gewährleistung.** Inoffizielles Community-Projekt ohne Verbindung zu Shelly oder Allterco; Bereitstellung „wie besehen“. API- und Firmwareänderungen sind möglich. Erkennung, Firmwareupdates, Neustarts, Relaisaktionen und automatische Abschaltung können Ausfälle, Kosten sowie Geräte-, Elektro-, Gebäude-, Daten- oder Folgeschäden verursachen. Zuerst Probelauf, dann kleine Pilotgruppe, gestaffelt und beaufsichtigt ausrollen; fachgerechte Elektroinstallation verwenden.

Die Temperaturüberwachung ist kein zertifiziertes Brandschutz- oder Lebenssicherheitssystem. Sie ersetzt keine Rauchmelder, Schutzgeräte, Prüfungen oder Beaufsichtigung. Abschaltung ist nur nach exakter Gerätefreigabe möglich; automatisches Wiedereinschalten erfolgt nicht.
