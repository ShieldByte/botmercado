@echo off
cd /d "%~dp0"
echo === Instalando el bot de Mercado Libre ===
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% --version >nul 2>nul || (
  echo No encontre Python. Instalalo desde https://www.python.org/downloads/
  echo y marca la casilla "Add python.exe to PATH". Luego vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
if not exist .venv %PY% -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt || (echo Fallo la instalacion de paquetes. & pause & exit /b 1)
rem El bot usa Microsoft Edge (ya viene en Windows). Si prefieres Chromium, quita el "rem" de la siguiente linea
rem python -m playwright install chromium
if not exist .env copy .env.example .env >nul
echo.
echo Listo. Siguiente paso: abre el archivo .env con el Bloc de notas,
echo pega tu TELEGRAM_TOKEN y luego ejecuta vincular_telegram.bat
pause
