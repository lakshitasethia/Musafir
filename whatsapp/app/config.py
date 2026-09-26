from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # The repo's .env.local holds shared keys; a whatsapp/.env (if present) overrides it.
    model_config = SettingsConfigDict(env_file=("../.env.local", ".env"), extra="ignore")

    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_verify_token: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_api_version: str = "v25.0"

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    # tried in order if the primary model is missing for this key or retired
    groq_fallback_models: str = "openai/gpt-oss-20b,qwen/qwen3.8-27b,llama-3.3-70b-versatile"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    musafir_api_url: str = "http://localhost:3000"  # the Next.js app at the repo root
    public_base_url: str = "http://localhost:8100"

    osm_contact: str = ""
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    open_meteo_url: str = "https://api.open-meteo.com/v1/forecast"
    # tried in order; the public instances rate-limit independently
    overpass_urls: str = (
        "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter"
    )
    osrm_url: str = "https://routing.openstreetmap.de"

    database_path: str = "whatsapp.db"

    history_messages: int = 12  # user+assistant messages kept per phone
    max_tool_rounds: int = 5
    rate_limit_per_minute: int = 12
    link_code_ttl_minutes: int = 15
    link_max_attempts: int = 5

    @property
    def whatsapp_enabled(self) -> bool:
        return bool(self.whatsapp_access_token and self.whatsapp_phone_number_id)

    @property
    def groq_models(self) -> list[str]:
        extra = [m.strip() for m in self.groq_fallback_models.split(",") if m.strip()]
        return [self.groq_model.strip(), *extra]

    @property
    def overpass_url_list(self) -> list[str]:
        return [u.strip() for u in self.overpass_urls.split(",") if u.strip()]

    @property
    def user_agent(self) -> str:
        contact = self.osm_contact.strip()
        # OSM blocks placeholder contacts outright, which is worse than sending none
        if not contact or "example." in contact:
            return "musafir-whatsapp/0.1"
        return f"musafir-whatsapp/0.1 ({contact})"
