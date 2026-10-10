@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%" || (
  echo Nao foi possivel acessar a pasta do Sideral Editor.
  exit /b 1
)

:menu
cls
echo.
echo  ========================================
echo              SIDERAL EDITOR
echo  ========================================
echo.
echo   [1] Iniciar em modo dev ^(Fast^)
echo   [2] Compilar a release
echo   [3] Limpar build
echo   [4] Sair
echo.
choice /c 1234 /n /m "Selecione uma opcao [1-4]: "

if errorlevel 4 goto exit
if errorlevel 3 goto clean
if errorlevel 2 goto release
if errorlevel 1 goto dev
goto menu

:dev
set "ACTION_EXIT=0"
call :require_tool npm
if errorlevel 1 goto action_failed
call :require_tool cargo
if errorlevel 1 goto action_failed
call :prepare_dev_port
if errorlevel 1 goto action_failed

echo.
echo Iniciando o Sideral Editor em modo dev...
echo Use Ctrl+C para encerrar o servidor e voltar ao menu.
echo.
call npm run tauri dev
set "ACTION_EXIT=%errorlevel%"
call :prepare_dev_port
if errorlevel 1 set "ACTION_EXIT=1"
goto action_finished

:release
set "ACTION_EXIT=0"
call :require_tool npm
if errorlevel 1 goto action_failed
call :require_tool cargo
if errorlevel 1 goto action_failed

echo.
echo Compilando a release do Sideral Editor...
echo.
call npm run release:local
set "ACTION_EXIT=%errorlevel%"
goto action_finished

:clean
set "ACTION_EXIT=0"
call :require_tool npm
if errorlevel 1 goto action_failed

echo.
echo Limpando os artefatos de build...
call npm run clean
set "ACTION_EXIT=%errorlevel%"
goto action_finished

:require_tool
where %~1 >nul 2>&1
if errorlevel 1 (
  echo.
  echo Ferramenta obrigatoria nao encontrada: %~1
  exit /b 1
)
exit /b 0

:prepare_dev_port
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%scripts\prepare-dev-port.ps1" -Port 1420
exit /b %errorlevel%

:action_failed
set "ACTION_EXIT=1"

:action_finished
echo.
if "%ACTION_EXIT%"=="0" (
  echo Operacao concluida com sucesso.
) else (
  echo A operacao terminou com erro ^(codigo %ACTION_EXIT%^).
)
echo Pressione qualquer tecla para voltar ao menu...
pause >nul
goto menu

:exit
endlocal
exit /b 0
