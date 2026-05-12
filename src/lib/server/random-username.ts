import { faker } from '@faker-js/faker/locale/en';

const RANDSTR_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateRandomUserLocalPart() {
  const firstName = sanitizeUsernamePart(faker.person.firstName());
  const lastName = sanitizeUsernamePart(faker.person.lastName());
  const namePart = `${firstName}${lastName}` || randomAlphaNumeric(8);

  return `${namePart}${randomAlphaNumeric(5)}`.toLowerCase().slice(0, 64);
}

function sanitizeUsernamePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}

function randomAlphaNumeric(length: number) {
  return Array.from({ length }, () => RANDSTR_ALPHABET[randomInt(RANDSTR_ALPHABET.length)]).join('');
}

function randomInt(max: number) {
  if (max <= 0) {
    return 0;
  }

  const array = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  do {
    crypto.getRandomValues(array);
  } while (array[0] >= limit);
  return Number(array[0] % max);
}
