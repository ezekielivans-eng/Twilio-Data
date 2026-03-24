import os
from dotenv import load_dotenv

load_dotenv()

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")

if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
    raise RuntimeError(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables are required. "
        "Copy .env.example to .env and fill in your credentials."
    )

FLASK_DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() in ("true", "1", "yes")

FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY")
if not FLASK_SECRET_KEY:
    if FLASK_DEBUG:
        FLASK_SECRET_KEY = "dev-secret-for-local-only"
    else:
        raise RuntimeError(
            "FLASK_SECRET_KEY must be set in production. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "300"))
DATE_RANGE_DAYS = int(os.environ.get("DATE_RANGE_DAYS", "30"))
