# @impact0815/node-red-contrib-shelly-admin

[English](README.md) · **Deutsch**

Node-RED-Nodes zur lokalen Shelly-Flottenverwaltung: Netzwerkerkennung, persistentes Inventar, Zustandsüberwachung, begrenzte Historie, transparente Anomaliehinweise, Firmwareprüfung, abgesicherte rollierende Updates und konditionelle Neustarts. Gen1 und Gen2+ werden ohne fest eingebaute MQTT-Abhängigkeit unterstützt.

## Haftungs- und Sicherheitshinweis

> **⚠️ Nutzung auf eigene Gefahr – keine Gewährleistung.**
>
> Dies ist ein **inoffizielles Community-Projekt** und steht in keiner Verbindung zu Shelly oder Allterco; es wird von diesen Unternehmen weder unterstützt noch empfohlen. Die Software wird **„wie besehen“** und ohne Gewährleistung bereitgestellt. Soweit durch MIT-Lizenz und geltendes Recht zulässig, übernehmen Autoren und Mitwirkende keine Haftung für Geräte-, Elektro-, Gebäude-, Daten-, Folge- oder sonstige Schäden, Ausfälle, Verluste, Kosten oder Ansprüche aus der Nutzung.
>
> Shelly-APIs, Geräteverhalten und Firmware können sich ändern. Firmwareupdates, Neustarts, Relaisaktionen und automatische Abschaltung können Dienste unterbrechen oder Anlagen in einen unsicheren beziehungsweise unerwarteten Zustand versetzen. Zuerst **Probelauf (Dry-run)** verwenden, mit einer kleinen Pilotgruppe beginnen, **gestaffelt ausrollen**, stabile Strom- und Netzwerkversorgung sicherstellen, riskante Aktionen beaufsichtigen, Sicherungen vorhalten und fachgerecht installierte Elektrik verwenden.
>
> Temperaturüberwachung und -reaktionen sind nur betriebliche Hilfen. **Diese Software ist kein zertifiziertes Brand- oder Lebensschutzsystem** und ersetzt keine Rauchmelder, Schutzgeräte, Prüfungen, Beaufsichtigung oder fachgerechte Elektroinstallation.

Dieser Hinweis erläutert Betriebsrisiken; er ergänzt keine Einschränkung, die der [MIT-Lizenz](LICENSE) widerspricht.

## Nodes

| Node | Aufgabe | Ausgänge |
|---|---|---|
| `shelly-admin-config` | Gemeinsame Zugangsdaten, Ziele, Inventar, Richtlinien, Persistenz, Historie und Analyse | Konfigurationsnode |
| `shelly-admin-discovery` | Vollständige oder inkrementelle Erkennung und Inventarvalidierung | Inventar · Ereignisse · Fehler |
| `shelly-admin-monitor` | Zustandsabfrage, Historie, Anomaliehinweise und Temperaturregeln | Gesundheit · Hinweise · Fehler |
| `shelly-admin-maintenance` | Firmwareprüfung, Probelauf, rollierende Updates und konditionelle Neustarts | Ergebnis · Geräteergebnisse · Fehler |

Alle Ausgaben sind JSON-Objekte mit versioniertem `schema`, ISO-Zeitstempel und eindeutigen Gerätereferenzen. MQTT wird nicht vorausgesetzt; die strukturierten Nachrichten können bei Bedarf an MQTT-, Datenbank-, Dashboard- oder Benachrichtigungsnodes angeschlossen werden.

## Voraussetzungen und Installation

- Node.js ab 18
- Node-RED ab 3.1
- Berechtigung zur Abfrage der konfigurierten Netze und Geräte

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-shelly-admin
```

Lokales Paket:

```bash
npm install ./impact0815-node-red-contrib-shelly-admin-0.1.0.tgz
# alternativ ZIP entpacken und das Projektverzeichnis installieren
```

Node-RED neu starten und eine Konfigurationsnode sowie die benötigten Erkennungs-, Überwachungs- und Wartungsnodes anlegen.

## Erkennung und Identifikation

Ziele können beliebig kombiniert werden:

```text
192.168.1.0/24
192.168.10.20-40
10.20.30.40-10.20.30.55
10.0.0.8, 10.0.0.9
```

Die automatische Zielermittlung liest aktive IPv4-Schnittstellen ohne Loopback. Die kleinste automatische Präfixlänge (Standard `/24`) verhindert, dass große Firmen- oder VPN-Netze versehentlich vollständig expandiert werden; das globale Adresslimit (Standard `4096`) ist eine weitere Sicherung. Nur autorisierte Netze scannen.

Die Identifikation nutzt öffentliche Geräteantworten statt unsicherer Hostnamensschätzung:

- Gen2+: `/shelly`, `Shelly.GetDeviceInfo`, `Shelly.GetStatus`
- Gen1: `/shelly`, `/settings`, `/status`
- Modell, Anwendung/Profil, Komponentenschlüssel und eine kleine Gen1-Modellcode-Tabelle werden als Nachweise gespeichert.
- Das Inventar enthält Identifikationsvertrauen und Belege; Unsicherheit bleibt sichtbar.

Die Umsetzung orientiert sich technisch an der [offiziellen Shelly-API-Dokumentation](https://shelly-api-docs.shelly.cloud/) und der öffentlichen Architektur von [windkh/node-red-contrib-shelly](https://github.com/windkh/node-red-contrib-shelly). Fremder Quellcode wurde nicht übernommen.

## Persistentes Inventar über Node-RED Context

Private Node-RED-Dateien werden weder gelesen noch geschrieben. Der Zustand nutzt ausschließlich `node.context().get/set` und einen benannten Store.

Empfohlene Konfiguration in `settings.js`:

```js
contextStorage: {
  default: { module: "memory" },
  file: {
    module: "localfilesystem",
    config: { flushInterval: 30 }
  }
}
```

In der Konfigurationsnode **Name des Context-Stores** auf `file` setzen. Beim Start erfolgt ein Schreib-/Lesetest; die öffentliche Context-Konfiguration wird ausgewertet, soweit Node-RED sie bereitstellt:

- ein verifizierter `localfilesystem`-Store wird als dauerhaft gemeldet;
- ein nicht verfügbarer benannter Store fällt sauber auf den Standard-Store zurück und erzeugt eine verständliche Warnung;
- Memory- oder nicht eindeutig erkennbare Custom-Stores bleiben nutzbar, werden aber als flüchtig beziehungsweise ungeprüft angezeigt.

Nach einem Neustart werden Inventar und Analysezustand zuerst geladen. Ein initialer Lauf validiert bekannte Adressen. Ein Vollscan erfolgt nur bei leerem Inventar, auf ausdrückliche Anforderung oder bei fälligem Vollscan-Intervall. Dadurch wird nicht bei jedem Start das gesamte Netz neu inventarisiert.

Der dateibasierte Node-RED-Store arbeitet standardmäßig mit Cache. Bei hartem Prozessabbruch können noch nicht gemäß `flushInterval` geschriebene Werte verloren gehen; Intervall passend zwischen Haltbarkeit und Speicherverschleiß wählen.

## Historie und transparente Anomaliehinweise

Die Überwachung speichert pro Gerät eine begrenzte Rohhistorie (Standard 48 Stunden) und Zeitaggregate (Standard 90 Tage, Stundenblöcke). Die Aufbewahrung ist konfigurierbar. Verwendet werden, soweit vorhanden:

- Temperatur und Hardware-Overtemperature;
- HTTP-Antwortzeit und Erreichbarkeit;
- WLAN-RSSI, Uptime und erkannte Neustarts;
- freier RAM- und Dateisystemanteil;
- Firmware- und Konfigurationswechsel;
- Wirkleistung, Strom, Spannung und Energie.

Die Logik verwendet bewusst **keinen undurchsichtigen Gesamtscore**:

1. Mindesthistorie und Warm-up nach Firmware-/Konfigurationswechsel sind Pflicht.
2. Aktuelle Werte werden mit Median und medianer absoluter Abweichung (MAD) des Geräts verglichen.
3. Metrikspezifische absolute und robuste Schwellen müssen gemeinsam erfüllt sein; bei historisch null Streuung gilt ein strengerer absoluter Ersatz.
4. Vergleichsgeräte werden zuerst nach gleichem Modell, ersatzweise Typ gewählt; unzureichende Peer-Daten werden gemeldet und nicht erfunden.
5. Aufeinanderfolgende Abweichungen, Entwarnhysterese und Cooldown steuern Öffnen, Schließen und Wiederholung.
6. Fehlende Werte werden übersprungen und in der Datenqualität ausgewiesen.

Jede Beobachtung enthält `observation`, `baseline`, `deviation`, `peerComparison`, `confidence`, `dataQuality`, `reasons` und `lifecycle`. Es handelt sich ausdrücklich um einen **Frühwarnungs-/Anomaliehinweis**, nicht um eine garantierte Ausfallvorhersage.

## Sichere Temperaturregeln

Standard ist ausschließlich Beobachtung/Meldung. Automatische Abschaltung setzt **beides** voraus:

1. Überwachungsmodus `actions` und
2. exakte Geräterichtlinie (`id`, `ip` oder `mac`) mit `temperature.autoShutdown: true`.

Beispiel – bis zur bewussten Änderung von `autoShutdown` weiterhin deaktiviert:

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

Hardware-Overtemperature-Flags werden berücksichtigt. Es werden nur bekannte Schaltausgänge adressiert. **Automatisches Wiedereinschalten findet nie statt**, auch nicht nach Abkühlung oder Neustart.

## Firmware- und Neustartsicherheit

- Firmwareprüfung ist lesend.
- Probelauf ist Standard für Updates und Neustarts.
- Echte, über Eingang ausgelöste Updates/Neustarts brauchen `msg.confirm === true`.
- Leere Geräteauswahl bedeutet nie „alle“, solange `allowAll` nicht ausdrücklich aktiv ist.
- Rollierende Ausführung erfolgt sequenziell (`maxSimultaneouslyUnavailable: 1`).
- Nach jeder Anforderung wird auf Erreichbarkeit und Gesundheitswerte gewartet, dann folgt die Staffelverzögerung.
- Bedingungen: immer, Neustart erforderlich, Uptime-Schwelle, freie-RAM-Schwelle, Firmware verfügbar.
- Zeitplanmodus prüft und meldet standardmäßig nur. Automatische geplante Updates brauchen eine eigene Freigabe und deaktivierten Probelauf.

```js
msg.action = "reboot";
msg.devices = ["shellyplus1pm-aabbccddeeff"];
msg.condition = { type: "restartRequired" };
msg.dryRun = false;
msg.confirm = true;
return msg;
```

## Zugangsdaten und Netzwerksicherheit

Zugangsdaten liegen in Node-RED Credentials, nicht in Flow-Eigenschaften. Gen1-Basic- und Gen2+-Digest-Challenges werden unterstützt. Wenn ein Gerät lokal nur HTTP anbietet, ist der Verkehr nicht verschlüsselt; daher Netzsegmentierung und vertrauenswürdige Verwaltungsnetze verwenden. Passwörter erscheinen nie in Ausgaben.

## Entwicklung und Tests

```bash
npm install
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

Tests decken Zielparser und Limits, Gen1-/Gen2-Normalisierung, Persistenz-Fallback, Historien-/Anomaliesicherungen, Temperatur-Opt-in sowie Wartungsauswahl und Bedingungen ab. Der abhängigkeitsfreie Lint-Schritt prüft JavaScript-Syntax, JSON, Zeilenenden und Leerraum. GitHub Actions führt Linting, Tests und Paketprüfung für unterstützte Node.js-Versionen aus. Ein manuell freizugebender/tagbasierter npm-Workflow mit Provenance bereitet die Veröffentlichung vor.

Weitere Informationen: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [NOTICE.md](NOTICE.md).
