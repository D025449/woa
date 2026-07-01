# Nginx Upstream Timing fuer Workout-Open Analyse

Ziel: sichtbar machen, wo zwischen Browser, Nginx und Node Zeit verloren geht.

## 1. Log-Format in Nginx anlegen

In der globalen Nginx-Konfiguration (`http { ... }`, meist `/etc/nginx/nginx.conf`) dieses Log-Format anlegen:

```nginx
log_format upstream_timing
  '$remote_addr - $remote_user [$time_local] '
  '"$request" $status $body_bytes_sent '
  'rt=$request_time '
  'uct=$upstream_connect_time '
  'uht=$upstream_header_time '
  'urt=$upstream_response_time '
  'ua="$upstream_addr" '
  'us="$upstream_status" '
  'ref="$http_referer" '
  'ua_str="$http_user_agent"';
```

Bedeutung:

- `rt`: komplette Request-Zeit aus Sicht von Nginx
- `uct`: Zeit bis Verbindung zum Upstream aufgebaut ist
- `uht`: Zeit bis der erste Header vom Upstream kommt
- `urt`: komplette Upstream-Zeit

## 2. Eigenes Access-Log fuer die App aktivieren

Im relevanten `server { ... }`-Block oder im passenden `location / { ... }`:

```nginx
access_log /var/log/nginx/cwa24-access.log upstream_timing;
```

Wenn du nur den App-Traffic separat sehen willst, ist das meist die beste Stelle.

## 3. Optional: dediziert fuer Workout-Open Requests loggen

Wenn du die Logs nur fuer die Workout-Open-Requests enger schneiden willst:

```nginx
map $request_uri $log_workout_open {
  default 0;
  ~^/workouts/[0-9]+/open$ 1;
}
```

Dann im `server { ... }`:

```nginx
access_log /var/log/nginx/cwa24-workout-open.log upstream_timing if=$log_workout_open;
```

Damit bleibt das normale Access-Log klein und du bekommst nur die interessanten Requests.

## 4. Konfiguration testen und laden

Auf Amazon Linux / EC2:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Live beobachten

Alle Workout-Open-Requests live mitlesen:

```bash
sudo tail -f /var/log/nginx/cwa24-workout-open.log
```

Oder falls du nur ein gemeinsames Access-Log gesetzt hast:

```bash
sudo tail -f /var/log/nginx/cwa24-access.log
```

## 6. Interpretation

Beispiel:

```text
rt=0.248 uct=0.000 uht=0.007 urt=0.007
```

Dann bedeutet das ungefaehr:

- Node war schnell (`uht`/`urt` sehr klein)
- aber Nginx-Request insgesamt war deutlich laenger (`rt`)
- also liegt die Zeit eher vor oder nach dem Upstream:
  - Client-Netz
  - TLS
  - Browser-Verhalten
  - langsame Leitung

Anderes Beispiel:

```text
rt=0.255 uct=0.001 uht=0.190 urt=0.191
```

Dann wartet Nginx wirklich lange auf Node bzw. die App.

## 7. Empfehlung fuer deinen Fall

Da dein PM2-Log fuer `/workouts/:id/open` aktuell nur etwa `5-7 ms` zeigt, ist die wahrscheinlichste Erwartung:

- `uht` und `urt` klein
- `rt` deutlich groesser

Wenn das so rauskommt, brauchen wir nicht weiter im Node-Code zu suchen, sondern muessen auf:

- Netzwerk / Bandbreite / RTT
- TLS / Keep-Alive
- eventuell Proxy- oder CDN-Verhalten

## 8. Sinnvolle Folgeanalyse

Wenn die Upstream-Zeiten klein sind, als naechstes pruefen:

1. HTTP/2 fuer TLS-Server aktiv?
2. Keep-Alive zwischen Client und Nginx aktiv?
3. Keep-Alive zwischen Nginx und Node aktiv?
4. Unnoetige Response-Kompression fuer kleine JSON-Antworten deaktivieren oder gegenmessen
5. Browser DevTools:
   - `Waiting (TTFB)`
   - `Content Download`
   - mit deaktiviertem Cache messen
