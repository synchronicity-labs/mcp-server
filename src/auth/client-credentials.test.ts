import { describe, expect, it } from 'vitest';
import { mergeBasicClientCredentials } from '../http-server.js';

const basic = `Basic ${Buffer.from('client:secret').toString('base64')}`;
describe('mixed client authentication regression', () => {
  it.each([
    { client_id: 'client' },
    { client_id: 'different' },
    { client_secret: 'secret' },
    { client_id: 'client', client_secret: 'secret' },
  ])('rejects mixed credentials %j', (body) => {
    expect(() => mergeBasicClientCredentials(body, basic)).toThrow();
  });
});

it.each([
  { body: { client_id: 'client', client_secret: 'secret' }, header: undefined },
  { body: {}, header: basic },
  { body: {}, header: basic.replace('Basic', 'bAsIc') },
])('accepts one supported method %j', ({ body, header }) => {
  expect(mergeBasicClientCredentials(body, header)).toEqual({
    client_id: 'client',
    client_secret: 'secret',
  });
});
it('decodes form-encoded Basic values once, preserving plus and colons', () => {
  const encoded = Buffer.from('client+name%2B%3A:secret%2B+%3A%2520').toString('base64');
  expect(mergeBasicClientCredentials({}, `Basic ${encoded}`)).toEqual({
    client_id: 'client name+:',
    client_secret: 'secret+ :%20',
  });
});
it.each([
  'Basic ***',
  'Basic YTpi==',
  'Basic YTpi, Basic YTpi',
  'Bearer secret',
  `Basic ${Buffer.from('client:%ZZ').toString('base64')}`,
  `Basic ${Buffer.from(':secret').toString('base64')}`,
  `Basic ${Buffer.from('client:').toString('base64')}`,
  `Basic ${Buffer.from('no-colon').toString('base64')}`,
])('rejects malformed or empty Basic %s', (header) => {
  expect(() => mergeBasicClientCredentials({}, header)).toThrow('Invalid client authentication');
});
it.each([
  { client_id: ['client'], client_secret: 'secret' },
  { client_id: 'client', client_secret: 42 },
  { client_id: 'client', client_secret: null },
])('rejects ambiguous credential shapes %j', (body) => {
  expect(() => mergeBasicClientCredentials(body, undefined)).toThrow();
});
it.each([1000, 16000, 1000000])('rejects long malformed padding (%i characters)', (length) => {
  expect(() => mergeBasicClientCredentials({}, `Basic YTpi${'='.repeat(length)}!`)).toThrow(
    'Invalid client authentication',
  );
});
it.each([
  'YTpi',
  'YTpiYw==',
  'YTpiYw',
  'YTpiY2Q=',
  'YTpiY2Q',
])('retains canonical or unpadded Basic %s', (value) => {
  expect(mergeBasicClientCredentials({}, `Basic ${value}`)).toMatchObject({ client_id: 'a' });
});
