export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_BCRYPT_PASSWORD_BYTES = 72;

export function passwordMeetsPolicy(password) {
  const value = String(password || '');
  const characterCount = Array.from(value).length;
  return characterCount >= MIN_PASSWORD_LENGTH
    && characterCount <= MAX_PASSWORD_LENGTH
    && Buffer.byteLength(value, 'utf8') <= MAX_BCRYPT_PASSWORD_BYTES;
}
