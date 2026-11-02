# WOA Workout-Stream-Format

Aktueller Standard für den Workout-Stream im WOA1-Container ist `WST6`.

Diese Datei beschreibt nur den Workout-Stream-Block, nicht den äußeren WOA1-Container und nicht den GPS-Track-Block.

## Überblick

`WST6` ist ein kompakter 1-Hz-Stream mit:

- `distance`: delta-codiert in einem Blockformat, bevorzugt `uint8` bei effektiv `0.5 m` Encodierungsauflosung
- `power`: bevorzugt delta-codiert als `int16` mit Escape-Fallback auf absoluten `uint16`-Wert
- `heart rate`: absolut als `uint8`
- `cadence`: absolut als `uint8`
- `speed`: absolut als `uint16`, aber nur wenn keine vollständige Distanzserie vorhanden ist
- `altitude`: absolut als `int16` bei `0.1 m`-Quantisierung

Zeitstempel werden nicht pro Sample gespeichert. Es gibt:

- `baseTimestampMs` für Sample `0`
- `sampleIntervalMs` aktuell immer `1000`

Damit ergibt sich:

- `timestamp[i] = baseTimestampMs + i * sampleIntervalMs`

## Header

`WST6` beginnt mit folgendem Header:

| Offset | Typ | Bedeutung |
|---|---:|---|
| `0` | `char[4]` | Magic = `WST6` |
| `4` | `uint32 LE` | `recordCount` |
| `8` | `float64 LE` | `baseTimestampMs` |
| `16` | `uint32 LE` | `sampleIntervalMs` |
| `20` | `uint32 LE` | Byte-Länge Distanzblock |
| `24` | `uint32 LE` | Byte-Länge Powerblock |
| `28` | `uint32 LE` | Byte-Länge Heart-Rate-Block |
| `32` | `uint32 LE` | Byte-Länge Cadence-Block |
| `36` | `uint32 LE` | Byte-Länge Speed-Block |
| `40` | `uint32 LE` | Byte-Länge Altitude-Block |

Danach folgen die sechs Payload-Blöcke genau in dieser Reihenfolge.

## Sample-Serien

| Serie | Logischer Wert | Physischer Typ im Stream | Kodierung |
|---|---|---|---|
| `distance` | Meter | Blockformat | bevorzugt Delta-`uint8`, sonst absolute `uint32` |
| `power` | Watt | gemischt | erstes Sample `uint16`, danach Delta-`int16`, Escape -> absolute `uint16` |
| `heart rate` | bpm | `uint8` | absolut |
| `cadence` | rpm | `uint8` | absolut |
| `speed` | m/s | `uint16` | absolut, skaliert mit `*100`, nur Fallback |
| `altitude` | m | `int16` | absolut, skaliert mit `*10` |

## Distanzkodierung

### Interne Quantisierung

Die FIT-Distanz liegt als ganzzahliger Zentimeterwert vor und wird im Compact-Parser direkt in `0.5 m`-Schritte quantisiert. Eine zusätzliche Zwischenquantisierung findet nicht statt.

Im Stream wird intern der quantisierte Integerwert gespeichert:

- `compactDistanceQ = round(distanceCentimeters / 50)`
- Rückrechnung:
  - `distanceMeters = compactDistanceQ / 2`

Beispiel:

- `1234.5 m` -> `2469`
- Decoding: `2469 / 2 = 1234.5 m`

### Produktive Distanz-Encodierung

Der aktuelle produktive Distanzpfad heisst im Code jetzt:

- `uint8-q05m`

Historischer Legacy-Alias:

- `uint8-q02`

Wichtig:

- `uint8-q02` ist nur noch ein Kompatibilitätsname
- semantisch meint der aktuelle Produktpfad **nicht** `0.2 m`
- er arbeitet direkt auf den im Parser erzeugten `0.5 m`-Werten

Konkret:

- Encoder-Ausgangspunkt: `compactDistanceQ` in `0.5 m`
- für den `uint8-q05m`-Pfad wird `compactDistanceQ` unverändert gespeichert
- damit ergibt sich effektiv:
  - `distanceMeters = encodedDistanceQ * 0.5`

Das ist die heute produktive Distanzauflosung im Workout-Stream.

### Blockformat

Die Distanz wird in Blöcken von `128` Samples (`DELTA_BLOCK_SIZE`) gespeichert.

Jeder Block beginnt mit:

| Feld | Typ |
|---|---:|
| `mode` | `uint8` |
| `count` | `uint16 LE` |

Danach hängt der Payload vom `mode` ab.

### Mode `3`: `uint8`-Delta mit Escape-Resync, bevorzugter Fall

Verwendet, wenn alle Samples des Blocks auf dem kompakten Distanzpfad darstellbar sind.

Payload:

| Feld | Typ | Bedeutung |
|---|---:|---|
| `firstScaled` | `uint32 LE` | erster encodierter Distanzwert des Blocks |
| `token[1..n-1]` | `uint8[]` | Delta oder Escape |
| `absoluteTail[...]` | `uint32 LE[]` | absolute Resync-Werte für Escape-Fälle |

Formel:

- `value[0] = firstScaled`
- `token < 255` -> `value[i] = value[i-1] + token`
- `token == 255` -> `value[i] = nextAbsoluteFromTail`

Wichtig:

- Deltas dürfen nicht negativ sein
- `255` ist als Escape reserviert
- normale Inline-Deltas dürfen daher nur `0..254` sein

### Mode `0`: absoluter Fallback

Wenn ein Block nicht in `uint8`-Deltas passt, wird er voll absolut gespeichert.

Payload:

| Feld | Typ |
|---|---:|
| `value[0..n-1]` | `uint32 LE[]` |

### Overflow-/Fallback-Fall bei Distanz

Der aktuelle Distanzpfad hat zwei Ebenen:

1. bevorzugt `mode = 3`
   - bei Delta `0..254` wird inline gespeichert
  - bei größeren oder problematischen Sprüngen wird `255` geschrieben und der absolute Wert im Tail abgelegt
2. kompletter Block-Fallback auf `mode = 0`
  - wenn der Block wegen ungültiger Ausgangsdaten nicht auf dem kompakten Pfad darstellbar ist
  - zum Beispiel bei `NaN`/Sentinel an einer Stelle, an der der kompakte Pfad einen gültigen Startwert braucht

Damit ist der heutige Distanzpfad robuster als ein reiner Ganzblock-Fallback, aber nicht vollständig escape-only.

## Power-Kodierung

### Grundidee

Power wird in `WST6` nicht mehr rein absolut gespeichert.

Stattdessen:

- erstes Sample: absolut als `uint16`
- alle weiteren Samples: bevorzugt als Delta `int16`
- wenn ein Delta nicht in `int16` passt oder wegen `NaN` ungültig ist:
  - Escape schreiben
  - absoluten `uint16`-Wert in den Absolut-Tail schreiben

### Aufbau des Power-Blocks

Der Power-Block besteht logisch aus drei Teilen:

1. `firstValue` als `uint16`
2. Delta-Array mit `recordCount - 1` Einträgen als `int16`
3. Absolut-Tail mit nur den Escape-Fällen als `uint16[]`

### Escape-Wert

Als Escape für das Delta wird verwendet:

- `INT16_NAN = -32768`

Das ist absichtlich der `int16`-Wert, der für echte Deltas nicht zugelassen wird.

Gültige Delta-Werte sind:

- `-32767 .. +32767`

### Delta-Fall

Wenn das Delta passt:

- Delta direkt als `int16` schreiben

Formel beim Decoding:

- `power[i] = power[i-1] + delta`

### Overflow-/Fallback-Fall bei Power

Wenn eines davon eintritt:

- Delta ist nicht endlich
- Delta < `-32767`
- Delta > `32767`
- Vorwert/aktueller Wert ist ungültig

dann passiert:

1. ins Delta-Array wird `-32768` geschrieben
2. in den Absolut-Tail wird der aktuelle absolute `uint16`-Powerwert geschrieben

Beim Decoding:

1. Delta lesen
2. wenn Delta != `-32768`
   - normaler Delta-Pfad
3. wenn Delta == `-32768`
  - nächsten Wert aus dem Absolut-Tail lesen
   - diesen als echten aktuellen Powerwert nehmen

Das ist der aktuelle Overflow-/Escape-Mechanismus für Power.

## Heart Rate

Heart Rate wird absolut gespeichert:

- Typ: `uint8`
- Einheit: `bpm`

Keine Delta-Kodierung, kein Escape-Pfad.

## Cadence

Cadence wird absolut gespeichert:

- Typ: `uint8`
- Einheit: `rpm`

Keine Delta-Kodierung, kein Escape-Pfad.

## Speed

Speed wird nur gespeichert, wenn keine vollständige Distanzserie vorhanden ist.

Dann gilt:

- Typ: `uint16`
- interne Skalierung: `storedSpeed = round(speedMps * 100)`
- Rückrechnung: `speedMps = storedSpeed / 100`

Wenn Distanz vollständig vorhanden ist, ist der Speed-Block leer (`0` Bytes), weil Speed später aus Distanz rekonstruiert werden kann.

## Altitude

Altitude wird absolut gespeichert:

- Typ: `int16`
- Quantisierung: `0.1 m`
- interne Skalierung: `storedAltitude = round(altitudeMeters * 10)`
- Rückrechnung: `altitudeMeters = storedAltitude / 10`

Zulässiger Bereich:

- `-32768 .. 32767` in der quantisierten Darstellung
- also grob `-3276.8 m .. +3276.7 m`

Hier gibt es aktuell keinen Delta-Modus und keinen separaten Escape-Pfad.

## NaN-/Sentinel-Werte

Im Workout-Stream werden diese Sentinel-Werte verwendet:

| Konstante | Wert |
|---|---:|
| `UINT8_NAN` | `255` |
| `UINT16_NAN` | `65535` |
| `UINT32_NAN` | `4294967295` |
| `INT16_NAN` | `-32768` |
| `INT32_NAN` | `-2147483648` |

Wichtig:

- für Power ist `INT16_NAN` gleichzeitig der Escape-Marker im Delta-Block
- für Distanz gibt es keinen Sample-weisen Escape, sondern Block-Fallback

## Aktueller Standard

Im produktiven Compact-Pfad ist derzeit:

- Workout-Streamformat: `WST6`
- Power-Encoding: `delta16`
- Distance-Encoding: `uint8-q05m`

Legacy-Alias, der weiterhin akzeptiert wird:

- `uint8-q02`

Das ist im Code aktuell in [woa-format-compact.js](/Users/D025449/woa/src/public/js/woa-format-compact.js), [Workout.js](/Users/D025449/woa/src/shared/Workout.js) und [woa1Service.js](/Users/D025449/woa/src/services/woa1Service.js) implementiert.

## Historische Notiz: Escape-Resync bei Distanz

Dieser Abschnitt war früher als Designskizze für eine mögliche Nachfolgevariante gedacht.

Wichtig:

- die hier beschriebene Idee ist inzwischen **kein Zukunftskonzept mehr**
- sie entspricht heute im Kern bereits dem produktiven Distanzpfad mit `mode = 3`
- der Abschnitt bleibt nur als Hintergrundnotiz stehen

Ziel:

- nicht mehr ganze 128er-Blöcke auf absoluten Fallback werfen
- stattdessen bei problematischen Einzelstellen lokal resynchronisieren

### Motivation

Die Motivation war damals:

- nicht jeden problematischen Distanzfall sofort auf einen kompletten Absolut-Block kippen zu lassen
- stattdessen innerhalb eines Blocks lokal mit Escape und absolutem Resync weiterzumachen

### Vorgeschlagene Kodierung

Quantisierung wäre aus heutiger Sicht:

- Compact-Basis und Produktpfad: `compactDistanceQ = round(distanceCentimeters / 50)`

Ein Block würde weiter mit `mode` und `count` beginnen:

| Feld | Typ |
|---|---:|
| `mode` | `uint8` |
| `count` | `uint16 LE` |

Neuer vorgeschlagener Modus:

- `mode = 3`

Payload für `mode = 3`:

| Feld | Typ | Bedeutung |
|---|---:|---|
| `firstScaled` | `uint32 LE` | absoluter Startwert des Blocks |
| `token[1..n-1]` | `uint8[]` | Delta oder Escape |
| `absoluteTail[...]` | `uint32 LE[]` | nur für Escape-Fälle |

### Token-Semantik

Wir reservieren:

- `255` als Escape-Marker

Damit sind normale Deltas nur:

- `0..254`

Semantik:

- `token < 255`
  - normales Delta
  - `value[i] = value[i-1] + token`
- `token == 255`
  - Escape / Resync
  - nächsten Wert aus `absoluteTail` lesen
  - `value[i] = nextAbsolute`

### Decoder-Ablauf

Pseudologik:

```text
read firstScaled
current = firstScaled
emit current

for each token:
  if token < 255:
    current = current + token
  else:
    current = read next absolute uint32 from absoluteTail
  emit current
```

### Encoder-Regeln

Für jedes Sample `i > 0`:

1. `delta = current - previous`
2. Wenn gilt:
   - `delta` ist endlich
   - `delta >= 0`
   - `delta <= 254`
   dann:
   - `token = delta`
3. sonst:
   - `token = 255`
   - `current` in `absoluteTail` schreiben
   - Resync auf `current`

### Overflow-/Fallback-Fall

Der Overflow-/Inkonsistenz-Fall wäre dann sample-lokal statt block-global.

Das heisst:

- kein kompletter Block-Fallback mehr nur wegen eines Ausreissers
- nur genau dieses Sample bekommt
  - Escape
  - absoluten Resync-Wert

Typische Trigger für Escape:

- Delta > `254`
- Delta < `0`
- Delta nicht endlich
- Distanzsample ungültig oder inkonsistent

### Speichercharakteristik

Für einen Block mit `N` Samples und `E` Escape-Fällen:

- `3` Bytes Blockheader
- `4` Bytes `firstScaled`
- `N - 1` Bytes Tokens
- `E * 4` Bytes absolute Tail

Also:

```text
size = 3 + 4 + (N - 1) + 4E
     = N + 6 + 4E
```

Zum Vergleich:

- aktueller kompakter Distanzblock `mode = 3`:
  - `N + 6 + 4E`
- absoluter Fallback `mode = 0`:
  - `3 + 4N`

Das heisst:

- bei wenigen Escapes ist `mode = 3` fast so gut wie ein reiner Inline-Delta-Block
- und deutlich besser als kompletter Absolut-Fallback

### Beispiel

Quantisierte Distanzwerte:

```text
1000, 1004, 1008, 1400, 1404
```

Deltas:

```text
4, 4, 392, 4
```

Kodierung:

- `firstScaled = 1000`
- Tokens:
  - `4`
  - `4`
  - `255`
  - `4`
- Absolute Tail:
  - `1400`

Decoder:

```text
1000
1004
1008
1400
1404
```

### Praktische Empfehlung

Wenn wir das ausprobieren, wäre der pragmatische erste Schritt:

- 128er-Blockstruktur beibehalten
- innerhalb des Blocks `mode = 3` mit Escape-Resync einführen

Dann bleibt das Format lokal und robust, ohne den bisherigen Alles-oder-Nichts-Fallback des aktuellen Distanzmodells.
