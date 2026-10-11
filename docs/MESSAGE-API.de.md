# Message- und Action-API — 0.5.1

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

Jede gerätespezifische Observation bzw. jedes Geräte-Event enthält in 0.5.1 zusätzlich:

```json
{
  "notify": true,
  "deviceClass": "critical",
  "device": {"id":"shellyplus1-aabbcc","name":"Küche","hostname":null,"ip":"192.168.1.20"}
}
```

`notify` ist bereits nach Geräte-Override → Geräteklasse → allgemeine Benachrichtigungseinstellung aufgelöst. Externe Benachrichtigungsflows filtern mit `item.notify === true`, statt die Policy erneut abzubilden. `deviceClass` ist `standard`, `critical`, `test` oder `poor-connection`. `device.name` ist der am Shelly konfigurierte Name (oder `null`); verständliche Texte verwenden danach Hostname/Geräte-ID und IP als Ersatz.

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

`devices` ist das persistente Inventar und wird durch einen Full-Scan bewusst nicht automatisch bereinigt. `foundDevices` ist die in diesem Lauf tatsächlich gefundene Teilmenge. `summary.foundThisScan`, `notFoundThisScan`, `inventoryNotScanned` sowie `lastScan.status` (`found|not-found|not-scanned`) je Gerät trennen aktuellen Nachweis und gespeicherten Zustand. `reachable` folgt dem letzten direkten Abruf; `confirmedOffline` bildet getrennt die konfigurierte Bestätigungsschwelle für Hinweise ab.

## Monitor-Node

| `msg.action` | Wirkung |
|---|---|
| `start`, `poll`, `check` | Inventar abfragen und Observations auswerten |
| `cancel` | laufende Requests/Analyse abbrechen |
| `status` | Lauf- und Intervallzustand lesen |
| `enable`, `disable` | periodischen Timer bis zum nächsten Deploy schalten |
| `refresh-device` | Alle Daten für `msg.device` direkt neu laden |
| `wait-device` | Auf Erreichbarkeit von `msg.device` bis zum Timeout warten |
| `remove-device` | `msg.device` entfernen; verlangt `msg.confirm:true` |

Einmallauf-Overrides: `msg.automationMode`, `msg.firmwarePolicy`, `msg.outputMode`.

Geplante Läufe überspringen Geräte mit deaktivierter effektiver Überwachung oder noch nicht fälligem Geräte-Polling-Intervall. Manuelle Starts beachten die Aktivierung, ignorieren aber die Fälligkeit. Offline wird erst nach der effektiven Zahl aufeinanderfolgender Fehler geöffnet. Frühere Fehler bleiben als strukturierte technische Fehler und persistierte Vorfallzähler erhalten. Recovery wird erst nach der effektiven Mindestdauer des bestätigten Offline-Zustands ausgegeben.

Ausgänge: (1) Health/Inventar/History in `shelly-admin.monitor-result/2`, (2) Alerts plus Fortschritt/Lifecycle, (3) strukturierte Fehler. Additiv liefern Health und Alerts `summaryText`, `summaryTextDe`, `humanSummary`, `findingsSummary` und gruppierte `cards`, ohne Observations zu ersetzen. Observation-Lifecycle: `opened`, `present`, `updated`, `cleared`, `suppressed`. Kategorien: Recovery, Firmware, Temperatursicherheit, Latenz-/Temperaturtrends, Neustarts, Ressourcen, elektrische Werte und Peer-/Netzkontext. Reguläre Null-/Ausphasen und übliche Aus-/Lastzyklen öffnen keine elektrische Anomalie; aktive Lastabweichungen brauchen genügend aktive Historie und dauerhafte Bestätigung, korrelierte Leistungs-/Ratenbefunde werden zusammengeführt. Bei Teilabbruch bleiben abgeschlossene Inventarergebnisse erhalten; eine flottenweite Anomalieauswertung auf unvollständigen Daten wird nicht durchgeführt.

### Editoransichten und Lese-API

Der normale Dialog der deployten Monitor-Node bietet die Tabs **Einstellungen**, **Aktuelle Befunde**, **Historie** und **Gerätedetails**. Ein Ergebnis-Tab lädt beim ersten Wechsel im aktuell geöffneten Dialog, nach erneutem Öffnen oder über seine sichtbare Aktualisieren-Schaltfläche. Es gibt kein periodisches Editor-Refresh. Jede Geräteansicht besitzt genau ein eigenes Dropdown direkt über den Details; seine Feldfolge entspricht der Sortierung (`Name · Typ · IP`, `Typ · Name · IP` oder `IP · Name · Typ`) und der führende Schlüssel ist fett; eine separate Button-Liste aller Geräte gibt es nicht. Das aktive Sortierfeld Typ/Name/IP ist fett, Ersatznamen bleiben grau/kursiv, lange Einträge nutzen Ellipsis/Tooltip. Bedienung: Pfeiltasten, Enter, Escape und Schließen per Außenklick. Das Modell-/Typ-Popover bleibt in seiner Breite innerhalb des Dialogs und bricht lange Bezeichnungen um, sodass Checkboxen und Auswahltexte lesbar bleiben. Manuelles Aktualisieren erhält Scrollposition, Geräteauswahl sowie persistente Sortierung und Modell-/Typ-Mehrfachfilter. Standard ist Name, IPv4 wird numerisch sortiert; Wartungsstatusfilter werden mit dem Typfilter kombiniert. Lade-, Request-Fehler- und Leerzustände sind sichtbar.

Alle Ergebnisrouten verlangen `shelly-admin.read`, setzen `Cache-Control: no-store` und liefern ausschließlich freigegebene Felder ohne Zugangsdaten:

- `GET /shelly-admin/nodes/:id/findings` – aktuelle Karten, gruppiert in `firmware`, `temperature`, `recovery`, `trends`, `resources` und `electrical`; das bestehende Aggregat `anomalies` bleibt kompatibel verfügbar.
- `GET /shelly-admin/nodes/:id/history?limit=50` – neueste zuerst angezeigte, menschenlesbare Einträge für `opened`, `updated`, `present`, `cleared` und Recovery. Der Server begrenzt den Wert auf 1–200 und liefert keine Rohmesswerte.
- `GET /shelly-admin/nodes/:id/devices` – Inventarauswahl plus sichere Details aller inventarisierten Geräte: konfigurierter Name und Fallback-Metadaten, Modell, Generation, IP, Erreichbarkeit, Firmware, Temperatur, Latenz, Ressourcen, aktive Befunde, aufgelöste Fehler und kompakte Baselines aus der gespeicherten Historie. Die Geräteauswahl erfolgt anschließend lokal ohne weiteren Request.

Mutationen in Gerätedetails verwenden `POST /shelly-admin/nodes/:id/action` mit `shelly-admin.write`:

- `{"action":"refresh-device","device":"<id>"}` – frischer Direktabruf mit vollständigem Detail-Snapshot;
- `{"action":"wait-device","device":"<id>","timeoutMs":60000}` – begrenztes Retry/Warten;
- `{"action":"remove-device","device":"<id>","confirm":true}` – Inventar sowie Betriebshistorie/-zustand entfernen. Klassen-/Override-Konfiguration bleibt für sichere Wiedererkennung erhalten.

Während Discovery, Monitor oder Wartung aktiv ist, liefern diese Aktionen `ERR_BUSY`. Ein fehlgeschlagenes Neuladen speichert direkte Nichterreichbarkeit; der Editor bietet Erneut versuchen, Retry/Warten und Entfernen.

Karten enthalten Schweregrad, verständlichen Titel und Erklärung, Gerät/Modell, IP, aktuellen Wert, Baseline/Ziel, Lifecycle und Zeitpunkt. Fehlende Gerätemesswerte sind im JSON `null` und erscheinen als **Nicht verfügbar**, sodass ein echter Zahlenwert `0` unterscheidbar bleibt. Reine Beta-Informationen unter Stable-only sind Info statt Warnung.

Recovery-Beispiel:

```json
{"schema":"shelly-admin.observation/2","kind":"availability","category":"recovery","notify":true,"deviceClass":"standard","severity":"cleared","lifecycle":"cleared","observation":{"state":"online","resolvedError":{"code":"ETIMEDOUT"}}}
```

Temperatur-Beispiel:

```json
{"schema":"shelly-admin.observation/2","kind":"temperature","category":"temperatureSafety","notify":true,"deviceClass":"standard","severity":"warning","lifecycle":"opened","observation":{"temperatureC":72.5}}
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

Auswahl und Sicherheit: `msg.devices` (exakte IDs/IPs/MACs), `msg.deviceClass` (`standard`, `critical`, `test`, `poor-connection`) als klassenweiter Selektor, `msg.allowAll:true`, `msg.dryRun`, für echte Updates/Reboots zwingend `msg.confirm:true`, `msg.firmwarePolicy`, `msg.condition` sowie die dokumentierten Zeitlimits/Staffelwerte.

```json
{"action":"check","allowAll":true,"firmwarePolicy":"stable"}
```

Klassenweite Prüfung:

```json
{"action":"check","deviceClass":"poor-connection","firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":true,"firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":false,"confirm":true,"firmwarePolicy":"stable"}
```

Ausgänge: (1) Abschluss, Geräteergebnisse, Firmwarebewertung, Validierung, Recovery, Completion und Lifecycle, (2) Start-, Geräte-, Warte-, Abbruch- und Abschlussfortschritt, (3) strukturierte Fehler mit effektiven Zeitlimits. Firmwareprüfungen laufen nach Gerätefehlern weiter. Bei `update` werden zuerst alle ausgewählten Geräte geprüft. Ergebnis und Fortschritt trennen `checked`, `eligible`, `skipped`, `updated`, `failed` und `timeouts`; nicht berechtigte Geräte erhalten `no-policy-eligible-update`. Nur policy-berechtigte Kandidaten durchlaufen seriell Update, Staffelung, Neustart und Validierung; `processed/total` der Updatephase bezieht sich nur auf diese Kandidaten. Der Dry-run liefert `plannedUpdates` mit Gerät, Kanal und Zielversion und führt keine Änderung oder Wartezeit aus. Stable-only verwirft Beta-only-Angebote. `completion.checkedDevices`, `availableUpdates`, `timeouts`, `errors`, `unprocessed` und `termination` machen das Ende prüfbar.

### Editoransichten und Lese-API

Der Dialog der deployten Wartungs-Node bietet **Einstellungen**, **Aktueller Status**, **Geräteübersicht** und **Historie**. In Einstellungen stehen Klassenauswahl und eigene Schaltflächen für klassenweite Prüfung, Aktualisierung und Neustart bereit. Sie verwenden denselben `deviceClass`-Pfad wie Messages; echte Klassenupdates/-neustarts verlangen weiterhin Non-Dry-Run-Bestätigung und laufen rollierend/seriell. Aktueller Status zeigt einen aktiven und den letzten abgeschlossenen Lauf. Die Geräteübersicht zeigt verständlich Identität, Erreichbarkeit, policy-bezogene Stable-/Beta-Verfügbarkeit und Berechtigung, letzte Prüfung/Aktualisierung/Erfolg/Fehlschlag, Fehler/Zeitüberschreitungen, Recovery nach Update sowie aktive/abgeschlossene Läufe. Filter sind Update verfügbar, Fehler, Offline, Erfolgreich aktualisiert und Übersprungen. Fehlende Werte erscheinen als **Nicht verfügbar**.

Es gilt dieselbe Regel für erstmaligen Tabwechsel, erneutes Öffnen und manuelles Aktualisieren; Statusfilter, Modell-/Typ-Mehrfachfilter, Dropdown-Sortierung, Geräteauswahl und Scrollposition bleiben nach Möglichkeit erhalten. Diese nicht cachebaren Routen verlangen `shelly-admin.read` und liefern nur freigegebene Betriebsfelder:

- `GET /shelly-admin/nodes/:id/maintenance/status`
- `GET /shelly-admin/nodes/:id/maintenance/devices`
- `GET /shelly-admin/nodes/:id/maintenance/history?limit=50`

## Config-Node

Die Config-Node hat keine Message-API. Sie verwaltet Credentials, autorisierte Scan-Ziele, Parallelität/Zeitlimits, Context-Persistenz, Historiengrenzen, Anomalieprofile/-kategorien, Temperaturschwellen und exakte Geräterichtlinien. Credentials verbleiben im Node-RED-Credential-Store. Operativer Zustand wird ausschließlich mit `node.context().get/set` gespeichert; für Neustartbeständigkeit einen `localfilesystem`-Store verwenden.


### Dreistufige Geräte-Einstellungen (0.5.0)

Effektive Einstellungen werden als Geräte-Override → Geräteklasse → allgemein aufgelöst. Klassen- und Gerätezuordnungen sind reguläre Eigenschaften der Config-Node; Inventar und Historie verbleiben im Node-RED-Context. Fehlende Zuordnungen migrieren zu Standard/keine Overrides. Der geschützte No-Store-Endpunkt `GET /shelly-admin/config/:id/device-settings` liefert sichere Inventarübersichten, Klassenvorgaben, Overrides, effektive Werte und Herkunft.

Eingebaute Klassen: Standard (allgemeine Einstellungen), Kritisch (keine automatischen Firmwareupdates/Neustarts und sofortige Offline-Bestätigung), Testgerät (Beta erlaubt, jede bestätigte Recovery und ausführliche Details) und Schlechte Verbindung (fünf Fehler, 15 Minuten Recovery-Mindestdauer, 300 Sekunden Polling). Klassenwerte sind editierbar; jeder Geräte-Override lässt sich einzeln entfernen. Config Geräte-Einstellungen zeigt Neustartaktivierung, Intervall, Sofort-/Wartungsfenster-Modus und Uhrzeit je Klasse sowie alle zugeordneten Geräte mit `scheduledReboot.scheduledFor`.


### Uptime, Neustartstatus und effektiver Zeitplan

`GET /shelly-admin/config/:id/device-settings`, Monitor-Gerätedetails und Wartungs-Geräteübersicht liefern `currentUptimeSec`, `uptimeBeforeLastRebootSec`, `lastRebootAt`, `lastRebootDetectedAt`, `lastRebootType` (`planned|requested|unexpected`), `lastRebootReason` und `scheduledReboot.scheduledFor`. `scheduledReboot.settingOrigins` nennt für Aktivierung, Intervall, Modus und Uhrzeit jeweils `global`, `class` oder `device`. Fehlende Messwerte sind JSON-`null`.

Der Scheduler löst jedes Neustartfeld je Gerät auf. Ein Klassenwert überschreibt keinen unabhängigen Geräte-Override; Erben setzt nur das gewählte Feld zurück. Regelmäßige automatische Neustarts sind `planned`, explizite Wartungs-/Firmware-Anforderungen `requested`, Uptime-Abfälle ohne Marker `unexpected`. Neustart-Events und Uptime davor werden in der Gerätehistorie persistiert.

### Vertrag für reine Beta-Hinweise

Die allgemeine Config-Eigenschaft `showBetaFirmwareNotices` ist standardmäßig `false`. Dann bleibt Beta-only-Verfügbarkeit in Firmware-/Inventardaten erhalten, erzeugt aber keine Observation, Karte, keinen Statuszähler und keine Benachrichtigung. Bei `true` gibt die Runtime je Gerät und Beta-Version genau eine `firmware-update`-Observation mit Lifecycle `opened` aus; der persistierte Zustand unterdrückt Wiederholungen bis zu einer neuen Beta-Version. Stable-Update-Verhalten bleibt unverändert.

### Uptime-Felder bei Warning/Critical

Jede Warning-/Critical-Observation und jedes Temperatur-Event enthält:

```json
{
  "severity": "warning",
  "uptimeSec": 532800,
  "uptimeText": "Uptime: 6 days 4 h",
  "uptimeTextDe": "Uptime: 6 Tage 4 Std",
  "summaryText": "... Uptime: 6 days 4 h",
  "summaryTextDe": "... Uptime: 6 Tage 4 Std",
  "observation": { "uptimeSec": 532800 }
}
```

Befundkarten übernehmen die maschinenlesbaren und zweisprachigen Felder und ergänzen `summary`/`summaryDe`. Fehlt die Telemetrie, ist `uptimeSec` gleich `null` und der Text lautet `Uptime: not available` / `Uptime: nicht verfügbar`. Benachrichtigungsflows müssen weiterhin `notify === true` prüfen; `examples/05-notify-routing.json` zeigt `notificationText` mit Uptime.
