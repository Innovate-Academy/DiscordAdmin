@echo off
rem Crea bot.zip con el codigo del bot, listo para subir a un panel de hosting.
rem No incluye el .env (el token) ni la carpeta data (la base de datos): esos se suben aparte.
cd /d "%~dp0"
powershell -NoProfile -Command "Compress-Archive -Force -Path src,index.js,package.json,package-lock.json -DestinationPath bot.zip"
if errorlevel 1 (
  echo No se pudo crear el archivo.
  pause
  exit /b 1
)
echo Listo: bot.zip
pause
