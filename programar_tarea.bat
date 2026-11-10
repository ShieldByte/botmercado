@echo off
cd /d "%~dp0"
set /p HORAS="Cada cuantas horas quieres que revise? (1, 2, 3...): "
if "%HORAS%"=="" set HORAS=2
set /a MINUTOS=%HORAS%*60
schtasks /Create /F /SC MINUTE /MO %MINUTOS% /TN "BotMercadoLibre" /TR "\"%~dp0.venv\Scripts\pythonw.exe\" \"%~dp0bot.py\""
if errorlevel 1 (
  echo No se pudo crear la tarea.
) else (
  echo Listo: el bot revisara cada %HORAS% hora^(s^) mientras tu PC este encendida y con tu sesion abierta.
  echo Para quitarla ejecuta quitar_tarea.bat
)
pause
