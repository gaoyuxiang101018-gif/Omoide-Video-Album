"""Loopback-only restoration API for the unified album window."""
import json
import logging
from logging.handlers import RotatingFileHandler
import mimetypes
import os
from pathlib import Path
from storage_paths import cache_dir, install_dir
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from film_service import FilmService
from resource_server import ALLOWED_ORIGINS


class FilmServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True
    service = None
    token = None
    def server_bind(self):
        if hasattr(socket,'SO_EXCLUSIVEADDRUSE'): self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def authorized(self): return self.headers.get('Origin') in ALLOWED_ORIGINS
    def respond(self, code, data):
        payload = json.dumps(data, ensure_ascii=False).encode('utf8')
        self.send_response(code)
        if self.authorized(): self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def do_OPTIONS(self):
        if not self.authorized(): return self.respond(403, {'error': 'Origin is not allowed'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Vary', 'Origin')
        self.end_headers()
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/output':
            token = parse_qs(parsed.query).get('token', [''])[0]
            if not secrets.compare_digest(token, self.server.token): return self.respond(403, {'error':'Access denied'})
            try:
                query = parse_qs(parsed.query)
                path = self.server.service.output_file(query['job'][0], int(query['index'][0]))
                return self.stream(path)
            except (KeyError, ValueError, OSError): return self.respond(404, {'error':'成片不可用。'})
        if not self.authorized(): return self.respond(403, {'error':'Origin is not allowed'})
        try:
            if parsed.path == '/status': return self.respond(200, {**self.server.service.status(), 'playback_token':self.server.token})
            if parsed.path == '/visibility': return self.respond(200, self.server.service.visibility())
            if parsed.path == '/capabilities': return self.respond(200, self.server.service.capabilities())
            return self.respond(404, {'error':'Unknown endpoint'})
        except Exception as error: self.respond(503, {'error':str(error)})
    def do_POST(self):
        if not self.authorized(): return self.respond(403, {'error':'Origin is not allowed'})
        if self.headers.get('Content-Type','').split(';')[0] != 'application/json': return self.respond(415, {'error':'JSON required'})
        try:
            length = int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 512000: return self.respond(413, {'error':'Request too large'})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('请求格式无效。')
            service = self.server.service
            if self.path in ('/analyze','/override','/enqueue','/control'):
                _, state = service.context()
                if body.get('library_key') != state['key']:
                    return self.respond(409, {'error':'资料库已切换，请刷新此页面后再操作。'})
            if self.path == '/catalog': data = service.catalog(body.get('media_ids'))
            elif self.path == '/analyze': data = service.analyze(body.get('media_ids'))
            elif self.path == '/override': data = service.override(body.get('media_id'), body.get('profile'))
            elif self.path == '/enqueue': data = service.enqueue(body.get('media_ids'), body.get('output_dir'), body.get('mode'), body.get('skip_completed',True))
            elif self.path == '/control': data = service.control(body.get('action'), body.get('job_id'))
            else: return self.respond(404, {'error':'Unknown endpoint'})
            self.respond(200, data)
        except (ValueError, TypeError, KeyError, OSError) as error: self.respond(400, {'error':str(error)})
        except Exception:
            logging.exception('Film API request failed')
            self.respond(500, {'error':'操作失败，请查看合并版日志。'})
    def stream(self, path):
        size = path.stat().st_size
        start, end = 0, size-1
        header = self.headers.get('Range')
        if header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', header)
            if not match: return self.respond(416, {'error':'Invalid range'})
            if match[1]:
                start = int(match[1]); end = min(int(match[2]), end) if match[2] else end
            elif match[2]: start = max(0, size-int(match[2]))
            else: return self.respond(416, {'error':'Invalid range'})
            if start > end or start >= size: return self.respond(416, {'error':'Invalid range'})
        with path.open('rb') as source:
            self.send_response(206 if header else 200)
            self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            self.send_header('Accept-Ranges','bytes')
            self.send_header('Cache-Control','no-store')
            self.send_header('Referrer-Policy','no-referrer')
            self.send_header('Content-Length',str(end-start+1))
            if header: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            source.seek(start); remaining = end-start+1
            try:
                while remaining:
                    chunk = source.read(min(256*1024,remaining))
                    if not chunk: break
                    self.wfile.write(chunk); remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass


def main():
    try: server = FilmServer(('127.0.0.1',18125),Handler)
    except OSError: return
    cache = cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    # Network-source snapshots and CLI manifests belong on the P-drive too.
    temporary = cache/'film-temp'
    temporary.mkdir(parents=True, exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(temporary)
    import tempfile
    tempfile.tempdir = str(temporary)
    logging.basicConfig(handlers=[RotatingFileHandler(cache/'film.log',maxBytes=1000000,backupCount=2,encoding='utf8')],level=logging.INFO)
    server.service = FilmService(cache/'film')
    server.token = secrets.token_urlsafe(32)
    # Separate process trees cannot always join an existing nested Windows job.
    # A dedicated job uses the same user-selected rate and includes future children.
    cpu_job = None
    try:
        import hashlib
        from resource_control import WindowsCpuJob, MODES
        target = (install_dir()/'omoide-0.7.5-cpu/omoide-0.7.5-cpu.exe').resolve()
        digest = hashlib.sha256(str(target).lower().encode()).hexdigest()[:16]
        cpu_job = WindowsCpuJob('Local\\OmoideRestoreCpuBudget-'+digest)
        mode = json.loads((cache/'resource-settings.json').read_text('utf8')).get('mode','balanced')
        percent = MODES.get(mode,50)
        cpu_job.set_percent(percent)
        handle = cpu_job.open_process(os.getpid())
        try: cpu_job.attach_handle(handle,percent)
        finally: cpu_job.kernel.CloseHandle(handle)
        server.service.resources = {'applied':True,'cpu_percent':percent}
    except Exception as error:
        logging.exception('Restore CPU budget could not be attached')
        server.service.resources = {'applied':False,'error':str(error)}
    def lifetime():
        last_seen = time.monotonic()
        while True:
            time.sleep(5)
            if cpu_job and server.service.resources.get('applied'):
                try:
                    mode = json.loads((cache/'resource-settings.json').read_text('utf8')).get('mode','balanced')
                    percent = MODES.get(mode,50)
                    cpu_job.set_percent(percent)
                    handle = cpu_job.open_process(os.getpid())
                    try: cpu_job.attach_handle(handle,percent)
                    finally: cpu_job.kernel.CloseHandle(handle)
                    server.service.resources = {'applied':True,'cpu_percent':percent}
                except Exception as error: server.service.resources = {'applied':False,'error':str(error)}
            try: server.service.config_reader(); last_seen = time.monotonic()
            except Exception:
                if time.monotonic()-last_seen > 60 and not server.service.active:
                    server.shutdown(); return
    threading.Thread(target=lifetime,daemon=True).start()
    try: server.serve_forever(poll_interval=.5)
    finally:
        server.service.close(); server.server_close()
        # Closing our handle must not reset the budget of the still-running album.
        if cpu_job and cpu_job.handle: cpu_job.kernel.CloseHandle(cpu_job.handle)


if __name__ == '__main__': main()
