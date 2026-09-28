"""
html_a_pdf.py — Convierte borradores HTML (plantilla oficial ALSO CASALS)
a PDF con Edge INVISIBLE (headless), sin diálogo de impresión.

Lo llama el backend de Node (/api/borradores/pdf) para generar en lote los
borradores que se piden desde el chat del Explorador de OTs. No hace falta
arrancarlo a mano.

Uso (lo hace el backend):
    python html_a_pdf.py trabajo.json

trabajo.json = {"salida": "carpeta", "docs": [{"nombre": "OT015129.pdf", "html": "ruta.html"}, ...]}
Imprime por stdout un JSON: {"ok": [...nombres...], "errores": {"nombre": "motivo"}}
"""

import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def main():
    trabajo = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    salida = Path(trabajo["salida"])
    salida.mkdir(parents=True, exist_ok=True)
    resultado = {"ok": [], "errores": {}}

    with sync_playwright() as p:
        try:
            navegador = p.chromium.launch(channel="msedge", headless=True)
        except Exception:
            navegador = p.chromium.launch(headless=True)  # respaldo: Chromium de Playwright
        pagina = navegador.new_page()
        for doc in trabajo["docs"]:
            nombre = doc["nombre"]
            try:
                html = Path(doc["html"]).read_text(encoding="utf-8")
                pagina.set_content(html, wait_until="load", timeout=60000)
                pagina.emulate_media(media="print")
                pagina.pdf(
                    path=str(salida / nombre),
                    format="A4",
                    print_background=True,
                    prefer_css_page_size=True,  # respeta el @page de la plantilla (márgenes)
                )
                resultado["ok"].append(nombre)
            except Exception as e:
                resultado["errores"][nombre] = str(e)
        navegador.close()

    print(json.dumps(resultado, ensure_ascii=False))


if __name__ == "__main__":
    main()
