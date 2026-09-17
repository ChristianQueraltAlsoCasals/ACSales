"""
DIAGNÓSTICO — no toca BC para nada. Solo abre google.com con un navegador
controlado por Playwright y espera. Sirve para saber si el cierre
automático pasa con CUALQUIER navegador automatizado, o solo con BC.

Uso:
    python diagnostico_navegador.py
"""

from playwright.sync_api import sync_playwright

print("Abriendo un navegador de prueba (Google, nada de BC)...")
with sync_playwright() as p:
    navegador = p.chromium.launch(headless=False)
    pagina = navegador.new_page()
    pagina.goto("https://www.google.com")
    print("Si ves esto en la terminal, el navegador debería seguir abierto.")
    input("Pulsa Enter para cerrarlo tú mismo... ")
    navegador.close()
    print("Cerrado a mano, sin problemas.")
