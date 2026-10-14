"""Read-only MCP diagnostic. Cookie/no-cookie probes do not replace real ChatGPT acceptance."""
import argparse
from http.cookiejar import CookieJar
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler, Request
import uuid


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the bearer credential to another endpoint.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', required=True, type=Path)
    parser.add_argument('--cookies', action='store_true')
    parser.add_argument('--requests', type=int, default=30)
    args = parser.parse_args()
    url = urlparse(args.url)
    if url.scheme != 'https' or url.username or url.password or url.query or url.fragment or url.path != '/mcp':
        parser.error('Use the exact HTTPS /mcp endpoint without credentials or query parameters')
    if not 1 <= args.requests <= 100:
        parser.error('Use 1-100 requests')
    token = args.token_file.read_text().strip()
    opener = build_opener(NoRedirects(), *([HTTPCookieProcessor(CookieJar())] if args.cookies else []))
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26'}
    failures = 0

    def call(method, params=None, notification=False):
        nonlocal failures
        request_id = str(uuid.uuid4())
        body = {'jsonrpc': '2.0', 'method': method}
        if not notification:
            body['id'] = request_id
        if params is not None:
            body['params'] = params
        request = Request(args.url, json.dumps(body).encode(),
                          {**headers, 'X-Request-Id': request_id})
        try:
            response = opener.open(request, timeout=30)
        except HTTPError as error:
            response = error
        data = response.read(8 * 1024 * 1024)
        error = None
        if data and response.status == 200:
            result = json.loads(data)
            error = result.get('error', {}).get('code')
        ok = response.status in (200, 202, 204) and error is None
        failures += int(not ok)
        print(json.dumps({'request_id': request_id, 'method': method, 'status': response.status,
                          'rpc_error_code': error, 'cookies': args.cookies}), flush=True)
        # Session identifiers and Set-Cookie values never enter diagnostic output.
        session = response.headers.get('Mcp-Session-Id')
        if session:
            headers['Mcp-Session-Id'] = session
        return ok

    if not call('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                              'clientInfo': {'name': 'sync-eks-readonly-probe', 'version': '1'}}):
        raise SystemExit(1)
    call('notifications/initialized', notification=True)
    for index in range(args.requests):
        call('tools/list' if index % 2 == 0 else 'resources/list')
        time.sleep(1)
    # No tools/call, paid action, automatic session retry, or replay is performed.
    raise SystemExit(1 if failures else 0)


if __name__ == '__main__':
    main()
