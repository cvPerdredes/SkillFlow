"""Local, offline dual-port demo web server for SkillFlow v0.3.

Runs two fixed-port HTTP servers simultaneously (pure Python 3 stdlib):
- System A (default 18761): sys_a_query.html (Query & Light-Perturbation Demo)
- System B (default 18762): sys_b_form.html (Batch Ledger Entry & Receipt Demo)
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import urllib.parse
import webbrowser


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class DemoRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
    }

    def __init__(self, *args, directory=None, default_page="sys_a_query.html", **kwargs):
        self.default_page = default_page
        super().__init__(*args, directory=directory, **kwargs)

    def _rewrite_root(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path in ("", "/"):
            query = f"?{parsed.query}" if parsed.query else ""
            self.path = f"/{self.default_page}{query}"

    def do_GET(self):
        self._rewrite_root()
        super().do_GET()

    def do_HEAD(self):
        self._rewrite_root()
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def create_server(host: str, port: int, root: Path, default_page: str) -> ReusableThreadingHTTPServer:
    handler = partial(DemoRequestHandler, directory=str(root), default_page=default_page)
    return ReusableThreadingHTTPServer((host, port), handler)


def main():
    parser = argparse.ArgumentParser(description="SkillFlow v0.3 dual fixed-port local demo server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port-a", type=int, default=18761, help="System A fixed port (default: 18761)")
    parser.add_argument("--port-b", type=int, default=18762, help="System B fixed port (default: 18762)")
    parser.add_argument("--no-open", action="store_true", help="Do not launch browser tabs")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent / "demo-site"
    for required in ("sys_a_query.html", "sys_b_form.html", "index.html"):
        if not (root / required).is_file():
            raise SystemExit(f"Missing required demo file: demo-site/{required}")

    server_a = None
    server_b = None
    try:
        server_a = create_server(args.host, args.port_a, root, "sys_a_query.html")
        server_b = create_server(args.host, args.port_b, root, "sys_b_form.html")
    except OSError as exc:
        if server_a:
            server_a.server_close()
        if server_b:
            server_b.server_close()
        raise SystemExit(
            f"Unable to bind fixed ports ({args.port_a}/{args.port_b}): {exc}. "
            "You can override via --port-a / --port-b."
        )

    actual_a = server_a.server_address[1]
    actual_b = server_b.server_address[1]
    url_a = f"http://{args.host}:{actual_a}/sys_a_query.html"
    url_b = f"http://{args.host}:{actual_b}/sys_b_form.html"
    url_legacy = f"http://{args.host}:{actual_a}/index.html"

    thread_a = threading.Thread(target=server_a.serve_forever, daemon=True)
    thread_b = threading.Thread(target=server_b.serve_forever, daemon=True)
    thread_a.start()
    thread_b.start()

    print("SkillFlow v0.3 dual fixed-port local demo (Python)", flush=True)
    print(f"System A (Query): {url_a}", flush=True)
    print(f"System B (Form) : {url_b}", flush=True)
    print(f"Legacy Smoke    : {url_legacy}", flush=True)
    print("Press Ctrl+C to stop both servers.", flush=True)

    if not args.no_open:
        threading.Timer(0.6, webbrowser.open, args=(url_a,)).start()
        threading.Timer(1.0, webbrowser.open, args=(url_b,)).start()

    stop_event = threading.Event()
    try:
        while not stop_event.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        server_a.shutdown()
        server_b.shutdown()
        server_a.server_close()
        server_b.server_close()


if __name__ == "__main__":
    main()
