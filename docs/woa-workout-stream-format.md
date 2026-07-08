# WOA Workout-Stream-Format

Aktueller Standard fuer den Workout-Stream im WOA1-Container ist `WST6`.

Diese Datei beschreibt nur den Workout-Stream-Block, nicht den aeusseren WOA1-Container und nicht den GPS-Track-Block.

## Ueberblick

`WST6` ist ein kompakter 1-Hz-Stream mit:

- `distance`: delta-codiert in einem Blockformat, bevorzugt `uint8` bei Quantisierung auf `0.2 m`
- `power`: bevorzugt delta-codiert als `int16` mit Escape-Fallback auf absoluten `uint16`-Wert
- `heart rate`: absolut als `uint8`
- `cadence`: absolut als `uint8`
- `speed`: absolut als `uint16`, aber nur wenn keine vollstaendige Distanzserie vorhanden ist
- `altitude`: absolut als `int16` bei `0.1 m`-Quantisierung

Zeitstempel werden nicht pro Sample gespeichert. Es gibt:

- `baseTimestampMs` fuer Sample `0`
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
| `20` | `uint32 LE` | Byte-Laenge Distanzblock |
| `24` | `uint32 LE` | Byte-Laenge Powerblock |
| `28` | `uint32 LE` | Byte-Laenge Heart-Rate-Block |
| `32` | `uint32 LE` | Byte-Laenge Cadence-Block |
| `36` | `uint32 LE` | Byte-Laenge Speed-Block |
| `40` | `uint32 LE` | Byte-Laenge Altitude-Block |

Danach folgen die sechs Payload-Bloecke genau in dieser Reihenfolge.

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

Vor der Stream-Erzeugung wird Distanz in `0.2 m`-Schritte quantisiert.

Im Stream wird intern der quantisierte Integerwert gespeichert:

- `storedDistance = round(distanceMeters * 5)`
- Rueckrechnung:
  - `distanceMeters = storedDistance / 5`

Beispiel:

- `1234.6 m` -> `6173`
- Decoding: `6173 / 5 = 1234.6 m`

### Blockformat

Die Distanz wird in Bloecken von `128` Samples (`DELTA_BLOCK_SIZE`) gespeichert.

Jeder Block beginnt mit:

| Feld | Typ |
|---|---:|
| `mode` | `uint8` |
| `count` | `uint16 LE` |

Danach haengt der Payload vom `mode` ab.

### Mode `2`: `uint8`-Delta, bevorzugter Fall

Verwendet, wenn alle Deltas im Block im Bereich `0..255` liegen.

Payload:

| Feld | Typ | Bedeutung |
|---|---:|---|
| `firstScaled` | `uint32 LE` | erster quantisierter Distanzwert des Blocks |
| `delta[1..n-1]` | `uint8[]` | positive Deltas zum Vorgaenger |

Formel:

- `value[0] = firstScaled`
- `value[i] = value[i-1] + delta[i]`

Wichtig:

- Deltas duerfen nicht negativ sein
- Deltas duerfen nicht groesser als `255` sein

### Mode `0`: absoluter Fallback

Wenn ein Block nicht in `uint8`-Deltas passt, wird er voll absolut gespeichert.

Payload:

| Feld | Typ |
|---|---:|
| `value[0..n-1]` | `uint32 LE[]` |

### Overflow-/Fallback-Fall bei Distanz

Es gibt keinen Escape-Marker pro Sample.

Stattdessen gilt:

- wenn **ein** Sample-Delta im Block ungueltig ist
  - negativ
  - groesser als `255`
  - `NaN`/ungueltig
- dann faellt **der gesamte Block** auf `mode = 0` zurueck

Das ist der aktuelle Overflow-/Fallback-Mechanismus fuer Distanz.

## Power-Kodierung

### Grundidee

Power wird in `WST6` nicht mehr rein absolut gespeichert.

Stattdessen:

- erstes Sample: absolut als `uint16`
- alle weiteren Samples: bevorzugt als Delta `int16`
- wenn ein Delta nicht in `int16` passt oder wegen `NaN` ungueltig ist:
  - Escape schreiben
  - absoluten `uint16`-Wert in den Absolut-Tail schreiben

### Aufbau des Power-Blocks

Der Power-Block besteht logisch aus drei Teilen:

1. `firstValue` als `uint16`
2. Delta-Array mit `recordCount - 1` Eintraegen als `int16`
3. Absolut-Tail mit nur den Escape-Faellen als `uint16[]`

### Escape-Wert

Als Escape fuer das Delta wird verwendet:

- `INT16_NAN = -32768`

Das ist absichtlich der `int16`-Wert, der fuer echte Deltas nicht zugelassen wird.

Gueltige Delta-Werte sind:

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
- Vorwert/aktueller Wert ist ungueltig

dann passiert:

1. ins Delta-Array wird `-32768` geschrieben
2. in den Absolut-Tail wird der aktuelle absolute `uint16`-Powerwert geschrieben

Beim Decoding:

1. Delta lesen
2. wenn Delta != `-32768`
   - normaler Delta-Pfad
3. wenn Delta == `-32768`
   - naechsten Wert aus dem Absolut-Tail lesen
   - diesen als echten aktuellen Powerwert nehmen

Das ist der aktuelle Overflow-/Escape-Mechanismus fuer Power.

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

Speed wird nur gespeichert, wenn keine vollstaendige Distanzserie vorhanden ist.

Dann gilt:

- Typ: `uint16`
- interne Skalierung: `storedSpeed = round(speedMps * 100)`
- Rueckrechnung: `speedMps = storedSpeed / 100`

Wenn Distanz vollstaendig vorhanden ist, ist der Speed-Block leer (`0` Bytes), weil Speed spaeter aus Distanz rekonstruiert werden kann.

## Altitude

Altitude wird absolut gespeichert:

- Typ: `int16`
- Quantisierung: `0.1 m`
- interne Skalierung: `storedAltitude = round(altitudeMeters * 10)`
- Rueckrechnung: `altitudeMeters = storedAltitude / 10`

Zulaessiger Bereich:

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

- fuer Power ist `INT16_NAN` gleichzeitig der Escape-Marker im Delta-Block
- fuer Distanz gibt es keinen Sample-weisen Escape, sondern Block-Fallback

## Aktueller Standard

Im produktiven Compact-Pfad ist derzeit:

- Workout-Streamformat: `WST6`
- Power-Encoding: `delta16`
- Distance-Encoding: `uint8-q02`

Das ist im Code aktuell in [woa-format-compact.js](/Users/D025449/woa/src/public/js/woa-format-compact.js), [Workout.js](/Users/D025449/woa/src/shared/Workout.js) und [woa1Service.js](/Users/D025449/woa/src/services/woa1Service.js) implementiert.

## Alternative Distanzkodierung: `uint8` mit Escape und Resync

Dieser Abschnitt beschreibt eine moegliche Nachfolgevariante fuer Distanz. Sie ist aktuell nur Design, nicht produktiver Standard.

Ziel:

- nicht mehr ganze 128er-Bloecke auf absoluten Fallback werfen
- stattdessen bei problematischen Einzelstellen lokal resynchronisieren

### Motivation

Das heutige Modell hat diesen Nachteil:

- ein einzelner Ausreisser in einem 128er-Block
- oder ein einzelnes inkonsistentes Delta
- fuehrt dazu, dass der komplette Block auf `mode = 0` mit absoluten `uint32`-Werten kippt

Die Alternative waere:

- ein Block startet weiter mit einem absoluten Startwert
- danach kommen vorzugsweise kleine `uint8`-Deltas
- nur bei Overflow oder Inkonsistenz wird ein Escape-Marker gesetzt
- direkt danach wird ein neuer absoluter Resync-Wert gespeichert

### Vorgeschlagene Kodierung

Quantisierung bleibt:

- `storedDistance = round(distanceMeters * 5)`
- also `0.2 m` Aufloesung

Ein Block wuerde weiter mit `mode` und `count` beginnen:

| Feld | Typ |
|---|---:|
| `mode` | `uint8` |
| `count` | `uint16 LE` |

Neuer vorgeschlagener Modus:

- `mode = 3`

Payload fuer `mode = 3`:

| Feld | Typ | Bedeutung |
|---|---:|---|
| `firstScaled` | `uint32 LE` | absoluter Startwert des Blocks |
| `token[1..n-1]` | `uint8[]` | Delta oder Escape |
| `absoluteTail[...]` | `uint32 LE[]` | nur fuer Escape-Faelle |

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
  - naechsten Wert aus `absoluteTail` lesen
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

Fuer jedes Sample `i > 0`:

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

Der Overflow-/Inkonsistenz-Fall waere dann sample-lokal statt block-global.

Das heisst:

- kein kompletter Block-Fallback mehr nur wegen eines Ausreissers
- nur genau dieses Sample bekommt
  - Escape
  - absoluten Resync-Wert

Typische Trigger fuer Escape:

- Delta > `254`
- Delta < `0`
- Delta nicht endlich
- Distanzsample ungueltig oder inkonsistent

### Speichercharakteristik

Fuer einen Block mit `N` Samples und `E` Escape-Faellen:

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

- aktueller perfekter `mode = 2`-Block:
  - `N + 6`
- aktueller absoluter `mode = 0`-Block:
  - `3 + 4N`

Das heisst:

- bei wenigen Escapes ist `mode = 3` fast so gut wie `mode = 2`
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

Wenn wir das ausprobieren, waere der pragmatische erste Schritt:

- 128er-Blockstruktur beibehalten
- innerhalb des Blocks `mode = 3` mit Escape-Resync einfuehren

Dann bleibt das Format lokal und robust, ohne den bisherigen Alles-oder-Nichts-Fallback des aktuellen Distanzmodells.
