@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: Configure the folder that contains the image files
set "IMG_DIR=C:\Users\leson\OneDrive\Desktop\Work\audi-06"

:menu
cls
echo ========================================================
echo        IMAGE LIST IN FOLDER AUDI-06
echo ========================================================
echo.

:: Check whether the folder exists
if not exist "%IMG_DIR%" (
    echo [ERROR] Folder not found: %IMG_DIR%
    pause
    exit /b
)

:: Count and list the files (supports .img, .bin, .zip)
set count=0
for %%f in ("%IMG_DIR%\*.img" "%IMG_DIR%\*.bin" "%IMG_DIR%\*.zip") do (
    set /a count+=1
    set "file[!count!]=%%~nxf"
    set "fullpath[!count!]=%%f"
    echo  [!count!] %%~nxf
)

if %count%==0 (
    echo [!] No .img, .bin or .zip files found in the folder.
    echo.
    pause
    exit /b
)

echo.
echo ========================================================
echo [Q] Quit
echo ========================================================
echo.

:: Ask the user for a choice
set /p "choice=Enter the number of the partition to flash: "

if /i "%choice%"=="q" exit /b

:: Validate the choice
if not defined file[%choice%] (
    echo.
    echo [ERROR] Invalid choice, please try again!
    timeout /t 2 >nul
    goto menu
)

:: Get the selected file name and full path
set "SELECTED_FILE=!file[%choice%]!"
set "SELECTED_PATH=!fullpath[%choice%]!"

:: Guess the partition name from the file name
for %%a in ("%SELECTED_FILE%") do set "PARTITION=%%~na"

echo.
echo --------------------------------------------------------
echo You selected: %SELECTED_FILE%
echo Target partition: %PARTITION%
echo --------------------------------------------------------
echo.

:: Ask for confirmation before flashing
set /p "confirm=Confirm flash? (Y/N): "
if /i not "%confirm%"=="y" (
    echo Operation canceled.
    timeout /t 2 >nul
    goto menu
)

echo.
echo [INFO] Checking device connection...

:: Check whether any device is connected
fastboot devices 2>nul | findstr /r /c:"[a-zA-Z0-9]" >nul
if %errorlevel% neq 0 (
    echo [ERROR] No device found in Fastboot/Fastbootd mode.
    echo         Please check the cable or driver!
    pause
    goto menu
)

:: Detect the current mode (fastbootd reports is-userspace: yes)
set "IS_FASTBOOTD=false"
fastboot getvar is-userspace 2>&1 | findstr /i "yes" >nul
if %errorlevel%==0 set "IS_FASTBOOTD=true"

:: Decide whether this dynamic partition needs fastbootd
set "NEED_BOOTD="
if /i "%IS_FASTBOOTD%"=="false" (
    if /i "%PARTITION%"=="system"     set "NEED_BOOTD=true"
    if /i "%PARTITION%"=="vendor"     set "NEED_BOOTD=true"
    if /i "%PARTITION%"=="product"    set "NEED_BOOTD=true"
    if /i "%PARTITION%"=="system_ext" set "NEED_BOOTD=true"
    if /i "%PARTITION%"=="odm"        set "NEED_BOOTD=true"
)

if defined NEED_BOOTD goto enter_fastbootd
goto do_flash

:enter_fastbootd
echo [WARNING] You are flashing a dynamic partition ^(%PARTITION%^) in normal Fastboot mode.
echo           The device will be switched to FASTBOOTD automatically...
fastboot reboot fastboot
echo [INFO] Waiting for the device to reboot into Fastbootd (about 5-10 seconds)...

:loop_wait
timeout /t 2 >nul
fastboot getvar is-userspace 2>&1 | findstr /i "yes" >nul
if errorlevel 1 goto loop_wait
echo [OK] Successfully entered Fastbootd mode!
echo.

:do_flash
echo.
echo [INFO] Flashing...
echo Command: fastboot flash %PARTITION% "%SELECTED_PATH%"
echo.

fastboot flash %PARTITION% "%SELECTED_PATH%"

echo.
echo ========================================================
echo Done! Press any key to return to the menu.
echo ========================================================
pause >nul
goto menu
