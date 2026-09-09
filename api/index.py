"""
Vercel entrypoint. Vercel's legacy Python runtime looks for Serverless
Functions under api/, so this re-exports the real FastAPI app (which lives
in backend/app.py, next to analysis.py) rather than duplicating any logic.
"""
import os
import sys

BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "backend")
sys.path.insert(0, BACKEND_DIR)

from app import app  # noqa: E402
