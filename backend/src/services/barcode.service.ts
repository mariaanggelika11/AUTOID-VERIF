export type LicenseAddress = {
  street: string;
  city: string;
  state: string;
  zip: string;
};

export type LicenseData = {
  fullName: string;
  firstName: string;
  middleName: string;
  lastName: string;
  licenseNumber: string;
  gender: string;
  dob: string;
  expirationDate: string;
  issueDate: string;
  address: LicenseAddress;
  country: string;
};

export class InvalidBarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBarcodeError';
  }
}

const FIELD_KEYS = [
  'DCS',
  'DAC',
  'DAD',
  'DAQ',
  'DBB',
  'DBA',
  'DBD',
  'DBC',
  'DAG',
  'DAI',
  'DAJ',
  'DAK',
  'DCG'
] as const;

const REQUIRED_FIELDS = ['DCS', 'DAC', 'DAQ', 'DBB'] as const;
const FIELD_KEY_PATTERN = new RegExp(`(${FIELD_KEYS.join('|')})`, 'g');

type FieldKey = (typeof FIELD_KEYS)[number];

function cleanValue(value = '') {
  return value.replace(/\0/g, '').trim();
}

function requireField(fields: Map<string, string>, key: FieldKey) {
  return cleanValue(fields.get(key));
}

export function validateAamva(raw: string) {
  if (!raw.includes('ANSI') && !raw.includes('AAMVA')) {
    throw new InvalidBarcodeError('Invalid AAMVA barcode');
  }
}

export function parseDate(value = '') {
  const digits = value.replace(/\D/g, '');

  if (!digits) return '';
  if (digits.length !== 8) {
    throw new InvalidBarcodeError('Invalid date format');
  }

  const month = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidBarcodeError('Invalid date format');
  }

  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function mapGender(value = '') {
  const code = cleanValue(value);

  if (code === '1') return 'Male';
  if (code === '2') return 'Female';
  if (code === '9') return 'Not Specified';
  return 'Unknown';
}

export function cleanZip(value = '') {
  return value.replace(/\D/g, '').slice(0, 5);
}

function validateRequiredFields(fields: Map<string, string>) {
  const missingRequiredField = REQUIRED_FIELDS.some((field) => !requireField(fields, field));

  if (missingRequiredField) {
    throw new InvalidBarcodeError('Missing required AAMVA fields');
  }
}

export function collectAamvaFields(raw: string) {
  const normalized = raw.replace(/\r/g, '\n');
  const fields = new Map<string, string>();

  for (const line of normalized.split('\n')) {
    const trimmed = cleanValue(line);
    const key = FIELD_KEYS.find((candidate) => trimmed.startsWith(candidate));
    if (key) fields.set(key, cleanValue(trimmed.slice(3)));
  }

  const matches = [...normalized.matchAll(FIELD_KEY_PATTERN)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = match[1];
    const start = (match.index ?? 0) + key.length;
    const end = matches[index + 1]?.index ?? normalized.length;
    const value = cleanValue(normalized.slice(start, end).replace(/[\n\r]/g, ''));

    if (value && !fields.has(key)) {
      fields.set(key, value);
    }
  }

  return fields;
}

export function normalizeAamvaFields(fields: Map<string, string>): LicenseData {
  validateRequiredFields(fields);

  const firstName = requireField(fields, 'DAC');
  const middleName = requireField(fields, 'DAD');
  const lastName = requireField(fields, 'DCS');
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');

  return {
    fullName,
    firstName,
    middleName,
    lastName,
    licenseNumber: requireField(fields, 'DAQ'),
    gender: mapGender(fields.get('DBC')),
    dob: parseDate(requireField(fields, 'DBB')),
    expirationDate: parseDate(fields.get('DBA')),
    issueDate: parseDate(fields.get('DBD')),
    address: {
      street: requireField(fields, 'DAG'),
      city: requireField(fields, 'DAI'),
      state: requireField(fields, 'DAJ'),
      zip: cleanZip(fields.get('DAK'))
    },
    country: requireField(fields, 'DCG')
  };
}

export function parseAamvaBarcode(raw: string): LicenseData {
  validateAamva(raw);
  const fields = collectAamvaFields(raw);
  return normalizeAamvaFields(fields);
}
