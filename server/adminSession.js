import crypto from 'node:crypto';

const COOKIE = 'mj_admin';
const b64 = (value) => Buffer.from(value).toString('base64url');
const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
function secret() {
  const value = process.env.ADMIN_SESSION_SECRET || '';
  if (value.length < 32) throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters.');
  return value;
}
export function safeEqual(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function createAdminSession() {
  const payload = b64(JSON.stringify({ role: 'admin', adminId: 'primary-admin', exp: Date.now() + 8 * 60 * 60 * 1000, nonce: crypto.randomBytes(12).toString('hex') }));
  return `${payload}.${sign(payload, secret())}`;
}
export function adminCookie(value) {
  const secure = process.env.VERCEL_ENV ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${8 * 60 * 60}`;
}
export function clearAdminCookie() {
  const secure = process.env.VERCEL_ENV ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}
function cookieValue(request) {
  const cookie = request.headers.cookie || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
export function requireAdmin(request) {
  const token = cookieValue(request);
  if (!token) throw Object.assign(new Error('Admin authentication required.'), { status: 401 });
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret()))) throw Object.assign(new Error('Invalid admin session.'), { status: 401 });
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw Object.assign(new Error('Invalid admin session.'), { status: 401 }); }
  if (value.role !== 'admin' || value.exp <= Date.now()) throw Object.assign(new Error('Admin session expired.'), { status: 401 });
  return value;
}
export function requireSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  if (origin && host && new URL(origin).host !== host) throw Object.assign(new Error('Invalid request origin.'), { status: 403 });
}
