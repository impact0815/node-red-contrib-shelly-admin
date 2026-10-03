# Message- und Action-API — 0.3.0

Die Runtime akzeptiert Befehle am Node-Eingang (`msg.action`) und über Start-/Abbrechen-Schaltflächen im Editor-Dialog der deployten Node. Beide Wege verwenden denselben Action-Dispatcher und erzeugen dieselben Outputs. Unbekannte Aktionen liefern `ERR_ACTION` und die unterstützten Aktionen.

## Einheitlicher Lifecycle

Jeder Lauf erhält eine eindeutige `runId`. Ergebnis- und Fortschrittsnachrichten enthalten:

```json
{
  "runId": "discovery-...",
  "operation": "discovery",
  "action": "scan",
  "state": "running",
  "phase": "scanning",
  "processed": 4,
  "total": 254,
  "unprocessed": 250,
  "lifecycle": {
    "schema": "shelly-admin.lifecycle/1",
    "state": "running",
    "startedAt": "...",
    "cancelRequestedAt": null,
    "completedAt": null
  }
}
```

Zustände: `started`, `running`, `cancel-requested`, `cancelled`, `completed`, `completed-with-issues`, `failed`. Phasen sind vorgangsspezifisch. `status` ist rein lesend. `cancel` ist idempotent und liefert ohne aktiven Lauf `accepted:false`, `state:"idle"`, `reason:"no-active-run"`.

Der Abbruch verwendet `AbortController` von der Node über Parallelisierung, HTTP-Requests, Firmwareprüfungen, Validierungsabfragen bis zu Staffelwartezeiten. Nach dem Abbruchstart wird keine neue Gerätearbeit begonnen. Abgeschlossene Geräteergebnisse bleiben erhalten und werden konsistent persistiert. Ein abgebrochener Vollscan setzt den Full-Scan-Abschlusszeitpunkt nicht. Ein bereits vom Gerät angenommenes Update/Reboot kann nicht zurückgerollt werden; das Endergebnis benennt Gerät und Abbruchpunkt.

Alle Outputs erhalten eingehende Message-Eigenschaften und ergänzen `topic`, `payload` sowie `shellyAdmin` mit Schema, Zeitstempel, `runId` und Zustand.

## Discovery-Node

| `msg.action` | Wirkung |
|---|---|
| `start`, `scan` | Scan mit `msg.mode` oder Editoreinstellung |
| `full` | Vollscan |
| `incremental` | bekannte Inventaradressen validieren |
| `cancel` | aktiven Discovery-Lauf abbrechen |
| `status` | aktiven Lauf lesen, ohne Arbeit zu starten |

Optional: `msg.mode` (`initial`, `incremental`, `full`), `msg.targets` (temporäre IP-/Bereich-/CIDR-Liste), `msg.allowScheduledFull`.

```json
{"action":"scan","mode":"full","targets":"192.168.10.0/24"}
```

Ausgänge: (1) vollständiges `shelly-admin.discovery-result/2`-Inventar, (2) Fortschritt, Lifecycle und Änderungen, (3) strukturierte Fehler. Ein abgebrochenes Ergebnis enthält `processed`, `total`, `unprocessed` und `cancelled:true`; noch nicht gestartete Ziele werden nicht fälschlich als offline markiert.

## Monitor-Node

| `msg.action` | Wirkung |
|---|---|
| `start`, `poll`, `check` | Inventar abfragen und Observations auswerten |
| `cancel` | laufende Requests/Analyse abbrechen |
| `status` | Lauf- und Intervallzustand lesen |
| `enable`, `disable` | periodischen Timer bis zum nächsten Deploy schalten |

Einmallauf-Overrides: `msg.automationMode`, `msg.firmwarePolicy`, `msg.outputMode`.

Ausgänge: (1) Health/Inventar/History in `shelly-admin.monitor-result/2`, (2) Alerts plus Fortschritt/Lifecycle, (3) strukturierte Fehler. Additiv liefern Health und Alerts `summaryText`, `summaryTextDe`, `humanSummary`, `findingsSummary` und gruppierte `cards`, ohne Observations zu ersetzen. Observation-Lifecycle: `opened`, `present`, `updated`, `cleared`, `suppressed`. Kategorien: Recovery, Firmware, Temperatursicherheit, Latenz-/Temperaturtrends, Neustarts, Ressourcen, elektrische Werte und Peer-/Netzkontext. Reguläre Null-/Ausphasen und übliche Aus-/Lastzyklen öffnen keine elektrische Anomalie; aktive Lastabweichungen brauchen genügend aktive Historie und dauerhafte Bestätigung, korrelierte Leistungs-/Ratenbefunde werden zusammengeführt. Bei Teilabbruch bleiben abgeschlossene Inventarergebnisse erhalten; eine flottenweite Anomalieauswertung auf unvollständigen Daten wird nicht durchgeführt.

### Editoransichten und Lese-API

Der normale Dialog der deployten Monitor-Node bietet die Tabs **Einstellungen**, **Aktuelle Befunde**, **Historie** und **Gerätedetails**. Ein Ergebnis-Tab lädt beim ersten Wechsel im aktuell geöffneten Dialog, nach erneutem Öffnen oder über seine sichtbare Aktualisieren-Schaltfläche. Es gibt kein periodisches Editor-Refresh. Beim manuellen Aktualisieren bleiben Scrollposition und Geräteauswahl nach Möglichkeit erhalten. Lade-, Request-Fehler- und Leerzustände sind ausdrücklich sichtbar.

Alle Ergebnisrouten verlangen `shelly-admin.read`, setzen `Cache-Control: no-store` und liefern ausschließlich freigegebene Felder ohne Zugangsdaten:

- `GET /shelly-admin/nodes/:id/findings` – aktuelle Karten, gruppiert in `firmware`, `temperature`, `recovery`, `trends`, `resources` und `electrical`; das bestehende Aggregat `anomalies` bleibt kompatibel verfügbar.
- `GET /shelly-admin/nodes/:id/history?limit=50` – neueste zuerst angezeigte, menschenlesbare Einträge für `opened`, `updated`, `present`, `cleared` und Recovery. Der Server begrenzt den Wert auf 1–200 und liefert keine Rohmesswerte.
- `GET /shelly-admin/nodes/:id/devices` – Inventarauswahl plus sichere Details aller inventarisierten Geräte: Identität, Modell, Generation, IP, Erreichbarkeit, Firmware, Temperatur, Latenz, Ressourcen, aktive Befunde, aufgelöste Fehler und kompakte Baselines aus der gespeicherten Historie. Die Geräteauswahl erfolgt anschließend lokal ohne weiteren Request.

Karten enthalten Schweregrad, verständlichen Titel und Erklärung, Gerät/Modell, IP, aktuellen Wert, Baseline/Ziel, Lifecycle und Zeitpunkt. Fehlende Gerätemesswerte sind im JSON `null` und erscheinen als **Nicht verfügbar**, sodass ein echter Zahlenwert `0` unterscheidbar bleibt. Reine Beta-Informationen unter Stable-only sind Info statt Warnung.

Recovery-Beispiel:

```json
{"schema":"shelly-admin.observation/2","kind":"availability","category":"recovery","severity":"cleared","lifecycle":"cleared","observation":{"state":"online","resolvedError":{"code":"ETIMEDOUT"}}}
```

Temperatur-Beispiel:

```json
{"schema":"shelly-admin.observation/2","kind":"temperature","category":"temperatureSafety","severity":"warning","lifecycle":"opened","observation":{"temperatureC":72.5}}
```

Automatische Abschaltung erfordert weiterhin Monitor-Modus `actions` und eine exakte Geräterichtlinie `temperature.autoShutdown:true`. Automatisches Wiedereinschalten gibt es nicht.

## Maintenance-Node

| `msg.action` | Wirkung |
|---|---|
| `start` | konfigurierte Editoraktion ausführen |
| `check` | lesende Firmwareprüfung |
| `update` | Firmwareupdate-Workflow |
| `reboot` | Neustart plus Validierung |
| `cancel` | Request, Validierung oder Staffelwartezeit abbrechen |
| `status` | aktiven Lauf lesen |

Auswahl und Sicherheit: `msg.devices` (exakte IDs/IPs/MACs), `msg.allowAll:true`, `msg.dryRun`, für echte Updates/Reboots zwingend `msg.confirm:true`, `msg.firmwarePolicy`, `msg.condition` sowie die dokumentierten Zeitlimits/Staffelwerte.

```json
{"action":"check","allowAll":true,"firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":true,"firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":false,"confirm":true,"firmwarePolicy":"stable"}
```

Ausgänge: (1) Abschluss, Geräteergebnisse, Firmwarebewertung, Validierung, Recovery, Completion und Lifecycle, (2) Start-, Geräte-, Warte-, Abbruch- und Abschlussfortschritt, (3) strukturierte Fehler mit effektiven Zeitlimits. Firmwareprüfungen laufen nach Gerätefehlern weiter. Bei `update` werden zuerst alle ausgewählten Geräte geprüft. Ergebnis und Fortschritt trennen `checked`, `eligible`, `skipped`, `updated`, `failed` und `timeouts`; nicht berechtigte Geräte erhalten `no-policy-eligible-update`. Nur policy-berechtigte Kandidaten durchlaufen seriell Update, Staffelung, Neustart und Validierung; `processed/total` der Updatephase bezieht sich nur auf diese Kandidaten. Der Dry-run liefert `plannedUpdates` mit Gerät, Kanal und Zielversion und führt keine Änderung oder Wartezeit aus. Stable-only verwirft Beta-only-Angebote. `completion.checkedDevices`, `availableUpdates`, `timeouts`, `errors`, `unprocessed` und `termination` machen das Ende prüfbar.

### Editoransichten und Lese-API

Der Dialog der deployten Wartungs-Node bietet **Einstellungen**, **Aktueller Status**, **Geräteübersicht** und **Historie**. Aktueller Status zeigt einen aktiven und den letzten abgeschlossenen Lauf. Die Geräteübersicht zeigt verständlich Identität, Erreichbarkeit, policy-bezogene Stable-/Beta-Verfügbarkeit und Berechtigung, letzte Prüfung/Aktualisierung/Erfolg/Fehlschlag, Fehler/Zeitüberschreitungen, Recovery nach Update sowie aktive/abgeschlossene Läufe. Filter sind Update verfügbar, Fehler, Offline, Erfolgreich aktualisiert und Übersprungen. Fehlende Werte erscheinen als **Nicht verfügbar**.

Es gilt dieselbe Regel für erstmaligen Tabwechsel, erneutes Öffnen und manuelles Aktualisieren; Filter, Geräteauswahl und Scrollposition bleiben nach Möglichkeit erhalten. Diese nicht cachebaren Routen verlangen `shelly-admin.read` und liefern nur freigegebene Betriebsfelder:

- `GET /shelly-admin/nodes/:id/maintenance/status`
- `GET /shelly-admin/nodes/:id/maintenance/devices`
- `GET /shelly-admin/nodes/:id/maintenance/history?limit=50`

## Config-Node

Die Config-Node hat keine Message-API. Sie verwaltet Credentials, autorisierte Scan-Ziele, Parallelität/Zeitlimits, Context-Persistenz, Historiengrenzen, Anomalieprofile/-kategorien, Temperaturschwellen und exakte Geräterichtlinien. Credentials verbleiben im Node-RED-Credential-Store. Operativer Zustand wird ausschließlich mit `node.context().get/set` gespeichert; für Neustartbeständigkeit einen `localfilesystem`-Store verwenden.
