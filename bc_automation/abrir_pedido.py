"""
PASO 2 — prueba de navegación SOLAMENTE. Todavía no toca "Registrar" ni
cambia nada en BC — solo comprueba que el script es capaz de abrir el
pedido correcto, y deja una captura de pantalla para revisar.

A diferencia de versiones anteriores, esta NO usa el buscador de BC (esa
parte resultó poco fiable por los tiempos de carga) — construye la URL
directa a la ficha del pedido, con el mismo "bookmark" que genera BC
cuando usas su propio "Copiar enlace". Es instantáneo y no depende de
que cargue ningún cuadro de búsqueda.

Requiere haber ejecutado login_setup.py antes al menos una vez (crea la
carpeta perfil_navegador, que se reutiliza aquí).

Uso:
    python abrir_pedido.py PC26-003240
"""

import base64
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")

TENANT_ID = os.environ.get("BC_TENANT_ID", "")
ENVIRONMENT = os.environ.get("BC_ENVIRONMENT", "")
COMPANY_NAME = os.environ.get("BC_COMPANY_NAME", "")
CARPETA_PERFIL = CARPETA / "perfil_navegador"

# Página "Purchase Order" (ficha de pedido de compra) — confirmada con un
# enlace real copiado desde BC (page=50).
PAGINA_PEDIDO_COMPRA = 50

# Cabecera fija del "bookmark" de esta página — se obtuvo descomponiendo
# un enlace real que Maria copió desde BC un 02/09/2026. Debería ser la
# misma para cualquier pedido de compra en esta página/tabla; si algún
# día deja de funcionar, hay que repetir el proceso: abrir un pedido a
# mano en BC, copiar su enlace, y volver a sacar la cabecera.
CABECERA_BOOKMARK_HEX = "26000000008b01000000027bff"


def url_pedido_directo(numero_pedido: str) -> str:
    header = bytes.fromhex(CABECERA_BOOKMARK_HEX)
    texto_utf16 = numero_pedido.encode("utf-16-le")
    data = (header + texto_utf16)[:-1]  # BC omite el último byte si es 0x00
    b64 = base64.urlsafe_b64encode(data).decode().rstrip("=")
    bookmark = f"27_{b64}"
    empresa = COMPANY_NAME.replace(" ", "%20")
    return (
        f"https://businesscentral.dynamics.com/{TENANT_ID}/{ENVIRONMENT}/"
        f"?company={empresa}&page={PAGINA_PEDIDO_COMPRA}&bookmark={bookmark}"
    )


def cerrar_dialogo_pausa(pagina):
    for _ in range(3):
        try:
            boton = pagina.get_by_role("button", name="Refresh")
            if boton.is_visible(timeout=4000):
                print("Apareció el diálogo de pausa de BC — pulsando Refresh...")
                boton.click()
                pagina.wait_for_timeout(4000)
            else:
                break
        except Exception:
            break


def main():
    print("[versión script: url-directa-v8]")
    if len(sys.argv) < 2:
        print("Uso: python abrir_pedido.py PC26-003240")
        sys.exit(1)
    numero_pedido = sys.argv[1]

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

        url = url_pedido_directo(numero_pedido)
        print(f"Abriendo directamente: {url}")
        try:
            pagina.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"⚠️ Error navegando (puede ser normal si BC tarda): {e}")

        pagina.wait_for_timeout(4000)
        cerrar_dialogo_pausa(pagina)
        pagina.wait_for_timeout(2000)

        captura = CARPETA / f"captura_busqueda_{numero_pedido}.png"
        pagina.screenshot(path=str(captura))
        print(f"📸 Captura guardada: {captura}")
        print()
        print(f"Revisa esa imagen: si se ve la ficha del pedido {numero_pedido} abierta")
        print("(con sus líneas de material), perfecto. Si sale otra cosa, mándame la captura.")
        print()
        input("Pulsa Enter para cerrar el navegador... ")
        contexto.close()


if __name__ == "__main__":
    main()
