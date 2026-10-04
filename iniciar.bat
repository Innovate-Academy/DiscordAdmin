@echo off
rem Arranca el bot y lo vuelve a levantar si se cae. Cierra esta ventana para pararlo.
cd /d "%~dp0"
if not exist data mkdir data

:inicio
echo [%date% %time%] Arrancando el bot. El registro se guarda en data\bot.log
node --disable-warning=ExperimentalWarning src\index.js >> data\bot.log 2>&1
if %errorlevel%==2 goto configuracion
echo [%date% %time%] El bot se ha detenido. Reinicio en 10 segundos...
timeout /t 10 /nobreak > nul
goto inicio

:configuracion
echo.
echo El bot no puede arrancar por un problema de configuracion.
echo Abre data\bot.log y mira las ultimas lineas.
pause
exit /b 2
