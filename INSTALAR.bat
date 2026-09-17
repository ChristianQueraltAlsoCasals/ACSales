@echo off
cd /d "%~dp0"
echo ============================================
echo  AGENTE DE VENTAS - Instalacion
echo  (solo hace falta la primera vez o tras
echo   recibir una actualizacion)
echo ============================================
echo.
echo Instalando dependencias (raiz + client + server)...
echo.
call npm run install:all
echo.
echo ============================================
echo  Instalacion terminada.
echo  Ahora haz doble clic en INICIAR.bat
echo ============================================
pause
