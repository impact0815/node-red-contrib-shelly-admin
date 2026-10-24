# Importierbare Beispiele

Alle JSON-Dateien sind vollständige Node-RED-Flows: **Menü → Import → Zwischenablage/Datei → Importieren → Deploy**. Öffne vor dem Deploy die Shelly-Administrations-Config-Node und beschränke `targets` auf Netzwerke, die du scannen darfst. Wähle einen `localfilesystem`-Context-Store, damit Inventar und Verlauf einen Neustart überstehen.

| Flow | Zweck |
|---|---|
| `01-discovery-monitor.json` | Kompakter Einstieg für Discovery und Monitoring |
| `02-safe-maintenance.json` | Kompakter Einstieg für abgesicherte Wartung |
| `03-complete-operations-en.json` | Vollständiger englischer Betriebs-Flow mit Aktions-Injects, Abbruch, Status, Benachrichtigungs-Routing, Dashboard, Debugging, Firmware-Workflows, Recovery, Temperatur-, Anomalie- und Trendbehandlung |
| `04-kompletter-betrieb-de.json` | Funktional gleichwertiger vollständiger deutscher Flow |
| `05-notify-routing.json` | Minimales Routing-Beispiel, das nur Observations mit `notify === true` weiterleitet; den letzten Node mit einem freigegebenen Signal-Sender verbinden |
| `06-fleet-dashboard-flowfuse.json` | Zweisprachiges (DE/EN) Flotten-Dashboard für FlowFuse Dashboard 2.0; benötigt `@flowfuse/node-red-dashboard` |

## Rundgang durch den vollständigen Flow

1. **Discovery:** `action:"scan"` mit `mode:"full"` injizieren; Abbruch mit `action:"cancel"`. Inventar und Lifecycle/Fortschritt werden angezeigt und für das Dashboard zwischengespeichert.
2. **Monitor:** sofort ausführen, abbrechen, Status abfragen oder den periodischen Zeitplan ein-/ausschalten. Öffne die deployte Node für die anklickbaren Ansichten **Einstellungen**, **Aktuelle Befunde**, **Verlauf** und **Gerätedetails**. Eine Ergebnisansicht lädt einmal bei der ersten Auswahl und danach nur über ihren Aktualisieren-Button; es gibt keine periodische Aktualisierung im Editor. Die lesegeschützten Admin-Endpunkte zeigen Lade-, Fehler- und Leerzustände sichtbar an. Der Health-Pfad liefert kompakte Felder `summaryText`/`summaryTextDe`/`humanSummary`/`findingsSummary`/`cards`, während der Router strukturierte Observations für Benachrichtigung, Recovery, Temperatur-, Ressourcen-, elektrische und Trendbehandlung beibehält.
3. **Benachrichtigungen:** Observations ab 0.5.0 enthalten bereits die effektive `notify`-Entscheidung und `deviceClass`. Das eigene Beispiel leitet nur `notify === true` weiter; ersetze dessen Debug-Node durch deine freigegebene Signal-, E-Mail-, Teams-, MQTT- oder Webhook-Node.
4. **Dashboard:** im Browser `/shelly-admin-dashboard-de` (oder `-en`) öffnen. Es nutzt nur Node-RED-Core-Nodes (HTTP/Function/Response) und aktualisiert sich alle 15 Sekunden. Eine Alternative für FlowFuse Dashboard 2.0 findest du unten unter [Flotten-Dashboard](#flotten-dashboard-flowfuse-dashboard-20).
5. **Firmware:** die Prüfung ist nur lesend. Öffne die deployte Maintenance-Node für **Einstellungen**, **Aktueller Status**, **Geräteübersicht** und **Verlauf**. Diese Ansichten verwenden dasselbe einmalige/manuelle Aktualisieren. Die Geräteübersicht bietet lesbare Firmware-/Update-/Recovery-Felder sowie die Filter Update verfügbar, Fehler, Offline, Erfolgreich aktualisiert und Übersprungen. Ein Update prüft zuerst alle ausgewählten Geräte und verarbeitet danach nur richtlinienkonforme Kandidaten. Der Dry-run liefert `plannedUpdates` und löst kein Update, keine Staffelung und keine Validierungswartezeit aus. Der echte Update-Pfad bleibt gesperrt, solange der Flow-Context `shellyAdminArmRealUpdate` nicht exakt `true` ist; er erfordert `confirm:true` und zielt weiterhin auf den nicht passenden Platzhalter `REPLACE-WITH-EXACT-DEVICE-ID`, bis dieser bewusst geändert wird.
6. **Recovery und Sicherheit:** Recovery-Lifecycle, Temperaturwarnungen, Protokolle automatischer Aktionen, Firmware-Observations, Neustartmuster, Ressourcen-/elektrische Anomalien sowie Latenz-/Temperaturtrends werden an beschriftete Debug-Nodes geleitet.

Die Start-/Abbrechen-Schaltflächen im Editor funktionieren erst, wenn die Node deployt ist. Ihre Aktionen entsprechen Nachrichten mit `msg.action`.


## Uptime- und Beta-Hinweis-Felder ab 0.5.0

Alle Beispiel-Config-Nodes speichern `showBetaFirmwareNotices:false`; aktiviere es nur, wenn ein reiner Beta-Hinweis je Gerät/Version gewünscht ist. Observations mit Warning/Critical liefern `uptimeSec`, `uptimeText` und `uptimeTextDe`. Die vollständigen englischen/deutschen Flows und `05-notify-routing.json` erzeugen Benachrichtigungstexte mit lesbarer Uptime und behalten die Bedingung `notify === true` bei.

## Flotten-Dashboard (FlowFuse Dashboard 2.0)

`06-fleet-dashboard-flowfuse.json` ist eine Alternative zum Core-Node-Dashboard der Beispiele 03/04. Es stellt die Ausgaben deiner vorhandenen Discovery-, Monitor- und Maintenance-Nodes in [FlowFuse Dashboard 2.0](https://dashboard.flowfuse.com/) dar. Es wird keine zusätzliche Config-Node und kein zusätzlicher Scan benötigt.

### Funktionen

- **Kennzahlen-Kopf:** online, offline, Hinweise, verfügbare Updates, Gesamtleistung, wärmstes Gerät; Klick auf eine Kennzahl filtert.
- **Laufstatus** mit Fortschritt für Discovery, Monitor und Wartung.
- **Ansichten:** Kacheln, sortierbare Tabelle, Hinweise (aktive Observations, Lifecycle-Verlauf, technische Fehler) und Firmware (aktuelle/Ziel-Version, Beta-Angebote, Dry-run und Update für ausgewählte Geräte).
- **Suchen, Filtern, Sortieren, Gruppieren:** Volltextsuche über Name, IP, Modell, App, ID und MAC; Filter nach Geräteart, Generation, Geräteklasse und Status; 12 Sortierungen inklusive numerischer IP-Sortierung; Gruppierung nach Geräteart, Generation, Geräteklasse oder Status.
- **Gerätedetails:** Stammdaten und Messwerte (fehlende Werte erscheinen als „Nicht verfügbar“, nie als 0), 24-h-Verläufe für Temperatur, Leistung und WLAN, aktive Observations, Link zur Weboberfläche, Abfragen, Firmwareprüfung, Neustart, Update und Rohdaten.
- **Sprachen:** Deutsch und Englisch, im Kopf umschaltbar und im Browser gespeichert. Zahlen, Datumsangaben und relative Zeiten folgen der gewählten Sprache; Observation-Texte nutzen `summaryTextDe` bzw. `summaryText`.
- **Übersichtskarte** für eine Dashboard-Startseite.
- Observations werden unabhängig von `notify` angezeigt; für Benachrichtigungen `05-notify-routing.json` verwenden.

### Geräte-Einordnung

Geräte werden vorrangig über ihren **Shelly-Modellcode** eingeordnet. Bei Gen2+ (`SN` Plus, `SP` Pro, `S3` Gen3, `S4` Gen4) bestimmen die zwei Buchstaben nach dem Präfix die Geräteart:

| Code | Geräteart | Beispiele |
|---|---|---|
| `SW` | Relais / Schalter | `SNSW-001P8EU` (Plus 1PM Mini), `S3SW-…` (1PM Gen3) |
| `PM`, `EM` | Energiemessung | `S3PM-001PCEU16` (PM Mini Gen3), `S4EM-001PXCEU16` (EM Mini Gen4), `SPEM-…` (Pro 3EM) |
| `PL` | Steckdose | `SNPL-…` (Plus Plug S) |
| `DM` / `DC` | Dimmer / RGBW | `SNDM-…`, `SNDC-…` |
| `SN` | Sensor (`SNSN-0024X` i4 als Eingang) | `SNSN-0013A` (Plus H&T) |

Gen1-Geräte werden über ihre `SH…`-Präfixe erkannt. Geräte im Rollladenprofil erscheinen als Rollläden. Ohne Modellcode werden App-Name und zuletzt Modellname verwendet: „1PM/2PM“ gilt als Schalter mit Messung, „PM/EM“ ohne vorangestellte Ziffer als Messgerät.

### Einrichtung

1. Dashboard-Paket installieren: `npm install @flowfuse/node-red-dashboard`
2. `06-fleet-dashboard-flowfuse.json` importieren und deployen.
3. Die Link-Out-Nodes **„Shelly → Dashboard …“** in den Tab mit deinen shelly-admin-Nodes verschieben (`Ctrl+X`, `Ctrl+V`; Link-Verbindungen bleiben erhalten) und verbinden:

   | Node | Ausgang 1 | Ausgang 2 | Ausgang 3 |
   |---|---|---|---|
   | Discovery | Inventar | Ereignisse | Fehler |
   | Monitor | Health | Hinweise | Fehler |
   | Maintenance | Wartung Ergebnis | Wartung Fortschritt | Fehler |

4. Die Link-In-Nodes **„Dashboard-Befehl → …“** in denselben Tab verschieben und jeweils mit dem **Eingang** der passenden Discovery-, Monitor- oder Maintenance-Node verbinden.
5. Deployen, `/dashboard/shellies` öffnen und **Inventar prüfen** klicken.

### Sicherheit

- Firmwareupdates und Neustarts sind nur möglich, solange die **Wartung im Dashboard freigeschaltet** ist (10 Minuten).
- Nur ausgewählte Geräte, **max. 5 pro Befehl**.
- **Zweistufige Bestätigung** im Dashboard, zusätzlich serverseitig im Flow geprüft.
- Die Maintenance-Node erhält `confirm:true`; ihre Standardrichtlinie „nur Stable“ gilt weiterhin.
- Firmwareprüfung und Dry-run sind nur lesend. „Aus Dashboard entfernen“ blendet ein Gerät nur im Dashboard aus; das Inventar bleibt unverändert.

### Persistenz

Dashboard-Modell und 24-h-Verlauf liegen im Context-Store `file`, mit Rückfall auf den Standard-Store (Daten gehen dann beim Neustart verloren):

```javascript
contextStorage: {
    default: { module: "memory" },
    file: { module: "localfilesystem", config: { flushInterval: 30 } }
},
```

### Fehlerbehebung

| Symptom | Ursache / Lösung |
|---|---|
| „Noch keine Geräte“ | Link-Out-Nodes nicht verbunden oder noch kein Inventarlauf abgeschlossen. **Inventar prüfen** klicken. |
| Messwerte fehlen bei einem Gerät | Das Gerät liefert sie nicht, oder die Payload nutzt einen anderen Feldnamen. In der Detailansicht **Rohdaten anzeigen** und ein Issue anlegen. |
| Gerät in falscher Kategorie | **Modell / Code** und **App / Profil** aus der Detailansicht notieren und ein Issue anlegen. |
| Update-/Neustart-Button deaktiviert | Zuerst **Wartung freischalten** klicken. |
| „not properly configured“ nach dem Import | Seite `Shellies` deinem Dashboard (`ui-base`) und die Gruppen ihren Seiten zuweisen. |
