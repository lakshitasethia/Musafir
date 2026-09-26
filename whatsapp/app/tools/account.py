"""Linking a WhatsApp number to a Musafir account, via the backend's auth API."""

import secrets

from pydantic import BaseModel

from app.backend_client import BackendError, BackendUnavailable
from app.tools.registry import Tool, ToolContext, ToolError, ToolResult, register


class NoArgs(BaseModel):
    pass


async def link_musafir_account(ctx: ToolContext, _: NoArgs) -> ToolResult:
    code = secrets.token_urlsafe(24)
    ttl = ctx.settings.link_code_ttl_minutes
    await ctx.store.create_link_code(code, ctx.phone, ttl * 60)
    url = f"{ctx.settings.public_base_url.rstrip('/')}/link/{code}"
    await ctx.sender.send_text(
        ctx.phone,
        f"Open this private link to sign in or create your Musafir account:\n{url}\n\n"
        f"It works once and expires in {ttl} minutes. Never share it.",
    )
    return ToolResult({"sent_link": True}, ends_turn=True)


async def get_my_account(ctx: ToolContext, _: NoArgs) -> dict:
    link = await ctx.store.get_link(ctx.phone)
    if link is None:
        raise ToolError("this WhatsApp number is not linked; offer link_musafir_account")
    try:
        me = await ctx.backend.me(link.access_token)
    except BackendError as e:
        if e.status == 401:
            await ctx.store.delete_link(ctx.phone)
            raise ToolError("the saved sign-in expired; offer link_musafir_account again") from e
        raise ToolError(f"Musafir API error: {e.message}") from e
    except BackendUnavailable as e:
        raise ToolError("Musafir servers are unreachable right now") from e
    return {k: me.get(k) for k in ("full_name", "email", "phone", "role", "created_at")}


async def unlink_musafir_account(ctx: ToolContext, _: NoArgs) -> dict:
    existed = await ctx.store.delete_link(ctx.phone)
    return {"unlinked": existed}


register(
    Tool(
        name="link_musafir_account",
        description="Send the user a one-time private link to sign in to (or create) their "
        "Musafir account and connect it to this WhatsApp number.",
        args=NoArgs,
        run=link_musafir_account,
    )
)
register(
    Tool(
        name="get_my_account",
        description="The Musafir account linked to this WhatsApp number (name, email, role).",
        args=NoArgs,
        run=get_my_account,
    )
)
register(
    Tool(
        name="unlink_musafir_account",
        description="Disconnect this WhatsApp number from its Musafir account.",
        args=NoArgs,
        run=unlink_musafir_account,
        confirm="Disconnect this WhatsApp number from your Musafir account?",
        confirmed_message="Done: this number is no longer linked to Musafir.",
    )
)
