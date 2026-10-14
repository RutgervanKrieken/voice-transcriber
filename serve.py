# Local dev server that disables caching, so a refresh always loads the latest code.
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
http.server.ThreadingHTTPServer(("localhost", port), NoCacheHandler).serve_forever()
