#!/usr/bin/env bash
python3 -m pip install -r requirements.txt
python3 -m pip install -r requirements-live.txt || echo "Live job search not installed; using saved jobs."
python3 -m uvicorn server:app --port 8000
