@echo off
cd /d "%~dp0"
echo El bot se queda revisando. Cierra esta ventana para detenerlo.
.venv\Scripts\python.exe bot.py --continuo
pause
