#!/usr/bin/env python3
"""
=====================================================================
 EXTRACTOR DE FACTURAS — PDF anual (ALSO CASALS)
=====================================================================
 Un PDF con muchas facturas concatenadas, una OT por factura, y una
 factura que puede ocupar VARIAS páginas.

 Estructura detectada:
   · Nº Factura : "P000002"  (cambia de factura cuando cambia este nº)
   · Nº Obra    : "Nº Obra: P009484"  → identifica la OT
   · Cliente    : línea de razón social bajo FECHA FACTURA
   · Total      : el último importe de la última página de la factura
                  (BASE + IVA = TOTAL con IVA)
   · Descripción: texto libre del cuerpo (líneas de concepto)

 Salida: lista de facturas con { factura, obra, otNormalizada,
 cliente, total, descripcion }. La otNormalizada permite cruzar con
 el CSV de OTs y las líneas de BC.

 Uso:
   python extraer_facturas_pdf.py factura_anual.pdf salida.json
=====================================================================
"""
import sys, re, json, subprocess


def normalizar_ot(valor):
    """P009484 / AC009484/2024 / 9484 → '9484' (misma regla que el frontend)."""
    if not valor:
        return ""
    s = str(valor).strip().upper().split("/")[0]
    digitos = re.sub(r"\D", "", s)
    return digitos.lstrip("0") or ("0" if digitos else "")


def parse_importe(s):
    """'1.826,52' → 1826.52"""
    if not s:
        return 0.0
    return float(s.replace(".", "").replace(",", "."))


def extraer_texto(pdf_path):
    """Devuelve lista de textos, una por página."""
    out = subprocess.run(
        ["pdftotext", "-layout", pdf_path, "-"],
        capture_output=True, text=True
    ).stdout
    return out.split("\f")


def extraer_factura(paginas_texto):
    """Procesa las páginas de UNA factura (pueden ser varias) y devuelve el registro."""
    texto = "\n".join(paginas_texto)
    lineas_p1 = paginas_texto[0].split("\n")

    m_fact = re.search(r"\bP\d{6}\b", texto)
    m_obra = re.search(r"N[ºo]\s*Obra:\s*(\S+)", texto)

    # Cliente: en la cabecera, la razón social aparece a la derecha en la
    # línea siguiente a "FACTURA / FECHA FACTURA" (índice ~1). Tomamos la
    # primera línea no vacía tras la línea que contiene "FACTURA".
    cliente = None
    for i, l in enumerate(lineas_p1):
        if "FACTURA" in l.upper() and "FECHA" in l.upper():
            for j in range(i + 1, min(i + 4, len(lineas_p1))):
                cand = lineas_p1[j].strip()
                # el nombre del cliente no empieza por Pxxxxxx ni por dígitos
                if cand and not re.match(r"^P\d{6}", cand) and not re.match(r"^\d", cand):
                    cliente = re.sub(r"\s{2,}", " ", cand)
                    break
            break

    # Total con IVA: el mayor importe de la última página (el TOTAL).
    importes_ult = re.findall(r"\d[\d.]*,\d{2}", paginas_texto[-1])
    importes_all = re.findall(r"\d[\d.]*,\d{2}", texto)
    total = 0.0
    if importes_ult:
        total = max(parse_importe(x) for x in importes_ult)
    elif importes_all:
        total = max(parse_importe(x) for x in importes_all)

    # Descripción: líneas de concepto reales (cuerpo, tras "DESCRIPCION").
    descripciones = []
    for linea in texto.split("\n"):
        l = linea.strip()
        if not l:
            continue
        if any(k in l.upper() for k in [
            "FACTURA", "FECHA", "CODIGO CLIENTE", "C.I.F", "COD. ARTICULO",
            "SUMA Y SIGUE", "SUMA ANTERIOR", "BASE IMPONIBLE", "FORMA DE PAGO",
            "SWIFT", "EN COMPLIMENT", "ALSOCASALS", "PAG.", "N\u00ba OBRA", "Nº OBRA",
            "BRUTO", "ALBARAN", "COMANDA", "@",
        ]):
            continue
        # descartar líneas que son solo números/códigos/importes
        if re.fullmatch(r"[\d.,\s%€:-]+", l):
            continue
        if re.match(r"^(TR|OT\d|E\d):", l):
            continue
        if len(l) > 4:
            descripciones.append(re.sub(r"\s{2,}", " ", l))

    obra = m_obra.group(1) if m_obra else None
    return {
        "factura": m_fact.group(0) if m_fact else None,
        "obra": obra,
        "otNormalizada": normalizar_ot(obra),
        "cliente": cliente,
        "total": round(total, 2),
        "descripcion": " · ".join(descripciones[:6]) if descripciones else None,
        "paginas": len(paginas_texto),
    }


def procesar_pdf(pdf_path):
    paginas = extraer_texto(pdf_path)
    facturas = []
    grupo = []
    factura_actual = None

    for pag in paginas:
        if not pag.strip():
            continue
        m = re.search(r"\bP\d{6}\b", pag)
        num = m.group(0) if m else None

        if num and num != factura_actual:
            # empieza una factura nueva → cerrar la anterior
            if grupo:
                facturas.append(extraer_factura(grupo))
            grupo = [pag]
            factura_actual = num
        else:
            grupo.append(pag)

    if grupo:
        facturas.append(extraer_factura(grupo))

    return facturas


if __name__ == "__main__":
    pdf = sys.argv[1] if len(sys.argv) > 1 else "factura_anual.pdf"
    salida = sys.argv[2] if len(sys.argv) > 2 else "facturas.json"
    facturas = procesar_pdf(pdf)
    with open(salida, "w", encoding="utf-8") as f:
        json.dump(facturas, f, ensure_ascii=False, indent=2)
    print(f"{len(facturas)} facturas extraídas → {salida}")
