# Importierbare Beispiele

Alle JSON-Dateien sind vollständige Node-RED-Flows: **Menü → Importieren → Zwischenablage/Datei → Importieren → Deployen**. Vor dem Deploy die Shelly-Administrationskonfiguration öffnen und `targets` auf Netze begrenzen, deren Scan autorisiert ist. Für neustartbeständiges Inventar und Historie einen `localfilesystem`-Context-Store wählen.

| Flow | Zweck |
|---|---|
| `01-discovery-monitor.json` | Kompakter Einstieg für Discovery und Monitoring |
| `02-safe-maintenance.json` | Kompakter Einstieg für abgesicherte Wartung |
| `03-complete-operations-en.json` | Vollständiger englischer Betriebsflow mit Actions, Abbruch, Status, Benachrichtigungsrouting, Dashboard, Debugging, Firmware, Recovery, Temperatur, Anomalien und Trends |
| `04-kompletter-betrieb-de.json` | Funktional gleichwertiger vollständiger deutscher Flow |

## Ablauf des vollständigen Flows

1. **Discovery:** `action:"scan"` und `mode:"full"` starten; `action:"cancel"` bricht ab. Inventar, Lifecycle und Fortschritt werden angezeigt und für das Dashboard gespeichert.
2. **Monitor:** sofort starten, abbrechen, Status abfragen oder den periodischen Lauf aktivieren/deaktivieren. Die deployte Node bietet die anklickbaren Ansichten **Einstellungen**, **Aktuelle Befunde**, **Historie** und **Gerätedetails**. Eine Ergebnisansicht lädt beim ersten Wechsel und danach nur über ihre Aktualisieren-Schaltfläche; es gibt kein periodisches Editor-Refresh. Lesegeschützte Admin-Endpunkte zeigen Lade-, Fehler- und Leerzustände. Der Health-Pfad gibt kompakt `summaryText`/`summaryTextDe`/`humanSummary`/`findingsSummary`/`cards` aus; der Router behält strukturierte Observations für Benachrichtigung, Recovery, Temperatur, Ressourcen, elektrische Beobachtungen und Trends.
3. **Benachrichtigungen:** Warnungen/kritische `opened`- oder `updated`-Observations erzeugen eine Node-RED-Runtime-Warnung und eine Debug-Nachricht. Die Function-Node kann durch freigegebene E-Mail-, Teams-, MQTT- oder Webhook-Nodes ergänzt werden.
4. **Dashboard:** `/shelly-admin-dashboard-de` (oder `-en`) öffnen. Es nutzt nur Node-RED-Core-Nodes und aktualisiert sich alle 15 Sekunden.
5. **Firmware:** Die Prüfung ist lesend. Die deployte Wartungs-Node bietet **Einstellungen**, **Aktueller Status**, **Geräteübersicht** und **Historie**, ebenfalls mit einmaligem Laden beziehungsweise manueller Aktualisierung. Die Geräteübersicht zeigt verständliche Firmware-/Update-/Recovery-Felder und Filter für Update verfügbar, Fehler, Offline, Erfolgreich aktualisiert und Übersprungen. Ein Update prüft zuerst alle ausgewählten Geräte und verarbeitet danach ausschließlich policy-berechtigte Kandidaten. Der Dry-run liefert `plannedUpdates` ohne Update-, Staffel- oder Validierungswartezeit. Der echte Updatepfad bleibt gesperrt, bis der Flow-Context `shellyAdminArmRealUpdate` exakt `true` ist, verlangt `confirm:true` und verwendet bis zur bewussten Änderung die nicht passende Geräte-ID `REPLACE-WITH-EXACT-DEVICE-ID`.
6. **Recovery und Sicherheit:** Recovery-Lifecycle, Temperaturwarnungen, automatische Aktionsdatensätze, Firmware-Observations, Neustartmuster, Ressourcen-/elektrische Anomalien sowie Latenz-/Temperaturtrends werden an benannte Debug-Nodes geroutet.

Die Start-/Abbrechen-Schaltflächen im Editor funktionieren nach dem Deploy und entsprechen Nachrichten mit `msg.action`.
