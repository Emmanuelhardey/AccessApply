@echo off
python -m pip install -r requirements.txt
python -m pip install -r requirements-live.txt
start "" http://localhost:8000
python -m uvicorn server:app --port 8000
pause
