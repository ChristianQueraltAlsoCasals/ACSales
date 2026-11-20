import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

DESTINO = Path(__file__).resolve().parents[1] / "src" / "ropaTrabajadores.js"
DESCARGAS = Path(r"C:\Users\MariaRufíCastell\Downloads")

CODIGOS = {
    "PR000001492207": ("Camiseta manga corta", "M"),
    "PR000001492206": ("Camiseta manga corta", "L"),
    "PR000001492208": ("Camiseta manga corta", "XL"),
    "PR000001492209": ("Camiseta manga corta", "XXL"),
    "PR000001492210": ("Camiseta manga corta", "XXXL"),
    "PR000001492225": ("Pantalones largos", "S"),
    "PR000001492224": ("Pantalones largos", "M"),
    "PR000001492223": ("Pantalones largos", "L"),
    "PR000001492226": ("Pantalones largos", "XL"),
    "PR000001492227": ("Pantalones largos", "52"),
    "PR000001492213": ("Jersey manga larga", "M"),
    "PR000001492212": ("Jersey manga larga", "L"),
    "PR000001492205": ("Jersey manga larga", "XL"),
    "PR000001492214": ("Jersey manga larga", "XXL"),
    "PR000001492211": ("Jersey manga larga", "XXXL"),
    "PR000001492220": ("Jaqueta de alta visibilidad", "M"),
    "PR000001492219": ("Jaqueta de alta visibilidad", "L"),
    "PR000001492221": ("Jaqueta de alta visibilidad", "XL"),
    "PR000001492222": ("Jaqueta de alta visibilidad", "XXL"),
    "PR000001492216": ("Sudadera de alta visibilidad", "M"),
    "PR000001492215": ("Sudadera de alta visibilidad", "L"),
    "PR000001492217": ("Sudadera de alta visibilidad", "XL"),
    "PR000001492218": ("Sudadera de alta visibilidad", "XXL"),
    "PR000001492229": ("Zapatos", "41"),
    "PR000001492230": ("Zapatos", "42"),
    "PR000001492231": ("Zapatos", "43"),
    "PR000001492228": ("Zapatos", "44"),
    "PR000001492232": ("Zapatos", "45"),
    "PR000001492233": ("Zapatos", "46"),
}


def cargar(ruta):
    raw = ruta.read_text(encoding="utf-8-sig")
    raw = raw[raw.find("<?xml"):]
    ns = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}
    root = ET.fromstring(raw)
    filas = []
    for row in root.findall(".//ss:Row", ns):
        celdas = []
        idx = 0
        for celda in row.findall("ss:Cell", ns):
            indice = celda.get("{urn:schemas-microsoft-com:office:spreadsheet}Index")
            if indice:
                idx = int(indice) - 1
            dato = celda.find("ss:Data", ns)
            valor = (dato.text or "") if dato is not None else ""
            while len(celdas) <= idx:
                celdas.append("")
            celdas[idx] = valor.strip()
            idx += 1
        if any(celdas):
            filas.append(celdas)
    return filas[1:]


def talla_de(texto):
    encontrado = re.search(r"(?:T[\.\-\s]*|talla\s*|N[ºo]\s*)(XXXL|3XL|XXL|XL|S|M|L|\d{2})\b", texto, re.I)
    if not encontrado:
        return ""
    talla = encontrado.group(1).upper()
    return "XXXL" if talla == "3XL" else talla


def fecha(valor):
    try:
        mes, dia, anio = valor.split("/")
        if int(anio) < 2000:
            return ""
        return f"{int(anio):04d}-{int(mes):02d}-{int(dia):02d}"
    except Exception:
        return ""


def main():
    vistos = set()
    compras = []
    for ruta in sorted(DESCARGAS.glob("roba_treballadors_*.xls")):
        for fila in cargar(ruta):
            bruto = fila[2] if len(fila) > 2 else ""
            if ":" in bruto:
                codigo, descripcion = bruto.split(":", 1)
            else:
                codigo, descripcion = bruto, ""
            codigo = codigo.strip()
            descripcion = descripcion.strip()
            if not descripcion:
                continue
            try:
                unidades = int(float(fila[3] or 0))
            except ValueError:
                unidades = 0
            if unidades <= 0:
                continue
            dia = fecha(fila[1] if len(fila) > 1 else "")
            estado = fila[4] if len(fila) > 4 else ""
            nombre = " ".join((fila[0] if fila else "").split())
            clave = (nombre.upper(), dia, codigo, unidades, estado)
            if clave in vistos:
                continue
            vistos.add(clave)
            if codigo in CODIGOS:
                prenda, talla = CODIGOS[codigo]
            else:
                prenda = descripcion
                talla = talla_de(descripcion)
            compras.append({
                "nombre": nombre,
                "fecha": dia,
                "prenda": prenda,
                "talla": talla,
                "uds": unidades,
                "estado": estado,
                "codigo": codigo,
            })
    compras.sort(key=lambda x: (x["nombre"], x["fecha"]))
    cuerpo = json.dumps(compras, ensure_ascii=False, indent=2)
    DESTINO.write_text(
        "/**\n"
        " * Ropa recogida por cada trabajador.\n"
        " * Sale de los listados roba_treballadors. El mas reciente es del 16/11/2026.\n"
        " */\n"
        'export const FECHA_LISTADO = "16/11/2026";\n\n'
        f"export const COMPRAS = {cuerpo};\n\n"
        "export function normNombre(s) {\n"
        "  return String(s || \"\")\n"
        "    .normalize(\"NFD\")\n"
        "    .replace(/[\\u0300-\\u036f]/g, \"\")\n"
        "    .toUpperCase()\n"
        "    .replace(/[^A-Z0-9]+/g, \" \")\n"
        "    .trim();\n"
        "}\n\n"
        "export function comprasDe(nombre) {\n"
        "  const n = normNombre(nombre);\n"
        "  if (!n) return [];\n"
        "  const exactos = COMPRAS.filter((c) => normNombre(c.nombre) === n);\n"
        "  if (exactos.length) return exactos;\n"
        "  const tokens = n.split(\" \").filter(Boolean);\n"
        "  const nombres = [...new Set(COMPRAS.map((c) => normNombre(c.nombre)))];\n"
        "  const candidatos = nombres.filter((cn) => {\n"
        "    const ct = cn.split(\" \").filter(Boolean);\n"
        "    if (tokens.length < 2 || ct.length < 2) return false;\n"
        "    return tokens.every((t) => ct.includes(t)) || ct.every((t) => tokens.includes(t));\n"
        "  });\n"
        "  if (candidatos.length !== 1) return [];\n"
        "  return COMPRAS.filter((c) => normNombre(c.nombre) === candidatos[0]);\n"
        "}\n",
        encoding="utf-8",
    )
    print(f"{len(compras)} lineas, {len({c['nombre'] for c in compras})} personas -> {DESTINO}")


if __name__ == "__main__":
    main()
