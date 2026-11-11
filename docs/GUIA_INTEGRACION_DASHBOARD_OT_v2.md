# Guía integración ACSales ↔ Dashboard (coste base OT) — v2

**Fecha:** 2026-11-11  
**Sustituye el criterio de lectura de costes de la v1.** La v1 sigue documentando auth y rutas; este documento fija el **contrato oficial** que Dashboard debe consumir.

---

## 1. Objetivo

1. **ACSales** expone costes **base** de la OT (App `precioC` + horas + sobra taller confirmada).
2. **Dashboard** lee el endpoint, aplica estructura / venta objetivo / ratios oficiales.
3. Más adelante **ACSales UI** leerá el resultado de Dashboard (`/api/acsales/ot-economico`).

No hay fichero JSON persistido de intercambio: Dashboard llama al **endpoint** y recibe la respuesta HTTP.

---

## 2. Endpoint

```http
GET /api/integracio/ots/ficha?codigo=AC015255/2026
X-Service-Key: <INTEGRACIO_SERVICE_KEY>
```

`version: 2` en la respuesta.

Bloques que importan para Dashboard:

| Campo | Uso |
|-------|-----|
| `meta.aplica_criterio_v2` | Si `false`, no recalcular con criterio nuevo (OT antigua / fuera de corte) |
| `meta.es_presupuesto`, `meta.p_venta_app` | Tipo OT y venta pactada |
| `meta.fecha_corte_config` | Fecha calendario configurada en ACSales (o `null`) |
| `coste_base` | **Fuente oficial de coste** (o `null` si no aplica v2) |
| `control.compras_pc` | Solo alerta; **no** entra en la fórmula |

`economico` / `coste` quedan como **legado** (ACTDrive compat); no usarlos para el cálculo nuevo.

---

## 3. Criterio de negocio (cerrado)

### Universo

| OT | ¿`aplica_criterio_v2`? |
|----|------------------------|
| Pendiente / en proceso (sin factura BC detectada) | Sí |
| Facturada y **sin** `OT_CRITERIO_V2_FECHA_CORTE` | **No** |
| Facturada con `fecha_factura >= fecha_corte` | Sí |
| Facturada anterior a la fecha de corte | **No** |

Fecha de corte: variable de entorno `OT_CRITERIO_V2_FECHA_CORTE=YYYY-MM-DD` (ej. `2025-10-01`).

### Coste material

- Oficial = **App `precioC`** (partes obra + taller gastado).
- Compras PC = control / alerta.

### Horas

- Presupuesto (PR): Movs. proyecto × 21,50 €/h.
- Admin: horas de partes App × 21,50 €/h.

### Sobra taller (preparado − gastado en faena)

| Estado | Default | Coste Confirmado | Coste Total |
|--------|---------|------------------|-------------|
| `pendiente` | **Sí** | No | Sí |
| `se_cobra` | | Sí | Sí |
| `devuelto` | | No | No |

Confirmación en ACSales (administración): `PUT /api/ot/taller-sobra` (sesión usuario).  
Persistencia en Postgres `app_state` (clave `taller_sobra:{CODIGO}`).

### Fórmulas

```text
coste_confirmado = horas + material_obra + material_taller_gastado + sobra.se_cobra
coste_total      = coste_confirmado + sobra.pendiente
```

---

## 4. Forma de la respuesta (`coste_base`)

Cuando `meta.aplica_criterio_v2 === true` y hay datos App:

```json
{
  "ok": true,
  "version": 2,
  "codigo": "AC015255/2026",
  "meta": {
    "es_presupuesto": false,
    "p_venta_app": null,
    "facturada": false,
    "fecha_factura": null,
    "fecha_corte_config": "2025-10-01",
    "aplica_criterio_v2": true,
    "motivo_exclusion": null,
    "estado_ot": "en_proceso_o_pendiente"
  },
  "coste_base": {
    "tarifa_mo": 21.5,
    "horas": { "cantidad": 12.5, "fuente": "partes_app", "importe": 268.75 },
    "material_obra": { "importe": 95.4, "fuente": "app_precioC" },
    "material_taller_gastado": { "importe": 40.0, "fuente": "app_precioC" },
    "taller_sobra": {
      "pendiente": { "importe": 22.5, "n_lineas": 1 },
      "se_cobra": { "importe": 0, "n_lineas": 0 },
      "devuelto": { "importe": 0, "n_lineas": 0 },
      "lineas": [
        {
          "articulo": "ART-001",
          "qty_sobra": 3,
          "precio_c": 7.5,
          "importe": 22.5,
          "estado": "pendiente"
        }
      ]
    },
    "coste_confirmado": 404.15,
    "coste_total": 426.65,
    "formula": {
      "confirmado": "horas + material_obra + material_taller_gastado + taller_sobra.se_cobra",
      "total": "coste_confirmado + taller_sobra.pendiente"
    }
  },
  "control": {
    "compras_pc": {
      "importe": 110.68,
      "n_lineas": 3,
      "nota": "No entra en coste_base; solo alerta/auditoria"
    },
    "alertas": []
  }
}
```

Si no aplica v2:

```json
"meta": { "aplica_criterio_v2": false, "motivo_exclusion": "facturada_anterior_a_fecha_corte" },
"coste_base": null
```

---

## 5. Variables de entorno (ACSales)

```env
INTEGRACIO_SERVICE_KEY=...
OT_CRITERIO_V2_FECHA_CORTE=2025-10-01
# vacío o ausente = no aplicar v2 a ninguna OT facturada
RENTABILIDAD_TARIFA_MO=21.5
```

---

## 6. Qué hace Dashboard / qué no

**Sí:** leer `coste_base.coste_confirmado` y/o `coste_total`; usar `meta.p_venta_app` si presupuesto; calcular estructura y venta objetivo.

**No:** tratar compras PC como coste oficial; editar estados de sobra (eso es ACSales); usar `economico.venta_objetivo_acsales` como cifra oficial.

Endpoint futuro Dashboard (sin cambio de nombre):

```http
GET /api/acsales/ot-economico?ot=AC015255/2026
```

---

## 7. Changelog

| Versión | Cambio |
|---------|--------|
| v1 | Ficha + coste + health; guía prueba local |
| v2 | Criterio coste_base: App precioC, Confirmado/Total, fecha corte, sobra confirmable |
