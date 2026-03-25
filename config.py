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

# Twilio API settings
TWILIO_TIMEOUT = int(os.environ.get("TWILIO_TIMEOUT", "20"))
TWILIO_RETRIES = int(os.environ.get("TWILIO_RETRIES", "1"))

# Worker pool
EXECUTOR_MAX_WORKERS = int(os.environ.get("EXECUTOR_MAX_WORKERS", "6"))

# Cache
CACHE_MAX_SIZE = int(os.environ.get("CACHE_MAX_SIZE", "200"))

# Rate limiting
RATE_LIMIT = os.environ.get("RATE_LIMIT", "60 per minute")

# Logging
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
