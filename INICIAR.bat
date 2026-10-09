@echo off
cd /d "%~dp0"
echo ============================================
echo  AGENTE DE VENTAS - ALSO CASALS
echo  Deja esta ventana ABIERTA mientras uses
echo  la aplicacion. Para salir: Ctrl+C
echo ============================================
echo.
echo Arrancando el registro de pedidos de compra.
echo Deja tambien ABIERTA la ventana "Registro pedidos BC".
start "Registro pedidos BC" cmd /k "cd /d "%~dp0bc_automation" && python servicio_registro.py"
echo.
echo Abriendo en el navegador: http://localhost:8102
start http://localhost:8102
call npm start
pause
