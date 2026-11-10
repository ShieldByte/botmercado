@echo off
cd /d "%~dp0"
echo Revisando una vez (los avisos se imprimen aqui, NO se mandan a Telegram)...
.venv\Scripts\python.exe bot.py --simular
pause
