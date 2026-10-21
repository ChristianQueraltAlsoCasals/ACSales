"""
FASE A — Traer líneas de pedido a un borrador de factura de compra.

Abre el borrador en BC → «Traer líneas pedido» → selecciona solo las
líneas emparejadas (pedido + código) → captura y SE PARA antes de
Aceptar. Tú revisas Edge y pulsas Enter en esta terminal para confirmar.

Uso (con el servicio de registro YA parado, o en otra prueba aislada):

    python traer_lineas_factura.py FC26-000123 PC26-001633:PR000001492 PC26-001988:PR000001176

Cada argumento tras el nº de factura es «PEDIDO:CODIGO» (código de
artículo/cargo en BC). Sin código: solo «PEDIDO» (selecciona todas las
filas de ese pedido — no recomendado en fase A).

Requiere login_setup.py hecho al menos una vez.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from servicio_registro import (
    CARPETA,
    CARPETA_PERFIL,
    aceptar_traer_lineas,
    preparar_traer_lineas,
)


def parsear_lineas(args: list[str]) -> list[dict]:
    lineas = []
    for a in args:
        a = (a or "").strip()
        if not a:
            continue
        if ":" in a:
            pedido, codigo = a.split(":", 1)
            lineas.append({"pedido": pedido.strip(), "codigo": codigo.strip() or None})
        else:
            lineas.append({"pedido": a, "codigo": None})
    return lineas


def main():
    print("[versión script: traer-lineas-factura-faseA-v1]")
    if len(sys.argv) < 3:
        print("Uso: python traer_lineas_factura.py FC26-000123 PC26-001633:PR000001492 ...")
        sys.exit(1)

    numero_factura = sys.argv[1].strip()
    lineas = parsear_lineas(sys.argv[2:])
    if not lineas:
        print("Falta al menos un PEDIDO:CODIGO.")
        sys.exit(1)

    if not CARPETA_PERFIL.exists():
        print(f"No encuentro {CARPETA_PERFIL} — ejecuta primero: python login_setup.py")
        sys.exit(1)

    with sync_playwright() as p:
        contexto = p.chromium.launch_persistent_context(
            str(CARPETA_PERFIL),
            channel="msedge",
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )
        pagina = contexto.pages[0] if contexto.pages else contexto.new_page()

        resultado = preparar_traer_lineas(pagina, numero_factura, lineas)
        print(json.dumps(resultado, ensure_ascii=False, indent=2))

        if not resultado.get("ok"):
            input("Pulsa Enter para cerrar el navegador... ")
            contexto.close()
            return

        print()
        print("=" * 70)
        print("FASE A — Revisa en Edge el diálogo «Traer líneas pedido».")
        print(f"  Factura: {numero_factura}")
        print(f"  Seleccionadas: {resultado.get('seleccionadas', 0)}")
        print(f"  No encontradas: {resultado.get('no_encontradas') or []}")
        if resultado.get("captura"):
            print(f"  Captura: {resultado['captura']}")
        print("Si la selección es correcta, pulsa Enter aquí para ACEPTAR.")
        print("Si no, cierra esta ventana (Ctrl+C) y no se aceptará.")
        print("=" * 70)
        try:
            input("Pulsa Enter para Aceptar… ")
        except KeyboardInterrupt:
            print("\nCancelado — no se ha pulsado Aceptar.")
            contexto.close()
            return

        fin = aceptar_traer_lineas(pagina, numero_factura)
        print(json.dumps(fin, ensure_ascii=False, indent=2))
        input("Pulsa Enter para cerrar el navegador... ")
        contexto.close()


if __name__ == "__main__":
    main()
