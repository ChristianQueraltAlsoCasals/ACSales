# Agente de Ventas — ALSO CASALS (ACSales)

Pantalla de carga de datos + Agente Inteligente (ventas/compras BC).

## Arrancar con Docker (recomendado)

```bash
copy .env.example .env
# Rellena BC / Anthropic / M365 en el .env de la raíz

docker compose up -d --build
```

App: http://localhost:8102

Primera vez desde JSON antiguos:

```bash
docker compose up -d db
npm run db:import
docker compose up -d --build
```

## Desarrollo local

```bash
copy .env.example .env   # un solo .env en la raíz
docker compose up -d db
npm run install:all
npm start
```

- Frontend: http://localhost:5173  
- API: http://localhost:3000  
- Postgres: localhost:5434  

## Configuración

**Un solo `.env` en la raíz** (como ACTDrive / achuman). No uses `server/.env`.

Plantilla: `.env.example` (infra + BC + Anthropic + M365 + bloque comentado del ecosistema AC).

## Estructura

```
client/              React + Vite + Tailwind
server/              Express + Postgres
bc_automation/       Playwright en el HOST (no va en la imagen)
docker-compose.yml   db + app + backup
.env                 secretos (gitignored)
.env.example         plantilla
```

## Playwright / Registrar

En el PC: `python bc_automation/servicio_registro.py` (:5055).  
Lee el mismo `.env` de la raíz. Desde Docker: `BC_REGISTRO_URL=http://host.docker.internal:5055`.
