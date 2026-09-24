import crypto from "node:crypto";

// ---------- Senhas ----------
// scrypt (nativo do Node, sem dependência extra) com salt aleatório por usuário.
// Formato armazenado: "<salt-hex>:<hash-hex>".

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password), salt, 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ---------- Token (JWT compacto, HMAC-SHA256) ----------
// Implementação mínima própria (evita adicionar dependência): mesmo formato
// header.payload.signature, mas só suporta HS256 — o suficiente aqui.

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET não configurada. Defina a variável de ambiente AUTH_SECRET no painel do Netlify (Site settings > Environment variables)."
    );
  }
  return secret;
}

export function signToken(payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const secret = getSecret();
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let secret;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// ---------- Helpers de autenticação para as functions ----------

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function getAuthUser(req) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = verifyToken(m[1]);
  if (!payload || !payload.sub) return null;
  return payload; // { sub, username, role, vendedor, nome, iat, exp }
}

export function requireAuth(req) {
  const user = getAuthUser(req);
  if (!user) throw new AuthError("Não autenticado. Faça login novamente.", 401);
  return user;
}

export function requireAdmin(req) {
  const user = requireAuth(req);
  if (user.role !== "admin") throw new AuthError("Acesso restrito ao administrador.", 403);
  return user;
}

// Usado pelas rotas de dados de leads/atividades: retorna o usuário autenticado
// e, se ele não for admin, garante que qualquer filtro/gravação fique restrito
// ao próprio nome de vendedor (nunca confia em um "vendedor" vindo do cliente).
export function scopedVendedor(user) {
  return user.role === "admin" ? null : user.vendedor || "__nenhum__";
}
