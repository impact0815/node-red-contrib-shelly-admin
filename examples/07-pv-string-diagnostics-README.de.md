# PV-String-Diagnose Add-on (FlowFuse Dashboard 2.0)

`07-pv-string-diagnostics-flowfuse.json` erweitert das AlphaESS-Dashboard um eine konfigurierbare Plausibilitätsprüfung für zwei PV-Strings.

Das Add-on ist insbesondere für Anlagen gedacht, bei denen an den beiden MPPT-Eingängen unterschiedlich viel DC-Leistung installiert ist.

## Beispielkonfiguration

Die Standardkonfiguration des Beispiels ist:

- PV1: 10 × 405 Wp = 4,05 kWp
- PV2: 8 × 405 Wp = 3,24 kWp
- Erwartetes momentanes Leistungsverhältnis unter vergleichbaren Bedingungen: 1,25 : 1
- Mindest-Gesamtleistung für eine Bewertung: 500 W
- Warnschwelle: 15 % normalisierte Abweichung
- Kritische Schwelle: 25 % normalisierte Abweichung
- Glättung: Median aus bis zu 10 qualifizierten Messwerten

## Bewertungsmethode

Die beiden Strings werden nicht anhand ihrer absoluten momentanen Leistung miteinander verglichen.

Stattdessen berechnet das Dashboard zunächst für jeden String:

`Spezifische Leistung = aktuelle Stringleistung / installierte Stringleistung`

Beispiel:

- PV1: 2.025 W / 4.050 Wp = 50 %
- PV2: 1.620 W / 3.240 Wp = 50 %

Obwohl PV1 in diesem Beispiel 405 W mehr Leistung liefert, arbeiten beide Strings bezogen auf ihre installierte Leistung gleich.

Das gemessene Leistungsverhältnis beträgt:

`2.025 W / 1.620 W = 1,25`

und entspricht damit genau dem aufgrund der installierten Leistungen erwarteten Verhältnis:

`4.050 Wp / 3.240 Wp = 1,25`

Das Dashboard bewertet diesen Zustand als plausibel.

## Erkennung von Abweichungen

Arbeitet einer der Strings im Verhältnis zu seiner installierten Leistung deutlich schwächer, wird die normalisierte Abweichung dargestellt.

Das Dashboard kann dabei zusätzlich kennzeichnen, welcher String relativ schwächer arbeitet.

Standardmäßig gelten:

- unter 15 % Abweichung: plausibel
- ab 15 %: auffällig
- ab 25 %: kritisch

Die Schwellenwerte können im Dashboard geändert werden.

## Schutz vor kurzfristigen Fehlbewertungen

Ein einzelner Messwert reicht für eine sinnvolle Bewertung von PV-Strings häufig nicht aus.

Das Add-on berücksichtigt deshalb nur Messwerte oberhalb einer konfigurierbaren Mindest-PV-Leistung und glättet mehrere qualifizierte Messwerte.

Standardmäßig werden bis zu 10 Messwerte verwendet.

Dadurch sollen kurzfristige Effekte beispielsweise durch wechselnde Bewölkung, Schatten oder unterschiedliche MPPT-Reaktionen weniger Einfluss auf die Bewertung haben.

> **Wichtig:** Die Anzeige ist eine Plausibilitätsprüfung und keine elektrische Fehlerdiagnose. Unterschiedliche Dachausrichtung, Neigung, Verschattung, Modultemperatur, Modultoleranzen oder das Verhalten der MPPT-Regler können legitime Unterschiede zwischen zwei Strings verursachen.

## Import in ein vorhandenes AlphaESS-Dashboard

1. `07-pv-string-diagnostics-flowfuse.json` in Node-RED importieren.

2. Die vorhandene Function **„Dashboard-Modell erzeugen“** durch **„Build dashboard model + PV config“** ersetzen oder die Erweiterung um `pvConfig` in die vorhandene Function übernehmen.

   Die bereits vorhandenen Verbindungen vom Dashboard-Modell zum AlphaESS-Hauptdashboard und zu anderen Dashboard-Widgets müssen erhalten bleiben.

3. Die `ui-template`-Node **„PV string diagnostics & configuration“** derselben FlowFuse-Dashboard-Gruppe bzw. Seite zuweisen wie das bestehende AlphaESS-Hauptdashboard.

4. Die Reihenfolge der neuen Template-Node so einstellen, dass die String-Diagnose direkt nach der vorhandenen AlphaESS-Anzeige erscheint.

5. Den Ausgang von **„Build dashboard model + PV config“** mit **„PV string diagnostics & configuration“** verbinden.

6. Den Ausgang von **„PV string diagnostics & configuration“** mit **„Save PV string configuration“** verbinden.

7. **„Save PV string configuration“** zurück mit **„Build dashboard model + PV config“** verbinden.

8. Deployen und das Dashboard neu laden.

## Konfiguration im Dashboard

Über **„Konfiguration“** können folgende Werte eingestellt werden:

- Name von String 1
- Name von String 2
- Anzahl der Module je String
- Wp-Leistung eines Moduls
- Mindest-Gesamtleistung für eine Bewertung
- Warnschwelle in Prozent
- kritische Schwelle in Prozent
- Anzahl der Messwerte zur Glättung

Die Konfiguration wird im Flow-Context unter dem Schlüssel

`alphaPvStringConfig`

gespeichert.

Wenn ein Context-Store namens `file` vorhanden ist, wird dieser verwendet. Andernfalls verwendet das Beispiel den Standard-Context-Store.

Für eine persistente Speicherung über einen Node-RED-Neustart hinweg sollte ein `localfilesystem`-Context-Store konfiguriert sein.

## Benötigte Daten

Das Add-on verwendet die ersten beiden Einträge aus:

`payload.data.details.inverter.pv`

Erwartet werden insbesondere die Werte:

- `power`
- `voltage`
- `current`

Beispiel:

`payload.data.details.inverter.pv[0]` → String 1

`payload.data.details.inverter.pv[1]` → String 2

Weitere vorhandene PV-Eingänge werden von dieser Version der Vergleichsanzeige nicht berücksichtigt.