@echo off
cd /d "%~dp0"
echo ============================================
echo  AGENTE DE VENTAS - ALSO CASALS
echo  Deja esta ventana ABIERTA mientras uses
echo  la aplicacion. Para salir: Ctrl+C
echo ============================================
echo.
echo Abriendo en el navegador: http://localhost:8102
start http://localhost:8102
call npm start
pause
