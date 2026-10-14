import contextlib
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import probe


class ProbeTests(unittest.TestCase):
    def test_reads_only_and_never_logs_credentials_or_session(self):
        class Response:
            status = 200
            headers = {'Mcp-Session-Id': 'private-session'}

            def read(self, limit):
                return b'{"jsonrpc":"2.0","result":{}}'

        class Opener:
            def __init__(self):
                self.calls = []

            def open(self, request, timeout):
                self.calls.append(request)
                return Response()

        opener = Opener()
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'token'
            token.write_text('private-token')
            output = StringIO()
            args = ['probe', '--url', 'https://fixture.invalid/mcp', '--token-file', str(token), '--requests', '2']
            with patch('sys.argv', args), patch('probe.build_opener', return_value=opener), patch('probe.time.sleep'), contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as result:
                    probe.main()
            self.assertEqual(result.exception.code, 0)
            methods = [json.loads(x.data)['method'] for x in opener.calls]
            self.assertEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'resources/list'])
            self.assertNotIn('private-token', output.getvalue())
            self.assertNotIn('private-session', output.getvalue())
            self.assertEqual(opener.calls[-1].get_header('Mcp-session-id'), 'private-session')

    def test_never_follows_redirect_with_authorization(self):
        self.assertIsNone(probe.NoRedirects().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))


if __name__ == '__main__':
    unittest.main()
