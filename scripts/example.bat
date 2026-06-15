@echo off
REM Script mẫu để thử tính năng Scripts (stream log + stdin).
echo === ADB Web Control - example.bat ===
echo Current time: %TIME%
echo.
echo Connected devices:
adb devices
echo.
set /p NAME="Enter your name: "
echo Hello, %NAME%!
echo.
echo Done. Bye.
