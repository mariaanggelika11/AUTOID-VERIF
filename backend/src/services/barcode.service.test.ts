import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidBarcodeError, cleanZip, mapGender, parseAamvaBarcode, parseDate } from './barcode.service.js';

const sampleRaw = [
  '@',
  'ANSI 636025080102DL00410288ZA03290015DL',
  'DCSSAMPLE',
  'DACJANICE',
  'DADANN',
  'DAQ99999999',
  'DBB08041969',
  'DBA08042023',
  'DBD10052015',
  'DBC2',
  'DAG123 MAIN STREET',
  'DAIHARRISBURG',
  'DAJPA',
  'DAK171010000',
  'DCGUSA'
].join('\n');

test('parses and normalizes AAMVA Driver License fields', () => {
  assert.deepEqual(parseAamvaBarcode(sampleRaw), {
    fullName: 'JANICE ANN SAMPLE',
    firstName: 'JANICE',
    middleName: 'ANN',
    lastName: 'SAMPLE',
    licenseNumber: '99999999',
    gender: 'Female',
    dob: '1969-08-04',
    expirationDate: '2023-08-04',
    issueDate: '2015-10-05',
    address: {
      street: '123 MAIN STREET',
      city: 'HARRISBURG',
      state: 'PA',
      zip: '17101'
    },
    country: 'USA'
  });
});

test('rejects non-AAMVA barcode payload', () => {
  assert.throws(() => parseAamvaBarcode('DAQ99999999'), {
    name: 'InvalidBarcodeError',
    message: 'Invalid AAMVA barcode'
  });
});

test('rejects missing required fields', () => {
  assert.throws(() => parseAamvaBarcode('@\nANSI\nDACJANICE\nDBB08041969'), {
    name: 'InvalidBarcodeError',
    message: 'Missing required AAMVA fields'
  });
});

test('rejects invalid date format', () => {
  assert.throws(() => parseDate('13321969'), {
    name: 'InvalidBarcodeError',
    message: 'Invalid date format'
  });
});

test('maps unknown gender to Unknown', () => {
  assert.equal(mapGender('7'), 'Unknown');
});

test('cleans ZIP to first 5 digits', () => {
  assert.equal(cleanZip('171010000'), '17101');
});

test('keeps custom error type available to controllers', () => {
  assert.ok(new InvalidBarcodeError('Invalid AAMVA barcode') instanceof Error);
});
