"""PASO 1: abrir borrador de factura de compra por deep link y salir. No Traer albaranes."""
from __future__ import annotations

import json
import re
import sys

from playwright.sync_api import sync_playwright

from traer_albaranes_compra import (
    CARPETA_PERFIL,
    abrir_factura,
    captura,
    cerrar_dialogo_pausa,
    cerrar_globos,
    en_ficha,
    es_login,
    maximizar,
    pagina_muestra_factura,
    url_ficha_factura_compra,
)


def texto_pagina(pagina) -> str:
    mejor = ""
    for marco in pagina.frames:
        try:
            t = marco.inner_text("body", timeout=1500) or ""
            if len(t) > len(mejor):
                mejor = t
        except Exception:
            pass
    return mejor


def main() -> int:
    factura = (sys.argv[1] if len(sys.argv) > 1 else "PFC26-003650").strip()
    solo_url = "--url-only" in sys.argv
    if solo_url:
        print(url_ficha_factura_compra(factura))
        return 0

    if not CARPETA_PERFIL.exists():
        print(
            json.dumps(
                {"ok": False, "error": "Falta perfil_navegador. Ejecuta login_setup.py"},
                ensure_ascii=False,
            )
        )
        return 1

    with sync_playwright() as p:
        contexto = p.chromium.launch_persistent_context(
            str(CARPETA_PERFIL),
            channel="msedge",
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )
        pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
        try:
            maximizar(pagina)
            abierta = abrir_factura(pagina, factura)
            if es_login(pagina):
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "error": "Hace falta login en BC. Maria debe iniciar sesion.",
                            "url": pagina.url,
                        },
                        ensure_ascii=False,
                    )
                )
                return 1
            if not abierta.get("ok"):
                print(json.dumps({"ok": False, "factura": factura, **abierta}, ensure_ascii=False))
                return 1

            cerrar_dialogo_pausa(pagina)
            cerrar_globos(pagina)
            texto = texto_pagina(pagina)
            tiene_albaran = bool(re.search(r"ALBC\d{2}-\d+", texto, re.I))
            ruta = captura(pagina, factura, "paso1_abierta")
            out = {
                "ok": en_ficha(pagina, factura),
                "enFicha": en_ficha(pagina, factura),
                "muestraNumero": pagina_muestra_factura(pagina, factura),
                "factura": factura,
                "tieneAlbaranEnTexto": tiene_albaran,
                "url": pagina.url,
                "urlEsperada": url_ficha_factura_compra(factura),
                "abrirVia": abierta.get("via"),
                "captura": ruta,
                "titulo": pagina.title(),
                "parado": "paso1",
                "aviso": "Open-only: no se ha pulsado Traer albaranes.",
            }
            print(json.dumps(out, ensure_ascii=False))
            return 0 if out["ok"] else 1
        finally:
            try:
                contexto.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
