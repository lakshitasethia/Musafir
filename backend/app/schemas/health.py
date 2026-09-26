from typing import Literal

from pydantic import BaseModel

Status = Literal["ok", "error"]


class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    db: Status
    redis: Status
