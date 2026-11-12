"""Settings, read once from the environment (and backend/.env locally)."""
import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()

DOMAINS = {"lark": "https://open.larksuite.com", "feishu": "https://open.feishu.cn"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return -1  # reported by validate()


@dataclass(frozen=True)
class Settings:
    # Render sets PORT and RENDER; locally stay on 127.0.0.1.
    host: str = os.getenv("HOST") or ("0.0.0.0" if os.getenv("RENDER") else "127.0.0.1")
    port: int = _int("PORT", 3007)
    environment: str = "render" if os.getenv("RENDER") else "local"

    lark_app_id: str = os.getenv("LARK_APP_ID", "")
    lark_app_secret: str = os.getenv("LARK_APP_SECRET", "")
    lark_domain_name: str = os.getenv("LARK_DOMAIN", "lark").lower()
    agent_api_key: str = os.getenv("AGENT_API_KEY", "")
    cors_origins: list[str] = field(
        default_factory=lambda: [o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
    )

    redis_url: str = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    # Only used once, to import customers.json from the old Node version into Redis.
    data_dir: str = os.getenv("DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))

    model_api_key: str = os.getenv("MODEL_API_KEY", "")
    model_api_url: str = os.getenv("MODEL_API_URL", "https://api.groq.com/openai/v1/chat/completions")
    model_name: str = os.getenv("MODEL_NAME", "openai/gpt-oss-120b")
    product_name: str = os.getenv("PRODUCT_NAME", "leather products")
    standard_price: int = _int("STANDARD_UNIT_PRICE", 250)
    bulk_minimum: int = _int("BULK_MINIMUM_QUANTITY", 500)
    minimum_price: int = _int("MINIMUM_UNIT_PRICE", 225)

    @property
    def lark_domain(self) -> str:
        return DOMAINS.get(self.lark_domain_name, "")

    def validate(self) -> list[str]:
        """Problems that stop the app from starting."""
        problems = []
        missing = [
            name
            for name, value in [
                ("LARK_APP_ID", self.lark_app_id),
                ("LARK_APP_SECRET", self.lark_app_secret),
                ("AGENT_API_KEY", self.agent_api_key),
                ("MODEL_API_KEY", self.model_api_key),
            ]
            if not value or value.startswith("your_")
        ]
        if missing:
            problems.append(f"Fill in these values in .env: {', '.join(missing)}")
        if not self.lark_domain:
            problems.append('LARK_DOMAIN must be "lark" (international) or "feishu" (China).')
        if len(self.agent_api_key) < 24:
            problems.append("AGENT_API_KEY must be at least 24 characters long.")
        prices = [self.standard_price, self.minimum_price, self.bulk_minimum]
        if any(p <= 0 for p in prices) or self.minimum_price > self.standard_price:
            problems.append(
                "Prices and BULK_MINIMUM_QUANTITY must be positive integers; "
                "MINIMUM_UNIT_PRICE cannot exceed STANDARD_UNIT_PRICE."
            )
        return problems


settings = Settings()
