@echo off
cd /d "%~dp0"
title Tilt Wheel bridge
echo Installing / checking requirements...
python -m pip install -r requirements.txt --quiet --no-warn-script-location
python bridge.py %*
pause
