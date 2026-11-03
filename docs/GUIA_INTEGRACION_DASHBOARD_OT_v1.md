# Guía integración ACSales ↔ Dashboard (ficha OT) — v1

**Fecha:** 2026-11-02  
**Para:** desarrollo local Dashboard leyendo ACSales; luego Dashboard devolverá cálculos y ACSales los mostrará.

---

## 1. Objetivo

1. **Ahora (ACSales):** Dashboard (u otra app) puede consultar **toda la ficha económica/operativa** de una OT vía API S2S.
2. **Después (Dashboard):** calculará (estructura propia/general, venta objetivo oficial, etc.) y expondrá un endpoint de resultados.
3. **Más adelante (ACSales UI):** leerá ese endpoint de Dashboard y mostrará los resultados en la valoración OT.

---

## 2. Endpoints ACSales (ya implementados)

Base local típica: `http://localhost:8102`  
Base prod (ejemplo): `https://acsales.alsocasals.com`

Auth en **todas** las rutas `/api/integracio/*`:

```http
X-Service-Key: <INTEGRACIO_SERVICE_KEY>
```

o

```http
Authorization: Bearer <INTEGRACIO_SERVICE_KEY>
```

Misma clave que ACTDrive/Dashboard (`INTEGRACIO_SERVICE_KEY`).

| Método | Ruta | Uso |
|--------|------|-----|
| GET | `/api/integracio/health` | Ping + listado de rutas |
| GET | `/api/integracio/ots/ficha?codigo=AC015255/2026` | **Ficha completa** (Dashboard) |
| GET | `/api/integracio/ots/coste?codigo=AC015255/2026` | Coste resumido (contrato ACTDrive `acsales-client`) |

Alias de query: `codigo` · `no` · `ot` (cualquiera vale).

### 2.1 Qué trae `/api/integracio/ots/ficha`

| Bloque JSON | Contenido | Origen |
|-------------|-----------|--------|
| `meta` | código BC, id App, presupuesto, P venta/despessa App, segmento | ALSOAPP `dbo.ot` |
| `bc_lineas` | conteos venta/compra + nombres WS | BC OData |
| `horas_uso` | Movs. proyecto Uso+Recurso | BC Job Ledger |
| `compras_pc` | total + líneas PC | BC PurchaseLines |
| `cruce_material` | coste no facturado, sin coste, items | cálculo ACSales (compra↔venta) |
| `capas` | Registrado BC / Pedido venta / Validado App / No validado (3 secciones) | `/api/ot/capas` |
| `economico` | ingresos, MO×21,5, compras PC, NF, coste directo, venta posible ×1,68, VO local (fallback) | cálculo ACSales |
| `coste` | `{ horas, material_eur }` | compat ACTDrive |
| `fuentes` | trazabilidad | — |

**Nota:** `economico.venta_objetivo_acsales` usa fallback de estructura (22 %). La VO **oficial** debe venir de FinanceHub/Dashboard cuando exista el endpoint de la sección 3.

### 2.2 `/api/integracio/ots/coste` (ACTDrive)

Respuesta mínima compatible con `ACTDrive/server/src/acsales-client.js`:

```json
{
  "ok": true,
  "codigo": "AC015255/2026",
  "coste": { "horas": 12.5, "material_eur": 110.68, "consultado_en": "..." },
  "horas": 12.5,
  "material_eur": 110.68
}
```

`material_eur` = **suma compras PC** (no App `precioC`).

---

## 3. Endpoint futuro en Dashboard (nombre acordado)

Cuando Dashboard tenga los cálculos listos, abrir:

```http
GET /api/acsales/ot-economico?ot=AC015255/2026
```

**Nombre canónico (no cambiar sin avisar):** `/api/acsales/ot-economico`

Auth recomendada (igual que el resto FinanceHub ↔ ACTDrive):

```http
X-Service-Key: <INTEGRACIO_SERVICE_KEY>
```

### Contrato de respuesta previsto (Dashboard → ACSales)

```json
{
  "ok": true,
  "ot": "AC015255/2026",
  "generado_en": "ISO-8601",
  "a_presupuesto": false,
  "ingresos": 124.0,
  "coste_directo": 150.0,
  "estructura_propia": 12.3,
  "estructura_general": 8.1,
  "ratio_propia": 0.05,
  "ratio_general": 0.04,
  "margen_objetivo": 0.12,
  "venta_objetivo": 338.4,
  "venta_coef": 252.0,
  "coef_directo": 1.68,
  "resultado": -10.5,
  "margen_pct": -8.5,
  "fuente": "financehub",
  "detalle": {}
}
```

ACSales UI (fase posterior) leerá este endpoint y **mostrará** esas cifras en la valoración OT, sin recalcular estructura.

Variable de entorno prevista en ACSales (futuro):

```env
FINANCEHUB_URL=https://financehub.alsocasals.com
# o DASHBOARD_LIVE_URL=
INTEGRACIO_SERVICE_KEY=...   # misma clave
```

---

## 4. Probar desde local (desarrollador Dashboard)

### 4.A — ACSales en local · Dashboard en producción (recomendado para leer ficha)

1. En ACSales `.env` local:

```env
INTEGRACIO_SERVICE_KEY=<misma clave que Dashboard/ACTDrive producción>
PORT=8102
# BC + ALSOAPP (Tailscale) configurados como siempre
```

2. Arrancar ACSales local (`node server/server.cjs` o Docker puerto 8102).

3. Desde el PC del desarrollador Dashboard (o Postman):

```bash
curl -s -H "X-Service-Key: $INTEGRACIO_SERVICE_KEY" \
  "http://localhost:8102/api/integracio/health"

curl -s -H "X-Service-Key: $INTEGRACIO_SERVICE_KEY" \
  "http://localhost:8102/api/integracio/ots/ficha?codigo=AC015255/2026" | jq .
```

4. En el código **local** de Dashboard: apuntar un cliente temporal a `http://localhost:8102` (o `http://host.docker.internal:8102` si Dashboard corre en Docker) con la misma `INTEGRACIO_SERVICE_KEY`, parsear `ficha` y prototipar cálculos.

### 4.B — Dashboard prod ya consume ACSales prod

Cuando ACSales esté desplegado con `INTEGRACIO_SERVICE_KEY`:

```bash
curl -s -H "X-Service-Key: $INTEGRACIO_SERVICE_KEY" \
  "https://acsales.alsocasals.com/api/integracio/ots/ficha?codigo=AC015255/2026"
```

### 4.C — Cuando exista `/api/acsales/ot-economico` en Dashboard

Desde ACSales local contra Dashboard **producción**:

```bash
curl -s -H "X-Service-Key: $INTEGRACIO_SERVICE_KEY" \
  "https://financehub.alsocasals.com/api/acsales/ot-economico?ot=AC015255/2026"
```

(Ajustar host real del Dashboard/FinanceHub.)

---

## 5. Variables de entorno (checklist)

| App | Variable | Uso |
|-----|----------|-----|
| ACSales | `INTEGRACIO_SERVICE_KEY` | Auth entrante `/api/integracio/*` |
| ACTDrive | `ACSALES_URL` + `INTEGRACIO_SERVICE_KEY` | Cliente coste (`/api/integracio/ots/coste`) |
| ACTDrive | `ACSALES_COSTE_PATH` | Default `/api/integracio/ots/coste` |
| Dashboard (futuro) | mismo `INTEGRACIO_SERVICE_KEY` | Auth del endpoint `/api/acsales/ot-economico` |
| ACSales (futuro) | `FINANCEHUB_URL` / `DASHBOARD_LIVE_URL` | Leer resultados oficiales |

---

## 6. Orden de trabajo acordado

1. ~~Exponer ficha en ACSales~~ → **hecho** (`/api/integracio/ots/ficha`).
2. Dashboard local: consumir ficha, diseñar cálculos / mapear a FinanceHub.
3. Dashboard: abrir **`GET /api/acsales/ot-economico`**.
4. ACSales UI: cliente a ese endpoint + pintar venta objetivo / estructura oficiales en la valoración OT.

---

## 7. Changelog

| Versión | Cambio |
|---------|--------|
| v1 | Endpoints health, ficha, coste; guía prueba local ↔ prod; nombre futuro `/api/acsales/ot-economico` |
