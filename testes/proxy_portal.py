#!/usr/bin/env python3
"""
Proxy local que mostra o portal DealerNet em outro endereço (ex.: http://dealer-teste.localhost:8765),
para testar o Dealer/Fluxo num "portal de outro domínio" (botão "Ativar Dealer/Fluxo neste site").

Só escuta em 127.0.0.1 e só repassa para o portal configurado. Usado pelos testes; também dá para rodar
sozinho:  python3 testes/proxy_portal.py [porta] [url do portal]
"""
import http.client
import os
import http.server
import re
import socketserver
import sys
import threading
from urllib.parse import urlsplit

PULAR = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
         "content-encoding", "content-length", "accept-encoding", "host"}


def criar_servidor(porta, url_portal):
    destino = urlsplit(url_portal)
    host_destino = destino.hostname

    class Repasse(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _repassar(self):
            corpo = None
            if "Content-Length" in self.headers:
                corpo = self.rfile.read(int(self.headers["Content-Length"]))
            cabecalhos = {k: v for k, v in self.headers.items() if k.lower() not in PULAR}
            cabecalhos["Host"] = host_destino
            local = f"http://{self.headers.get('Host', '')}"
            for nome in ("Origin", "Referer"):
                if nome in cabecalhos:
                    cabecalhos[nome] = cabecalhos[nome].replace(local, f"{destino.scheme}://{host_destino}")
            con = (http.client.HTTPSConnection if destino.scheme == "https" else http.client.HTTPConnection)(
                host_destino, destino.port, timeout=180)
            try:
                con.request(self.command, self.path, body=corpo, headers=cabecalhos)
                resp = con.getresponse()
                dados = resp.read()
            except Exception as e:
                self.send_error(502, str(e))
                return
            finally:
                con.close()
            # Endereços completos do portal dentro de páginas, scripts e respostas JSON (redirecionamentos)
            tipo = resp.getheader("Content-Type", "")
            if re.search(r"text|json|javascript|xml", tipo):
                for esquema in ("https", "http"):
                    for barra in ("//", "\\/\\/"):
                        dados = dados.replace(f"{esquema}:{barra}{host_destino}".encode(),
                                              f"http:{barra}{self.headers.get('Host', '')}".encode())
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                kl = k.lower()
                if kl in PULAR:
                    continue
                if kl == "location":
                    v = re.sub(rf"^https?://{re.escape(host_destino)}", local, v)
                if kl == "set-cookie":
                    # o navegador está em http://*.localhost: tira o Domain do portal e o Secure
                    v = re.sub(r";\s*domain=[^;]*", "", v, flags=re.I)
                    v = re.sub(r";\s*secure", "", v, flags=re.I)
                    v = re.sub(r";\s*samesite=none", "; SameSite=Lax", v, flags=re.I)
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(dados)))
            self.end_headers()
            if self.command != "HEAD":
                try:
                    self.wfile.write(dados)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # o navegador desistiu da requisição

        do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_OPTIONS = _repassar

    class Servidor(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    return Servidor(("127.0.0.1", porta), Repasse)


def iniciar_em_segundo_plano(porta, url_portal):
    servidor = criar_servidor(porta, url_portal)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return servidor


if __name__ == "__main__":
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    url = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("DN_URL")
    if not url:
        raise SystemExit("Uso: proxy_portal.py [porta] <endereço do portal> (ou a variável DN_URL)")
    print(f"http://dealer-teste.localhost:{porta}/ -> {url}")
    criar_servidor(porta, url).serve_forever()
