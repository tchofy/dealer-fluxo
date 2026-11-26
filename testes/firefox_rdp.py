"""
Protocolo de depuração remota do Firefox (o mesmo que o web-ext e o about:debugging usam).
Os testes usam para instalar a extensão como "temporária" no Firefox do Playwright e para rodar código no
fundo dela (o Playwright não consegue abrir as páginas moz-extension:// do popup e das configurações).
"""
import json
import socket
import time

class RDP:
    def __init__(self, porta, timeout=20):
        limite = time.time() + timeout
        while True:
            try:
                self.s = socket.create_connection(("127.0.0.1", porta), timeout=10); break
            except OSError:
                if time.time() > limite: raise
                time.sleep(0.3)
        self.buf = b""
        self.ler()  # saudação

    def ler(self):
        while b":" not in self.buf:
            self.buf += self.s.recv(65536)
        tam, resto = self.buf.split(b":", 1)
        tam = int(tam)
        while len(resto) < tam:
            resto += self.s.recv(65536)
        self.buf = resto[tam:]
        return json.loads(resto[:tam])

    def pedir(self, msg):
        dados = json.dumps(msg).encode()
        self.s.sendall(str(len(dados)).encode() + b":" + dados)
        while True:
            r = self.ler()
            if r.get("from") == msg["to"]:
                return r

def instalar_temporario(porta, pasta):
    c = RDP(porta)
    raiz = c.pedir({"to": "root", "type": "getRoot"})
    r = c.pedir({"to": raiz["addonsActor"], "type": "installTemporaryAddon", "addonPath": pasta})
    return r

class Extensao:
    """Avalia código no fundo (background) de uma extensão instalada, como o 'Inspecionar' do about:debugging."""
    def __init__(self, porta, id_extensao):
        self.c = RDP(porta)
        desc = self._descritor(id_extensao)
        if desc.get("backgroundScriptStatus") not in (None, "RUNNING"):
            # Fundo suspenso: recarrega a extensão (como o botão "Recarregar" do about:debugging) para acordar
            self.c.pedir({"to": desc["actor"], "type": "reload"})
            for _ in range(50):
                time.sleep(0.2)
                desc = self._descritor(id_extensao)
                if desc.get("backgroundScriptStatus") == "RUNNING":
                    break
        watcher = self.c.pedir({"to": desc["actor"], "type": "getWatcher", "isServerTargetSwitchingEnabled": True})
        dados = json.dumps({"to": watcher["actor"], "type": "watchTargets", "targetType": "frame"}).encode()
        self.c.s.sendall(str(len(dados)).encode() + b":" + dados)
        self.console = None
        limite = time.time() + 15
        while time.time() < limite and not self.console:
            r = self.c.ler()
            if r.get("type") == "target-available-form" and r["target"].get("url", "").startswith("moz-extension://"):
                self.console = r["target"]["consoleActor"]
        if not self.console:
            raise RuntimeError("página de fundo da extensão não encontrada")

    def _descritor(self, id_extensao):
        addons = self.c.pedir({"to": "root", "type": "listAddons"})["addons"]
        return next(a for a in addons if a.get("id") == id_extensao)

    def _js(self, texto):
        dados = json.dumps({"to": self.console, "type": "evaluateJSAsync", "text": texto}).encode()
        self.c.s.sendall(str(len(dados)).encode() + b":" + dados)
        while True:
            r = self.c.ler()
            if r.get("type") == "evaluationResult":
                if r.get("exceptionMessage"):
                    raise RuntimeError(r["exceptionMessage"])
                return r.get("result")

    def avaliar(self, codigo, timeout=30):
        """codigo: expressão JS (pode usar await). Retorna o valor (passado por JSON)."""
        self._js("globalThis.__rdp = undefined; (async () => (" + codigo + "))().then("
                 "v => globalThis.__rdp = JSON.stringify({ok: v === undefined ? null : v}),"
                 "e => globalThis.__rdp = JSON.stringify({erro: String(e)})); 0")
        limite = time.time() + timeout
        while time.time() < limite:
            v = self._js("globalThis.__rdp")
            if isinstance(v, str):
                r = json.loads(v)
                if "erro" in r:
                    raise RuntimeError(r["erro"])
                return r["ok"]
            time.sleep(0.2)
        raise TimeoutError("sem resposta")
