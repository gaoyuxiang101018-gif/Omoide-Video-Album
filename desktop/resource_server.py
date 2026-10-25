import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_ORIGINS = {'http://127.0.0.1:8123', 'http://localhost:8123'}

class LocalResourceServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True
    controller = None
    def server_bind(self):
        if hasattr(socket,'SO_EXCLUSIVEADDRUSE'): self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        super().server_bind()

class ResourceHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def authorized(self):
        return self.headers.get('Origin') in ALLOWED_ORIGINS

    def respond(self, code, value=None):
        data = json.dumps(value or {}, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        if self.authorized(): self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if code != 204: self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.authorized() or self.path != '/resources': return self.respond(403)
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Vary', 'Origin')
        self.end_headers()

    def do_GET(self):
        if not self.authorized(): return self.respond(403, {'error': 'Origin is not allowed'})
        if self.path != '/resources': return self.respond(404)
        if not self.server.controller: return self.respond(503)
        self.respond(200, self.server.controller.apply())

    def do_POST(self):
        if not self.authorized(): return self.respond(403, {'error': 'Origin is not allowed'})
        if self.path != '/resources': return self.respond(404)
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json': return self.respond(415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024: return self.respond(413)
            body = json.loads(self.rfile.read(length))
            result = self.server.controller.set_mode(body.get('mode'))
            self.respond(200, result)
        except (ValueError, TypeError): self.respond(400, {'error': 'Invalid resource mode'})
        except Exception: self.respond(500, {'error': 'Resource setting failed'})

def create_server():
    return LocalResourceServer(('127.0.0.1', 18124), ResourceHandler)
