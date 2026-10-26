"""Optional local launcher: Python standard library only, no packages."""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import sys
import webbrowser

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass

def main():
    root=Path(__file__).resolve().parent
    if not (root/'META_trace_Console.html').exists():
        print('META_trace_Console.html is missing. Extract the complete ZIP first.')
        return 1
    try:
        server=ThreadingHTTPServer(('127.0.0.1',8765),partial(QuietHandler,directory=str(root)))
    except OSError:
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(root)))
    port=server.server_address[1]
    url=f'http://127.0.0.1:{port}/META_trace_Console.html'
    print('META trace is open in your browser.')
    print('Leave this launcher open while viewing. Ctrl+C closes the launcher.')
    if not webbrowser.open(url):print('Open this address in your browser:',url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
    return 0

if __name__=='__main__':sys.exit(main())
