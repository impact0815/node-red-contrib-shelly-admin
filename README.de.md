# @impact0815/node-red-contrib-shelly-admin

[English](README.md) · **Deutsch**

Node-RED-Nodes zur lokalen Shelly-Flottenverwaltung: Discovery, persistentes Inventar, Firmware-Richtlinien, abgesicherte Wartung, historische Überwachung, geräteeigene Baselines, vorsichtiger Peer-Vergleich und explizite Observation-Lebenszyklen. Shelly Gen1 bis Gen4 werden über die Gen1- und Gen2+-HTTP-APIs unterstützt. MQTT ist optional und keine Paketabhängigkeit.

## Gerätenamen und Listen in 0.5.1

Discovery und Monitor speichern jetzt den am Shelly konfigurierten Namen (`Shelly.GetDeviceInfo.name` oder `Sys.GetConfig.device.name` bei Gen2+, `/settings.name` bei Gen1) und übernehmen Umbenennungen am Gerät. Bestehende Inventare migrieren mit `name: null`; der nächste erfolgreiche Abruf trägt den Namen nach.

Monitor-Gerätedetails, Wartungs-Geräteübersicht und Config-Geräte-Einstellungen verwenden nur noch ein schlankes eigenes Geräte-Dropdown, direkt gefolgt von der Detailansicht; die zusätzliche Button-Liste aller Geräte ist entfernt. Einträge stellen den aktiven Sortierschlüssel fett voran: `Name · Typ · IP`, `Typ · Name · IP` oder `IP · Name · Typ`. Ersatznamen bleiben grau/kursiv; lange Texte haben Ellipsis und Tooltip. Das Dropdown unterstützt Pfeiltasten, Enter, Escape und Schließen per Außenklick ohne horizontale Scrollleiste. Persistentes **Sortieren nach: Typ / Name / IP** wirkt nur auf dieses Dropdown; Standard ist Name, IPv4 wird numerisch sortiert. Ein persistenter Mehrfachfilter für Modelle/Typen bietet **Alle/Keine**, zeigt `Typen: alle` oder `Typen: n von m` und öffnet ein begrenztes, umbrechendes Popover vollständig innerhalb des Dialogs; bestehende Wartungsfilter bleiben erhalten und werden kombiniert. Manuelles Aktualisieren erhält Sortierung, Typfilter, Wartungsfilter, Auswahl und Scrollposition; ein Editor-Auto-Refresh gibt es nicht. Observations/Events enthalten `device.name`; verständliche Zusammenfassungen bevorzugen ihn für Benachrichtigungen.

Für jedes inventarisierte Gerät werden Einstellungen jetzt strikt in der Reihenfolge **Geräte-Override → Geräteklasse → allgemeine Konfiguration** aufgelöst. Vorhandene Geräte migrieren nach **Standard** ohne Overrides. Die eingebauten Klassen sind Standard, Kritisch, Testgerät und Schlechte Verbindung; ihre Voreinstellungen lassen sich anpassen, und jeder Geräte-Override kann einzeln wieder auf Vererbung gesetzt werden.

Der Reiter **Geräte-Einstellungen** der Config-Node lädt das Inventar nur beim Öffnen oder über **Aktualisieren**. Er bearbeitet alle Klassenvorgaben einschließlich Standard und Geräte-Overrides und zeigt jeden effektiven Wert mit der Herkunft allgemein/Klasse/Gerät. Neustartaktivierung, Intervall, Modus Sofort/Wartungsfenster und Wartungsfenster-Uhrzeit sind einzeln als Gerät → Klasse → allgemein vererbbar. Für die gewählte Klasse zeigt der Reiter zusätzlich das effektive Wartungsfenster, alle zugeordneten Geräte und deren nächsten geplanten Neustart. Gerätebezogene Details behalten Uptime und Neustartklassifikation. Fehlende Werte erscheinen als **Nicht verfügbar**, nie als künstliche Null.

Alle Observations und ausgegebenen Geräte-Events erhalten additiv `notify` und `deviceClass`. Jede Warning-/Critical-Observation und jeder entsprechende Befund enthält außerdem `uptimeSec`, `uptimeText` und `uptimeTextDe`; die verständliche Zusammenfassung nennt aktuelle Uptime oder **Nicht verfügbar**. Schema-Bezeichner und drei Ausgänge bleiben unverändert. Ein Benachrichtigungsflow filtert mit `notify === true` und kann `summaryTextDe` weitergeben.

## Inventarnachweis und direkte Geräteaktionen in 0.5.1

Ein Full-Scan behält persistente Inventareinträge bewusst: Ein stromloser oder physisch entfernter Shelly kann gespeichert bleiben, damit Identität, Historie und Richtlinien nicht automatisch zerstört werden. Der aktuelle Scannachweis ist jetzt getrennt: `foundDevices`, `foundThisScan`, `notFoundThisScan`, `inventoryNotScanned` und `lastScan.status` je Gerät unterscheiden **jetzt gefunden**, **bekannt, aber nicht gefunden** und **außerhalb des aktuellen Scanbereichs**. Öffentliche/Editor-Erreichbarkeit folgt sofort dem letzten direkten Abruf; `confirmedOffline` bleibt der entprellte Benachrichtigungszustand.

Monitor **Gerätedetails** bietet **Alle Daten neu laden** für einen frischen Geräteabruf. Bei Nichterreichbarkeit stehen Erneut versuchen, begrenztes **Retry / Warten** und bestätigtes **Entfernen** bereit. Entfernen löscht den persistenten Inventareintrag sowie Betriebshistorie/-zustand. Klassen- und Override-Konfiguration bleibt bewusst für sichere Wiedererkennung erhalten; für eine endgültige Policy-Löschung muss sie zusätzlich in Config Geräte-Einstellungen entfernt werden.

Die code- und testgestützte Bewertung mit bestätigten Korrekturen, Restrisiken und Architekturvorschlägen steht in [docs/ARCHITECTURE-REVIEW-0.5.1.md](docs/ARCHITECTURE-REVIEW-0.5.1.md).

## Flotten-Dashboard

![Shelly-Flotten-Dashboard](https://raw.githubusercontent.com/impact0815/node-red-contrib-shelly-admin/main/docs/images/fleet-dashboard.jpg)

Ein direkt importierbares, zweisprachiges (DE/EN) Dashboard für [FlowFuse Dashboard 2.0](https://dashboard.flowfuse.com/) auf Basis der Discovery-, Monitor- und Maintenance-Nodes: Flotten-Kennzahlen, Kachel- und Tabellenansicht, Suche, Filter und Gruppierung, Hinweise, Firmware-Übersicht, 24-h-Verlauf je Gerät sowie Schalten von Relais und Steckdosen mit bis zu 4 Kanälen. Firmwareupdates und Neustarts bleiben hinter einer ausdrücklichen Wartungsfreigabe.

→ [`examples/06-fleet-dashboard-flowfuse.json`](examples/06-fleet-dashboard-flowfuse.json) · [Einrichtung und Details](examples/README.de.md#flotten-dashboard-flowfuse-dashboard-20)

## Sicherheit und Geltungsbereich

> **⚠️ Nutzung auf eigene Gefahr – keine Gewährleistung.** Dies ist ein inoffizielles Community-Projekt ohne Verbindung zu oder Unterstützung durch Shelly beziehungsweise Allterco. Die Software wird „wie besehen“ bereitgestellt.
>
> Trends und Anomalien sind **keine garantierte Ausfallvorhersage**. Sie ersetzen weder Herstellerschutzfunktionen, Rauchmelder, fachgerechte Elektroinstallation und Prüfung noch Brandvorsorge und beaufsichtigte Wartung.
>
> Eine automatische Temperaturabschaltung bleibt deaktiviert, solange nicht sowohl der Monitor-Modus **Explizite Richtlinienaktionen** als auch eine exakte Gerätefreigabe gesetzt sind. Ein Ausgang wird niemals automatisch wiedereingeschaltet.

## Nodes und Kompatibilität

| Node-Typ | Aufgabe | Bestehende Ausgänge bleiben erhalten |
|---|---|---|
| `shelly-admin-config` | Gemeinsame Zugangsdaten, Erkennung, Persistenz, Historie, Analyse und Sicherheit | Konfigurationsnode |
| `shelly-admin-discovery` | Vollständige/inkrementelle Erkennung und Inventarvalidierung | Inventar · Ereignisse · Fehler |
| `shelly-admin-monitor` | Abfrage, Historie, Observations und Temperatursicherheit | Gesundheit · Hinweise · Fehler |
| `shelly-admin-maintenance` | Firmwareprüfung, Dry-run, rollierende Updates und konditionelle Neustarts | Ergebnis · Gerätefortschritt · Fehler |

Version 0.5.1 erhält Node-Typen, dreifache Ausgangsverdrahtung, Node.js 18+/Node-RED 3.1+, Gen1–Gen4-Normalisierung, Context-Store-Persistenz, strukturierte Fehler, Temperatursicherheit und die duale Bedienung über `msg.action` und Editor-Schaltflächen.

## Einheitliche Action- und Lifecycle-API

| Node | Start-/Laufaktionen | Steueraktionen |
|---|---|---|
| Discovery | `start`, `scan`, `full`, `incremental` | `cancel`, `status` |
| Monitor | `start`, `poll`, `check` | `cancel`, `status`, `enable`, `disable`, `refresh-device`, `wait-device`, `remove-device` |
| Maintenance | `start`, `check`, `update`, `reboot` | `cancel`, `status` |

Beispiel:

```json
{"action":"scan","mode":"full","targets":"192.168.10.0/24"}
```

Jeder aktive Lauf besitzt eine `runId`. Fortschritt und Abschluss melden `state`, `phase`, `processed`, `total`, `unprocessed`, Zeitstempel und ein eingebettetes `shelly-admin.lifecycle/1`-Objekt. Einheitliche Zustände: `started`, `running`, `cancel-requested`, `cancelled`, `completed`, `completed-with-issues`, `failed`. `status` arbeitet rein lesend. `cancel` ist idempotent und meldet `idle`, wenn nichts läuft.

Der Abbruch wird durch Parallelisierung, HTTP-Requests, Firmwareprüfungen, Validierungsabfragen nach Neustarts und Staffelwartezeiten propagiert. Abgeschlossene Gerätearbeit bleibt erhalten und wird persistiert. Nicht gestartete Discovery-Ziele werden nicht als offline gewertet; ein abgebrochener Vollscan setzt keinen neuen Abschlusszeitpunkt. Bereits vom Gerät angenommene Firmwareupdates oder Neustarts lassen sich nicht zurückrollen; das Ergebnis enthält Gerät und Abbruchpunkt.

Der vollständige Message-Vertrag je Node, Lifecycle-Datensätze, Output-Topics, Recovery-Beispiele, Firmwareabläufe und Abbruchsemantik stehen in [docs/MESSAGE-API.de.md](docs/MESSAGE-API.de.md) ([English](docs/MESSAGE-API.md)).

### Optionale PV-String-Diagnose

Ein optionales Add-on für FlowFuse Dashboard 2.0 ermöglicht den Vergleich von zwei PV-Strings auch dann, wenn unterschiedlich viel PV-Leistung an den beiden MPPT-Eingängen installiert ist.

Statt die aktuelle Leistung der Strings direkt miteinander zu vergleichen, wird die Leistung jedes Strings zunächst anhand seiner konfigurierten installierten Leistung normalisiert.

Beispiel:

- PV1: 10 × 405 Wp = 4,05 kWp
- PV2: 8 × 405 Wp = 3,24 kWp
- Erwartetes Leistungsverhältnis unter vergleichbaren Bedingungen: 1,25 : 1

Bei beispielsweise 2.025 W an PV1 und 1.620 W an PV2 liefern beide Strings jeweils 50 % ihrer installierten Leistung. Das Verhältnis ist damit trotz der unterschiedlichen absoluten Leistung plausibel.

Das Add-on berücksichtigt mehrere qualifizierte Messwerte, um kurzfristige Einflüsse durch Wolken, Verschattung oder unterschiedliche MPPT-Reaktionen zu reduzieren. Bei einer auffälligen Abweichung wird zusätzlich angezeigt, welcher String relativ schwächer arbeitet.

Direkt im Dashboard konfigurierbar sind:

- Name von String 1 und String 2
- Anzahl der PV-Module je String
- Nennleistung eines Moduls in Wp
- Mindest-Gesamtleistung für eine Bewertung
- Warnschwelle
- kritische Schwelle
- Anzahl der Messwerte zur Glättung

Die Konfiguration wird persistent im Node-RED-Context gespeichert.

> **Hinweis:** Die Auswertung ist eine Plausibilitätsprüfung und keine elektrische Fehlerdiagnose. Unterschiedliche Ausrichtung, Neigung, Verschattung, Modultemperatur oder Modultoleranzen können auch bei einer technisch einwandfreien Anlage zu unterschiedlichen spezifischen Stringleistungen führen.

→ [`examples/07-pv-string-diagnostics-flowfuse.json`](examples/07-pv-string-diagnostics-flowfuse.json)  
→ [`examples/07-pv-string-diagnostics-README.md`](examples/07-pv-string-diagnostics-README.md)


## Installation

Im Node-RED-Benutzerverzeichnis:

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-shelly-admin@0.5.1
```

Aus dem bereitgestellten Paket:

```bash
cd ~/.node-red
npm install /pfad/zu/impact0815-node-red-contrib-shelly-admin-0.5.1.tgz
```

Anschließend Node-RED neu starten und eine `shelly-admin-config`-Node sowie die benötigten Discovery-, Monitor- und Maintenance-Nodes hinzufügen.

## Discovery und Firmware-Richtlinie

Ziele akzeptieren CIDR-Netze, vollständige oder verkürzte IPv4-Bereiche, Einzeladressen sowie Komma-/Zeilenlisten. Automatisch ermittelte Netze werden durch die kleinste Präfixlänge (Standard `/24`) und das Gesamtlimit (Standard `4096`) begrenzt. Nur autorisierte Netze scannen.

- Gen1: `/shelly`, `/settings`, `/status`
- Gen2–Gen4: `/shelly`, `Shelly.GetDeviceInfo`, `Sys.GetConfig`, `Shelly.GetStatus`
- Nur Stable ist die Standard-Firmware-Richtlinie; Beta muss ausdrücklich erlaubt werden.
- **Hinweise zu Beta-Firmware anzeigen** ist standardmäßig aus. Aktiviert öffnet ein Beta-only-Hinweis je Gerät und Beta-Version genau einmal; wiederholte Monitorläufe melden ihn nicht erneut. Die Beta-Verfügbarkeit bleibt maschinenlesbar, Stable-Verhalten unverändert.
- `firmwareCheckTimeoutMs` hat den Standard `2500`, akzeptiert `250–60000` und wird unverändert an die vollständige Prüfung und die Requests übergeben.
- Fehler oder Timeout eines Geräts stoppen die verbleibenden lesenden Firmwareprüfungen nicht.
- Ein Updatelauf arbeitet zweiphasig: zuerst werden alle ausgewählten Geräte geprüft; Update, Neustartwartezeit und Validierung laufen danach nur für policy-berechtigte Geräte. Unter Stable-only enden Beta-only- und Geräte ohne Update sofort als `skipped` mit `no-policy-eligible-update`.
- Fortschritt trennt `checked`, `eligible`, `skipped`, `updated`, `failed` und `timeouts`. Nach der Planung bezieht sich `processed/total` nur auf echte Updatekandidaten. Ein Dry-run liefert `plannedUpdates` und führt weder Update noch Staffel-, Neustart- oder Validierungswartezeit aus.

## Lokale Persistenz und Migration

Der Zustand wird ausschließlich über die unterstützte Node-RED-API `node.context().get/set` gespeichert. Für Neustartbeständigkeit einen `localfilesystem`-Store konfigurieren:

```js
contextStorage: {
  default: "memoryOnly",
  memoryOnly: { module: "memory" },
  file: { module: "localfilesystem", config: { flushInterval: 30 } }
}
```

Version 0.2.0 schreibt das explizite State-Schema `2` unter `shellyAdminStateV2`. Beim ersten Start kann der Zustand der 0.1.x-Versionen aus dem Schema-1-Schlüssel geladen werden. Unabhängig migriert werden:

- Inventar und aktive/behobene Fehler;
- Rohhistorie und Stundenaggregate;
- Temperatur- und Anomaliezustände;
- die Context-Store-Auswahl als reguläre Eigenschaft der Node-RED-Konfigurationsnode.

Ein beschädigter optionaler Teilbereich wird isoliert und verständlich gemeldet; ein gültiges Inventar bleibt geladen. Nur wegen fehlerhafter Historie oder Analyse erfolgt keine vollständige Neu-Inventarisierung. Der Datei-Context-Store kann Schreibvorgänge bis zum `flushInterval` puffern; Backups entsprechend planen.

Alte Config-Nodes müssen nicht neu angelegt werden. Fehlende oder leere Zahlenfelder werden beim Öffnen sichtbar mit dokumentierten Werten vorbelegt und beim Speichern konkret persistiert. Insbesondere wird `firmwareCheckTimeoutMs: ""` zu `2500` und nicht auf den Minimalwert geklemmt.

## Historische Überwachung 2.0

Die Historie speichert nur tatsächlich gemeldete Messwerte. Erreichbarkeit wird ausdrücklich erfasst; fehlende Temperatur-, RSSI-, Ressourcen- oder elektrische Werte werden nicht in Nullwerte umgewandelt.

Verfügbare Messgrößen:

- Erreichbarkeit und HTTP-Latenz;
- Temperatur, RSSI und Uptime;
- freie RAM- und Dateisystem-Prozentwerte;
- Wirkleistung, Strom, Spannung und kumulierte Energie;
- Firmwareversion und Konfigurationsrevision als Änderungsdimensionen.

Standardwerte:

| Einstellung | Standard |
|---|---:|
| Rohdatenaufbewahrung | 48 Stunden |
| Aggregataufbewahrung | 90 Tage |
| Bucket-Breite | 60 Minuten |
| Rohwerte/Gerät | 10.000 |
| Aggregate/Gerät | 10.000 |
| Ungefähre Historienbytes/Gerät | 1.048.576 |

Rohdaten und Zeit-Buckets bestehen nebeneinander. Buckets enthalten Anzahl, Mittelwert, Minimum, Maximum, letzten Wert, Coverage und Missing-Ratio. Beim Speichern erzwingt die Kompaktierung Alters-, Mengen- und Größenlimits pro Gerät. Metadaten enthalten Sample-Anzahl, ersten/letzten Messpunkt, geschätzten Takt, Missing-Ratio, Warm-up, Neustarthistorie sowie Firmware-/Konfigurationssegmente. Aggregate erhalten Baselines über Node-RED-Neustarts und über das Ende der Rohdatenaufbewahrung hinaus.

## Geräteeigene Baselines und Profile

Primär ist immer die eigene Gerätebaseline. Sie verwendet Median, Median Absolute Deviation (MAD) sowie p05/p25/p50/p75/p95 statt einer undurchsichtigen Gesamtnote.

| Profil | Mindestwerte | Warm-up | Auslösung | Entwarnung | Cooldown |
|---|---:|---:|---:|---:|---:|
| **Conservative** (Standard) | 24 | 12 | 3 | 3 | 120 min |
| Balanced | 16 | 8 | 3 | 2 | 60 min |
| Sensitive | 10 | 5 | 2 | 2 | 30 min |
| Custom | konkrete Feldwerte | konkret | konkret | konkret | konkret |

Firmware- oder relevante Konfigurationswechsel beginnen ein neues Baseline-Segment und Warm-up. Ein einzelner Peak öffnet keinen Trend. Mehrere normale Werte schließen ihn. Der Cooldown begrenzt aktualisierte Warnungen; `present` kann weiterhin den aktuellen Zustand beschreiben.

## Vorsichtiger Peer-Vergleich

Peers müssen Generation, Modell/Model-Code, Profil, Messfähigkeiten und standardmäßig die Firmware-Hauptversion teilen. Die Mindestgröße beträgt drei Geräte einschließlich des aktuellen. Peer-Vergleich ergänzt nur die Eigenbaseline. Eine ungeeignete oder zu kleine Gruppe erzeugt keine Peer-Warnung. Die Observation dokumentiert Gruppengröße, Minimum, Kriterien, Auswahlgründe und – bei Verwendung – Peer-IDs.

## Observation-Kategorien

In der Config-Node getrennt aktivierbar:

- Recovery-/Fehlerlebenszyklus;
- Latenztrend;
- Temperaturtrend;
- Neustartmuster;
- RAM-/Dateisystemtrend;
- konservative elektrische Beobachtungen;
- Peer-Vergleich.

Latenztrends benötigen dauerhafte Abweichungen zur Eigenbaseline. Verschlechtern sich genügend Geräte gleichzeitig, wird ein **möglicher gemeinsamer Netzwerkfaktor** markiert, ohne eine Ursache zu behaupten.

Temperaturtrends sind von statischer `warning`-, `critical`- und Hardware-Overtemperature-Klassifikation getrennt. Gleichzeitige Leistung wird, soweit vorhanden, als Kontext angegeben. Ein Temperaturtrend löst niemals allein eine Abschaltung aus.

Die Neustartanalyse führt Uptime-Abfälle und eine begrenzte persistente Historie. Regelmäßige Neustarts werden als `planned`, manuelle/Firmware-Anforderungen als `requested` und nicht markierte Uptime-Abfälle als `unexpected` klassifiziert. Jeder Eintrag speichert geschätzte Neustart-/Erkennungszeit, Uptime danach und Uptime vor dem Neustart.

Die Ressourcenanalyse überspringt Geräte ohne Werte und verlangt dauerhafte RAM-/Dateisystemänderungen. Elektrische Beobachtungen arbeiten bewusst konservativ und aktivitätsbezogen. Null- und Nahe-null-Leistungsphasen gelten als reguläre Betriebszustände – einzeln, lang, zyklisch, täglich/nachts oder häufig zwischen Aus und Last wechselnd. Aktive Last wird nur mit einer ausreichend gefüllten Active-State-Baseline verglichen; der erste Wechsel von historisch 0 W zu Last reicht nicht aus. Elektrische Auslösungen verlangen mehr Wiederholungen als allgemeine Trends. Stark korrelierte Befunde für `powerW` und `energyRateWhPerHour` werden zusammengeführt. Zählerabfälle müssen weiterhin wiederholt auftreten; jeder verbleibende Befund nennt Nutzung, Reset, Datenlücke, Firmware oder Austausch als mögliche Erklärung und behauptet keinen Defekt.

## Observation Schema 2

Observations verwenden `shelly-admin.observation/2` und bleiben rückwärtsfreundliche JSON-Objekte. Lebenszyklen:

Version 0.5.0 ergänzt die kompatiblen Felder `notify` (effektive Benachrichtigungsentscheidung) und `deviceClass`. Offline wird erst nach der effektiven Zahl aufeinanderfolgender Fehler geöffnet. Kürzere Fehlerphasen bleiben als strukturierte technische Fehler und persistierte Vorfallzähler nachvollziehbar, erzeugen aber keine Offline- oder Recovery-Observation. Recovery wird erst nach der effektiven Mindestdauer des bestätigten Offline-Zustands ausgegeben.

- `opened` – Zustand wurde aktiv;
- `present` – weiterhin aktiv, kein neuer Übergang;
- `updated` – nach Cooldown wesentlich verändert;
- `cleared` – genügend Normalwerte haben geschlossen;
- `suppressed` – Warm-up, Datenmenge, Coverage oder Richtlinie reichen nicht.

Jede Anomalie enthält Messwert, Eigenbaseline, optionalen Peer-Vergleich, Confidence, Datenqualität, Gründe und Disclaimer. Es gibt weder Gesamtnote noch garantierte Ausfallprognose.

Ein Offline-Vorfall speichert genau einen aktiven `lastError` mit Auftretens-/letztem Auftretenszeitpunkt und Anzahl. Wiederholte Fehlversuche erzeugen kein weiteres Open-Event. Die erste erfolgreiche Discovery-, Monitor-, Firmwareprüfungs-, Updatevalidierungs- oder Rebootvalidierungsanfrage schließt den Fehler genau einmal, persistiert `lastResolvedError` mit Auftretens-/Auflösungszeit und Grund und erhält das Gerät im Inventar.

## Monitor-Modi und Status

Der Monitor bietet:

- **Nur aktueller Zustand**;
- **Nur Übergänge**;
- **Aktueller Zustand und Übergänge** (Standard und kompatibles Verhalten für bestehende Flows).

Der normale Bearbeitungsdialog der Monitor-Node enthält jetzt vier sichtbare, per Tastatur fokussierbare Ansichten:

- **Einstellungen** – alle bisherigen Monitorparameter sowie Start-/Abbrechen-Schaltflächen;
- **Aktuelle Befunde** – die zuletzt bekannten Runtime-Befunde, gruppiert als Firmware, Temperatur, Offline/Recovery, Trends, Ressourcen und elektrische Beobachtungen;
- **Historie** – die letzten 50 menschenlesbaren Befundzustände und Übergänge, neueste zuerst, einschließlich `opened`, `updated`, `present`, `cleared` und Recovery, ohne den Rohzeitreihenbestand auszugeben;
- **Gerätedetails** – Inventarauswahl sowie Identität, Modell, Generation, IP, Erreichbarkeit, Firmware, Temperatur, Latenz, Ressourcen, aktuelle/vorherige Uptime, letzter Neustart mit Klassifikation, effektive Neustartwerte mit Herkunft, nächster geplanter Neustart, aktive Befunde, aufgelöste Fehler und Baselines.

Jede Ergebnisansicht lädt nur beim ersten Wechsel auf diesen Tab im aktuell geöffneten Dialog, nach erneutem Öffnen des Dialogs oder über die sichtbare Schaltfläche **Aktualisieren**. Es gibt kein periodisches Editor-Refresh; Tabwechsel setzen daher Leseposition und Auswahl nicht wiederholt zurück. Beim manuellen Aktualisieren bleiben Scrollposition und ausgewähltes Gerät nach Möglichkeit erhalten. Lade-, Fehler- und Leerzustände sind sichtbar. Jede Befundkarte zeigt Schweregrad, verständlichen Titel, Gerät/Modell, IP, Erklärung, aktuellen Wert, Baseline oder Firmware-Ziel, Lifecycle und Zeitpunkt. Kritisch, Warnung, Info und Behoben sind visuell getrennt. Fehlende Gerätemesswerte erscheinen als **Nicht verfügbar** und niemals als Nullwert.

Die Editoransicht verwendet folgende nur lesende Admin-Routen:

- `GET /shelly-admin/nodes/:id/findings`
- `GET /shelly-admin/nodes/:id/history?limit=50` (serverseitig auf 1–200 begrenzt)
- `GET /shelly-admin/nodes/:id/devices`

Alle drei Routen verlangen die Node-RED-Berechtigung `shelly-admin.read`, deaktivieren Response-Caching und liefern ausschließlich freigegebene Betriebsfelder – niemals Zugangsdaten. Historie und aktuelle Befunde werden zusammen mit dem vorhandenen Context-Zustand persistiert; die menschenlesbare Historie bleibt auf 200 Einträge begrenzt.

Der Wartungsdialog bietet **Einstellungen**, **Aktueller Status**, **Geräteübersicht** und **Historie**. Klassenweite Firmwareprüfung, Firmwareupdate und Neustart sind über eigene Editor-Schaltflächen sowie `msg.deviceClass` möglich. Eine Klasse kann allein oder als sichere Schnittmenge mit exakten `msg.devices` gewählt werden; echte Updates/Neustarts verlangen weiterhin `dryRun:false` plus Bestätigung und laufen rollierend/seriell. Die Geräteübersicht ergänzt aktuelle Uptime, Uptime vor dem letzten Neustart, Neustartzeit/-klassifikation, effektives Intervall/Modus/Wartungsfenster mit Herkunft und den nächsten geplanten Neustart. Vorhandene Firmware-, Update-, Fehler-, Recovery-, Laufdaten und Filter bleiben erhalten. Fehlendes erscheint als **Nicht verfügbar**.

Wartung verwendet zusätzlich folgende nur lesenden, nicht cachebaren und durch `shelly-admin.read` geschützten Routen:

- `GET /shelly-admin/nodes/:id/maintenance/status`
- `GET /shelly-admin/nodes/:id/maintenance/devices`
- `GET /shelly-admin/nodes/:id/maintenance/history?limit=50` (serverseitig auf 1–200 begrenzt)

Abgeschlossene Wartungszusammenfassungen und ihre freigegebenen Geräteergebnisse werden additiv als begrenzte Historie (100 Läufe) persistiert. Zugangsdaten und beliebige private Geräte-Payloads werden nicht aufgenommen.

Die drei vorhandenen Ausgänge bleiben Gesundheit, Hinweise und Fehler; Observation Schema 2 erhält nur additive Felder. Warning-/Critical-Observations, Temperatur-Events und Karten enthalten maschinenlesbare und zweisprachig menschenlesbare Uptime. Bei deaktivierten Beta-Hinweisen erzeugt Beta-only-Verfügbarkeit keine Observation, keinen Befund, Statuszähler und keine Benachrichtigung; aktiviert öffnet sie einmal je Gerät/Version.

## Temperatursicherheit

Standardwerte: 70 °C Warning, 85 °C Critical, 5 °C Hysterese, drei aufeinanderfolgende Werte und 15 Minuten Cooldown. Hardware-Overtemperature bleibt getrennt. Automatische Abschaltung erfordert gleichzeitig:

1. Monitor-Modus `actions` und
2. exakte `id`-, `ip`- oder `mac`-Richtlinie mit `temperature.autoShutdown: true`.

```json
[
  {
    "match": { "id": "shellyplus1pm-aabbccddeeff" },
    "policy": {
      "temperature": {
        "warningC": 70,
        "criticalC": 85,
        "hysteresisC": 5,
        "consecutive": 3,
        "cooldownMinutes": 15,
        "autoShutdown": false,
        "outputs": [0]
      }
    }
  }
]
```

Nur bekannte Schaltausgänge werden adressiert. Automatisches Wiedereinschalten findet nie statt.

## Menschengerechte Überwachungsoberfläche
 
Die Überwachungsnode enthält zusätzliche Editoransichten:
 
- Aktuelle Befunde
- Historie
- Gerätedetails
 
Dadurch können Firmwarehinweise, Warnungen, Recovery-Ereignisse und Trends direkt im Node-RED-Editor betrachtet werden, ohne die JSON-Ausgaben analysieren zu müssen.
 
![Aktuelle Befunde](docs/images/current-findings.png)

## Vollständige importierbare Beispiele

Eine JSON-Datei aus `examples/` importieren; die Nodes müssen nicht manuell zusammengesetzt werden:

- `01-discovery-monitor.json` – kompakter Discovery-/Monitor-Einstieg;
- `02-safe-maintenance.json` – kompakter Wartungseinstieg;
- `03-complete-operations-en.json` – vollständiger englischer Flow für Bedienung, Abbruch, Dashboard, Benachrichtigungen, Debugging, Firmware, Recovery, Temperatur, Anomalien und Trends;
- `04-kompletter-betrieb-de.json` – funktional gleichwertiger deutscher Flow.
- `05-notify-routing.json` – minimaler Benachrichtigungsweg, der nur Observations mit `notify === true` weitergibt und `notificationText` einschließlich menschenlesbarer Uptime erzeugt.

Die vollständigen Flows verwenden nur diese Shelly-Admin-Nodes und Node-RED-Core-Nodes. Das Browser-Dashboard liegt unter `/shelly-admin-dashboard-en` beziehungsweise `/shelly-admin-dashboard-de` und aktualisiert sich alle 15 Sekunden. Das Benachrichtigungsrouting schreibt Übergangswarnungen in Runtime-Log und Debug-Seitenleiste und kann leicht um freigegebene E-Mail-, Teams-, MQTT- oder Webhook-Nodes ergänzt werden. Ein echtes Firmwareupdate ist doppelt durch ein explizites Flow-Context-Flag und eine exakte Platzhalter-Geräte-ID gesperrt; lesende Prüfung und Dry-run funktionieren unmittelbar nach Prüfung der Ziel-/Config-Werte. Siehe [examples/README.de.md](examples/README.de.md).

## Entwicklung und Prüfung

```bash
npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

Release-, npm-, Node-RED-, Docker-, Prüfsummen- und Git-Befehle stehen in [RELEASE.md](RELEASE.md). Änderungen stehen in [CHANGELOG.md](CHANGELOG.md) und [RELEASE-NOTES-0.5.1.md](RELEASE-NOTES-0.5.1.md).
## Regelmäßige Neustarts und Uptime-Historie (0.5.0)

Regelmäßige Neustarts sind standardmäßig deaktiviert. Aktiviere **Regelmäßige Neustarts** in der gemeinsamen Konfigurationsnode und setze **Zeit zwischen Neustarts (Tage)**. Der Standardwert beträgt 7 Tage. Ein erreichbares Gerät wird fällig, sobald seine gemeldete Uptime das Intervall erreicht. Fällige Geräte werden nacheinander neu gestartet; jedes Gerät muss wieder erreichbar sein, bevor das nächste verarbeitet wird. Firmware-/Update-Wartung hat Vorrang; Offline-Geräte und Geräte ohne Uptime-Telemetrie werden übersprungen.

Der Scheduler löst Aktivierung, Intervall, Modus und Uhrzeit je Gerät als Geräte-Override → Klasse → allgemein auf. Monitor-Gerätedetails, Wartungs-Geräteübersicht und Config-Reiter Geräte-Einstellungen zeigen aktuelle Uptime, Uptime vor dem letzten Neustart, Neustartzeit/-klassifikation, effektive Neustartwerte samt Herkunft und `scheduledFor` als nächsten geplanten Neustart. Zusätzlich stehen Message-Aktionen zur Verfügung:

```json
{"action":"scheduled-reboot-check"}
```

```json
{"action":"scheduled-reboot-now"}
```

Regelmäßige Neustarts sind eine betriebliche Gegenmaßnahme und ersetzen nicht die Ursachenanalyse instabiler Stromversorgung, WLAN-Verbindung, Firmware oder Installation.



Der Neustartzeitpunkt unterstützt **Sofort nach der eingestellten Zeit** und **Im nächsten Wartungsfenster**. Standard ist **03:00 Uhr lokaler Node-RED-Serverzeit**. Die Wartungshistorie speichert Erfolg/Fehler, Validierung, Recovery-Zeit und Uptime vor dem Neustart.
