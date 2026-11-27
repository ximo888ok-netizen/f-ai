import { invalid } from './http.js';

export function canonicalPhone(value) {
  const phone = typeof value === 'string' ? value.trim() : '';
  if (/^1[3-9][0-9]{9}$/.test(phone)) return '+86' + phone;
  if (/^\+[1-9][0-9]{7,14}$/.test(phone)) return phone;
  throw invalid('Use a mainland China mobile number or an international number starting with +');
}

export function canonicalEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const address = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (email.length > 254 || !address.test(email)) throw invalid('Enter a valid email address');
  return email;
}

export function canonicalUsername(value) {
  const username = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  if (!/^[\p{L}\p{N}._-]{3,32}$/u.test(username) || !/\p{L}/u.test(username)) {
    throw invalid('Use a 3–32 character username with letters, numbers, periods, underscores or hyphens and at least one letter');
  }
  return username;
}
