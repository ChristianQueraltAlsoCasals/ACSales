"""
PASO 1 — configuración inicial, se ejecuta UNA SOLA VEZ (o cuando la sesión
caduque, cada varios días).

Usa un perfil PROPIO Y APARTE de este script (no tu Edge de verdad — eso
daba problemas por quedarse corriendo en segundo plano y bloquear el
perfil). Se guarda en la carpeta perfil_navegador, al lado de este
script, y va acumulando caché entre usos igual que un navegador normal.

Espera a que tú inicies sesión a mano (usuario, contraseña, lo que te
pida). Cuando llegues a la pantalla normal de BC (con el menú de la
izquierda visible), vuelve a esta ventana de la terminal y pulsa Enter.

IMPORTANTE sobre la carpeta perfil_navegador:
- Contiene tu sesión iniciada — no la subas a ningún sitio (Git, nube
  compartida...). Está pensada para quedarse solo en este ordenador.
- Tu contraseña NUNCA se guarda en ningún sitio.

Uso:
    python login_setup.py
"""

import os
from pathlib import Path
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")

TENANT_ID = os.environ.get("BC_TENANT_ID", "")
ENVIRONMENT = os.environ.get("BC_ENVIRONMENT", "")
COMPANY_NAME = os.environ.get("BC_COMPANY_NAME", "")
CARPETA_PERFIL = CARPETA / "perfil_navegador"


def url_inicio_bc() -> str:
    if not TENANT_ID or not ENVIRONMENT:
        raise SystemExit(
            "Faltan BC_TENANT_ID / BC_ENVIRONMENT en .env — revisa que este script "
            "encuentra el mismo .env que usa el backend de Node."
        )
    url = f"https://businesscentral.dynamics.com/{TENANT_ID}/{ENVIRONMENT}"
    if COMPANY_NAME:
        url += f"?company={COMPANY_NAME}"
    return url


def cerrar_dialogo_pausa(pagina):
    """BC a veces muestra 'We paused while you were away' al cargar la
    primera vez en un perfil nuevo — si aparece el botón Refresh, lo
    pulsamos solos, y esperamos a que cargue de verdad."""
    for _ in range(3):  # a veces hace falta más de un refresco
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
    print("Abriendo el navegador (primera vez: puede tardar más de lo normal)...")
    with sync_playwright() as p:
        contexto = p.chromium.launch_persistent_context(
            str(CARPETA_PERFIL),
            channel="msedge",
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )
        pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
        url = url_inicio_bc()
        print(f"URL a abrir: {url}")
        try:
            pagina.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"⚠️ Error navegando (puede ser normal si BC tarda): {e}")

        pagina.wait_for_timeout(3000)
        cerrar_dialogo_pausa(pagina)

        print()
        print("=" * 70)
        print("Inicia sesión en la ventana del navegador que se acaba de abrir,")
        print("igual que haces siempre (usuario, contraseña...). Si tarda en")
        print("cargar del todo la primera vez, es normal — espera sin cerrarla.")
        print("Cuando veas la pantalla normal de Business Central (con el menú")
        print("de la izquierda), vuelve AQUÍ y pulsa Enter.")
        print("=" * 70)
        input("Pulsa Enter cuando hayas iniciado sesión y veas BC con normalidad... ")

        print(f"\n✅ Perfil guardado en: {CARPETA_PERFIL}")
        print("Ya puedes cerrar el navegador y probar abrir_pedido.py")
        contexto.close()


if __name__ == "__main__":
    main()
