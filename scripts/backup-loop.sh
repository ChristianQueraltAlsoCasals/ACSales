#!/bin/sh
# Copias pg_dump a /backups a las 02:00 y 14:00 (Europe/Madrid vía TZ).
set -eu
echo "[backup] servei iniciat; copies a les 02:00 i 14:00"
while true; do
  H=$(date +%H)
  M=$(date +%M)
  S=$(date +%S)
  # quitar ceros a la izquierda (ash)
  H=$((10#$H)); M=$((10#$M)); S=$((10#$S))
  now=$((H * 3600 + M * 60 + S))
  if [ "$now" -lt 7200 ]; then
    s=$((7200 - now))
  elif [ "$now" -lt 50400 ]; then
    s=$((50400 - now))
  else
    s=$((86400 - now + 7200))
  fi
  sleep "$s"
  TS=$(date +%Y%m%d_%H%M%S)
  if pg_dump "$DATABASE_URL" > "/backups/backup_${TS}.sql" 2>/backups/.last_error; then
    echo "[backup] ${TS} OK"
  else
    echo "[backup] ${TS} ERROR"
    rm -f "/backups/backup_${TS}.sql"
  fi
  ls -1t /backups/backup_*.sql 2>/dev/null | tail -n +61 | xargs -r rm -f
  sleep 60
done
