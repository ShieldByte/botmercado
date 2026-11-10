@echo off
cd /d "%~dp0"
echo Se abrira el navegador del bot para que inicies sesion en Mercado Libre.
echo Solo es necesario si quieres vigilar busquedas o categorias.
.venv\Scripts\python.exe bot.py --login
pause
