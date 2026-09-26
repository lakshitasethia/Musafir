"""Server-rendered page where a user signs in so their WhatsApp number is linked to Musafir.

Passwords are typed here (HTTPS), never into WhatsApp. Only the backend access token is stored.
"""

from html import escape

STYLE = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  background: #0a0a0a; color: #f5f5f0; font: 16px/1.5 "Helvetica Neue", Helvetica, sans-serif; }
main { width: 100%; max-width: 400px; }
h1 { font: 400 32px/1.15 Georgia, "Times New Roman", serif; margin: 0 0 8px; letter-spacing: -0.01em; }
p { color: rgba(245,245,240,.62); margin: 0 0 24px; }
.card { border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.03);
  border-radius: 14px; padding: 20px; margin-bottom: 16px; }
h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; font-weight: 500;
  color: rgba(245,245,240,.55); margin: 0 0 14px; }
label { display: block; font-size: 14px; color: rgba(245,245,240,.7); margin: 12px 0 6px; }
input { width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14);
  background: #141417; color: #f5f5f0; font: inherit; }
input:focus { outline: 2px solid #5e8b72; outline-offset: 1px; }
button { margin-top: 18px; width: 100%; padding: 12px; border: 0; border-radius: 999px;
  background: #f5f5f0; color: #0a0a0a; font: 500 15px/1 inherit; cursor: pointer; }
.error { border: 1px solid rgba(184,83,79,.5); background: rgba(184,83,79,.12); color: #f0c9c6;
  border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; }
.ok { color: #9cc7ae; }
"""


def _page(title: str, body: str) -> str:
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<meta name='robots' content='noindex'>"
        f"<title>{escape(title)}</title><style>{STYLE}</style></head>"
        f"<body><main>{body}</main></body></html>"
    )


def link_form(code: str, error: str | None = None, email: str = "", full_name: str = "") -> str:
    action = f"/link/{escape(code)}"
    err = f"<div class='error' role='alert'>{escape(error)}</div>" if error else ""
    return _page(
        "Link Musafir",
        f"""
<h1>Connect WhatsApp to Musafir</h1>
<p>Sign in once and your Musafir companion on WhatsApp will know who you are.</p>
{err}
<form class='card' method='post' action='{action}'>
  <h2>I have an account</h2>
  <input type='hidden' name='mode' value='login'>
  <label for='le'>Email</label>
  <input id='le' name='email' type='email' required autocomplete='email' value='{escape(email)}'>
  <label for='lp'>Password</label>
  <input id='lp' name='password' type='password' required autocomplete='current-password'>
  <button type='submit'>Sign in and link</button>
</form>
<form class='card' method='post' action='{action}'>
  <h2>New to Musafir</h2>
  <input type='hidden' name='mode' value='register'>
  <label for='rn'>Full name</label>
  <input id='rn' name='full_name' required maxlength='200' autocomplete='name'
    value='{escape(full_name)}'>
  <label for='re'>Email</label>
  <input id='re' name='email' type='email' required autocomplete='email'>
  <label for='rp'>Password (8+ characters)</label>
  <input id='rp' name='password' type='password' required minlength='8' maxlength='72'
    autocomplete='new-password'>
  <button type='submit'>Create account and link</button>
</form>
""",
    )


def message_page(title: str, text: str, ok: bool = False) -> str:
    cls = " class='ok'" if ok else ""
    return _page(title, f"<h1>{escape(title)}</h1><p{cls}>{escape(text)}</p>")
