import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

function isPublicAddress(value: string): boolean {
  if (!isIP(value)) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== 'unicast') return false;
  // IPv6 unallocated space is not public, even if it has no named special range.
  return address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3);
}

export function validatedUploadSourceUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error(
      'Upload sources require HTTP(S), no credentials, and the protocol default port.',
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new Error('Upload sources must have a public destination.');
  }
  return url.href;
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  // Resolve inside the socket connection, and return only these checked addresses
  // to the connector. There is no subsequent DNS resolution for a rebind to alter.
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const first = addresses[0];
    if (!first || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('Upload sources must resolve only to public destinations.'), '');
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

export function createUploadSourceDispatcher(signal: AbortSignal): Agent {
  // An explicit direct agent bypasses global/proxy dispatchers. A transfer owns
  // its connections so arbitrary source hosts cannot accumulate cached pools.
  const connect = { lookup: publicLookup, signal };
  return new Agent({ connect });
}
