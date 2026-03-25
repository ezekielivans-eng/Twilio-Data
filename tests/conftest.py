import os

# Set dummy credentials before any app code imports config
os.environ.setdefault("TWILIO_ACCOUNT_SID", "AC" + "0" * 32)
os.environ.setdefault("TWILIO_AUTH_TOKEN", "test_token_for_unit_tests")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret-key")
os.environ.setdefault("FLASK_DEBUG", "true")
