/**
 * Minimal first-party auth: scrypt password hashes, HMAC-signed session cookie.
 *
 * Operator accounts: signing up as an operator requires OPERATOR_INVITE_CODE.
 * If that env var is unset and NODE_ENV !== "production", operator sign-up is
 * open (demo mode) and the sign-up page says so. In production without a code,
 * operator sign-up is disabled.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import type { Role } from "@/lib/musafir/risk.ts";
import { DATA_DIR, read, write, type UserRecord } from "./store.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "mz_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const KEY_LEN = 64;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  guest: boolean;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const g = globalThis as typeof globalThis & { __musafirSecret?: Promise<string> };

function secret(): Promise<string> {
  if (process.env.AUTH_SECRET) return Promise.resolve(process.env.AUTH_SECRET);
  if (process.env.NODE_ENV === "production") {
    return Promise.reject(new Error("AUTH_SECRET must be set in production"));
  }
  g.__musafirSecret ??= (async () => {
    const file = path.join(DATA_DIR, "dev-secret");
    try {
      return (await fs.readFile(file, "utf8")).trim();
    } catch {
      const s = randomBytes(32).toString("hex");
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(file, s, "utf8");
      return s;
    }
  })();
  return g.__musafirSecret;
}

export function operatorSignupMode(): "invite" | "open-dev" | "disabled" {
  if (process.env.OPERATOR_INVITE_CODE) return "invite";
  return process.env.NODE_ENV === "production" ? "disabled" : "open-dev";
}

async function hashPassword(password: string, salt: string) {
  return (await scrypt(password, salt, KEY_LEN)).toString("hex");
}

function safeEqualText(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function safeEqualHex(a: string, b: string) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const SignupSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  role: z.enum(["traveller", "operator"]),
  inviteCode: z.string().optional(),
});

export const LoginSchema = z.object({
  email: z.string().transform((e) => e.trim().toLowerCase()),
  password: z.string(),
});

const toSession = (u: UserRecord): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, guest: !!u.guest });

/** Guests per IP per hour — enough for real use, stops scripted account spam. */
const GUEST_LIMIT_PER_HOUR = 20;
const gg = globalThis as typeof globalThis & { __musafirGuests?: Map<string, { at: number; n: number }> };
const guestRate = (gg.__musafirGuests ??= new Map());

/**
 * A traveller account with no email/password, so every traveller feature works
 * without logging in. Its trips stay attached when it later signs up (upgrade in place).
 */
export async function createGuest(ip: string): Promise<SessionUser> {
  await secret();
  const now = Date.now();
  const cur = guestRate.get(ip);
  if (!cur || now - cur.at > 3_600_000) guestRate.set(ip, { at: now, n: 1 });
  else if (++cur.n > GUEST_LIMIT_PER_HOUR) throw new HttpError(429, "Too many new sessions from this network — try again later");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = randomBytes(KEY_LEN).toString("hex"); // unguessable: guests can't log in with a password
  return write((db) => {
    const user: UserRecord = { id: newId(), email: "", name: "Guest", role: "traveller", passwordHash, salt, createdAt: new Date().toISOString(), guest: true };
    db.users.push(user);
    return toSession(user);
  });
}

/** Sign-up; when called by a guest traveller it upgrades that account so their trips carry over. */
export async function signup(input: z.infer<typeof SignupSchema>, current?: SessionUser | null): Promise<SessionUser> {
  await secret(); // fail on missing config before creating an account
  if (input.role === "operator") {
    const mode = operatorSignupMode();
    if (mode === "disabled") throw new HttpError(403, "Operator sign-up is disabled on this deployment");
    if (mode === "invite" && !safeEqualText(input.inviteCode ?? "", process.env.OPERATOR_INVITE_CODE!)) {
      throw new HttpError(403, "Invalid operator invite code");
    }
  }
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(input.password, salt);
  return write((db) => {
    if (db.users.some((u) => u.email === input.email)) throw new HttpError(409, "An account with this email already exists");
    const guest = current?.guest && input.role === "traveller" ? db.users.find((u) => u.id === current.id && u.guest) : undefined;
    if (guest) {
      Object.assign(guest, { email: input.email, name: input.name, passwordHash, salt, guest: false });
      return toSession(guest);
    }
    const user: UserRecord = {
      id: newId(),
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    return toSession(user);
  });
}

export async function login(input: z.infer<typeof LoginSchema>): Promise<SessionUser> {
  const user = await read((db) => (input.email ? db.users.find((u) => u.email === input.email && !u.guest) : undefined));
  // Hash even for unknown emails so timing doesn't reveal which accounts exist.
  const hash = await hashPassword(input.password, user?.salt ?? "0".repeat(32));
  if (!user || !safeEqualHex(hash, user.passwordHash)) throw new HttpError(401, "Wrong email or password");
  return toSession(user);
}

async function sign(payload: string) {
  return createHmac("sha256", await secret()).update(payload).digest("base64url");
}

export async function setSessionCookie(user: SessionUser) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString(
    "base64url",
  );
  const token = `${payload}.${await sign(payload)}`;
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: { uid?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.uid !== "string" || typeof parsed.exp !== "number" || parsed.exp * 1000 < Date.now()) return null;
  const user = await read((db) => db.users.find((u) => u.id === parsed.uid));
  return user ? toSession(user) : null;
}

export async function requireUser(role?: Role): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Please log in");
  if (role && user.role !== role) throw new HttpError(403, `This action is for ${role}s`);
  return user;
}
