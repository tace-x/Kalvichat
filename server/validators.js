import crypto from 'node:crypto';

export const LANGUAGES = ['Hinglish', 'Manglish'];
export const AVATARS = ['panda', 'fox', 'penguin'];
export const COLORS = [
  { id: 'terracotta', value: '#C4613F' },
  { id: 'teal', value: '#2F7A68' },
  { id: 'indigo', value: '#5B68A6' },
  { id: 'amber', value: '#9A6B2F' },
  { id: 'slate', value: '#596C68' },
  { id: 'olive', value: '#74733D' },
  { id: 'aubergine', value: '#725B78' },
  { id: 'cyan', value: '#397987' },
];

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw Object.assign(new Error('Username must be 3–20 characters using letters, numbers, or underscores.'), { status: 400, code: 'invalid-username' });
  return username;
}
export function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) phone = `+${phone}`;
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) throw Object.assign(new Error('Enter a valid phone number including country code.'), { status: 400, code: 'invalid-phone' });
  return phone;
}
export function validateRegistration(input) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw Object.assign(new Error('Name must be 2–60 characters.'), { status: 400 });
  const password = String(input.password || '');
  if (password.length < 8 || password.length > 128) throw Object.assign(new Error('Password must be 8–128 characters.'), { status: 400 });
  if (!LANGUAGES.includes(input.language)) throw Object.assign(new Error('Choose Hinglish or Manglish.'), { status: 400 });
  return { name, username: normalizeUsername(input.username), phone: normalizePhone(input.phone), password, language: input.language };
}
export const phoneReservationId = (phone) => crypto.createHash('sha256').update(phone).digest('hex');
export const safeReason = (value) => String(value || '').trim().slice(0, 300);
export function publicError(error) {
  const known = ['auth/invalid-credential','auth/wrong-password','auth/user-not-found','auth/user-disabled'];
  if (known.includes(error.code)) return { status: 401, message: 'Invalid username or password.' };
  return { status: error.status || 500, message: error.status && error.status < 500 ? error.message : 'Something went wrong. Please try again.' };
}
