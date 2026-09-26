from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str
    jwt_expire_minutes: int = 60 * 24

    cors_origins: str = "http://localhost:3000"  # comma-separated

    gemini_api_key: str = ""
    gemini_model_lite: str = "gemini-2.5-flash-lite"
    gemini_model_main: str = "gemini-2.5-flash"
    llm_mock: bool = True

    google_places_api_key: str = ""
    ors_api_key: str = ""
    viator_api_key: str = ""
    liteapi_key: str = ""
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
