"""
Vídeo de divulgação (1920x1080, MP4 H.264, sem áudio) com a extensão de verdade no portal e os dados pessoais
trocados por dados de demonstração o tempo todo (loja_comum.ANONIMIZAR_SEMPRE).

    python3 extensao/build.py
    DN_URL=https://<empresa>.dealernetworkflow.com.br/ DN_USUARIO=seu.usuario DN_SENHA='...' python3 testes/video_loja.py

Grava extensao/loja/dealer-fluxo-video.mp4. Como capturas_loja.py, só abre telas e menus: na busca nas listas abre
Administração > Empresarial > Empresa > Modifica > Geral > Flag e fecha sem Confirmar (nada é salvo).

Como funciona: o Chromium manda os quadros da tela pelo DevTools (Page.startScreencast) com a hora de cada um; o
roteiro pausa a gravação enquanto as telas carregam (o vídeo não mostra a espera) e o ffmpeg junta os quadros
respeitando os tempos. O cursor, as legendas e as teclas são desenhados na página (loja_comum.CAMADAS), porque a
captura não mostra o cursor de verdade. No fim, o OCR (tesseract, se houver) confere uma amostra dos quadros.
"""
import base64, os, shutil, subprocess, sys, tempfile, time, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testar
from loja_comum import ANONIMIZAR_SEMPRE, CAMADAS, CONFERIR, PROCURAR
from playwright.sync_api import sync_playwright

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DESTINO = os.environ.get("DESTINO") or os.path.join(RAIZ, "extensao", "loja", "dealer-fluxo-video.mp4")
ICONE = os.path.join(RAIZ, "extensao", "icones", "original.png")
LARGURA, ALTURA, ESCALA = 1280, 720, 1.5          # página 1280x720, quadros 1920x1080
QUADROS = tempfile.mkdtemp(prefix="dealerfluxo-video-")
ACHADOS = []
LINGUAS = "por+eng"


class Gravador:
    """Quadros do Page.startScreencast, com pausa: o tempo pausado é descontado."""

    def __init__(self, page):
        self.cdp = page.context.new_cdp_session(page)
        self.quadros = []            # (arquivo, tempo no vídeo)
        self.ativo = False
        self.desconto = 0.0
        self.pausado_em = None
        self.cdp.on("Page.screencastFrame", self._quadro)
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 93,
                                               "maxWidth": int(LARGURA * ESCALA), "maxHeight": int(ALTURA * ESCALA)})

    def _quadro(self, ev):
        try:
            self.cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]})
        except Exception:
            pass
        if not self.ativo:
            return
        arquivo = os.path.join(QUADROS, f"{len(self.quadros):06d}.jpg")
        with open(arquivo, "wb") as f:
            f.write(base64.b64decode(ev["data"]))
        self.quadros.append((arquivo, ev["metadata"]["timestamp"] - self.desconto))

    def comecar(self):
        self.ativo = True
        self.inicio = time.time()

    def pausar(self):
        if self.ativo:
            self.ativo = False
            self.pausado_em = time.time()

    def continuar(self):
        if not self.ativo:
            self.desconto += time.time() - self.pausado_em
            self.ativo = True

    def parar(self):
        self.fim = time.time() - self.desconto
        self.ativo = False
        try:
            self.cdp.send("Page.stopScreencast")
        except Exception:
            pass

    def montar(self, destino):
        q = self.quadros
        lista = os.path.join(QUADROS, "lista.txt")
        with open(lista, "w") as f:
            for i, (arq, t) in enumerate(q):
                prox = q[i + 1][1] if i + 1 < len(q) else self.fim
                f.write(f"file '{arq}'\nduration {max(0.001, prox - t):.4f}\n")
            f.write(f"file '{q[-1][0]}'\n")
        duracao = self.fim - q[0][1]
        os.makedirs(os.path.dirname(destino), exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lista,
                        "-vf", f"fps=30,scale={int(LARGURA * ESCALA)}:{int(ALTURA * ESCALA)}:flags=lanczos,format=yuv420p,"
                               f"fade=t=out:st={duracao - 0.7:.2f}:d=0.7",
                        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", destino], check=True)
        return duracao


class Roteiro:
    def __init__(self, p, g):
        self.p, self.g, self.pg = p, g, p.page
        self.pos = (LARGURA / 2, ALTURA / 2)

    # --- camadas ---
    def js(self, codigo, arg=None):
        return self.p.js(codigo, arg)

    def legenda(self, titulo=None, sub=None, espera=0):
        self.js("([t, s]) => window.__camadas.legenda(t, s)", [titulo, sub])
        self.esperar(espera)

    def esperar(self, ms):
        if ms:
            self.pg.wait_for_timeout(ms)

    # --- mouse ---
    def mover(self, x, y, dur=0.5):
        x0, y0 = self.pos
        passos = max(6, int(dur * 45))
        for i in range(1, passos + 1):
            k = i / passos
            e = k * k * (3 - 2 * k)
            xi, yi = x0 + (x - x0) * e, y0 + (y - y0) * e
            self.pg.mouse.move(xi, yi)
            self.js("([x, y]) => window.__camadas.cursor(x, y)", [xi, yi])
            self.pg.wait_for_timeout(dur * 1000 / passos * 0.6)
        self.pos = (x, y)

    def centro(self, loc):
        loc.wait_for(state="visible", timeout=15000)
        b = loc.bounding_box()
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

    def ir(self, loc, dur=0.5, horizontal_primeiro=False):
        x, y = self.centro(loc)
        if horizontal_primeiro:                  # submenus: anda na linha do item pai antes de descer
            self.mover(x, self.pos[1], dur * 0.6)
            dur *= 0.6
        self.mover(x, y, dur)
        return x, y

    def clicar(self, loc, dur=0.5, depois=400, botao="left", horizontal_primeiro=False):
        x, y = self.ir(loc, dur, horizontal_primeiro)
        self.esperar(120)
        self.js("([x, y]) => window.__camadas.clique(x, y)", [x, y])
        self.pg.mouse.click(x, y, button=botao)
        self.esperar(depois)

    def teclas(self, combo, rotulos, nota=None, depois=1100):
        self.js("([l, n]) => window.__camadas.teclas(l, n)", [rotulos, nota])
        self.esperar(250)
        self.pg.keyboard.press(combo)
        self.esperar(depois)

    # --- portal ---
    def carregar(self, condicao_js=None, janela=None, extra=600):
        """Pausa a gravação enquanto algo carrega."""
        self.g.pausar()
        if condicao_js:
            self.p.esperar_js(condicao_js, 20000, "não carregou")
        if janela:
            self.p.esperar_tela_carregada(janela)
        self.esperar(extra)
        self.g.continuar()
        self.mover(self.pos[0] + 1, self.pos[1], 0.05)     # força um quadro novo

    def abrir_menu(self, topo, *caminho):
        antes = self.js("() => oW5Portal.windows.length")
        self.clicar(self.pg.get_by_role("button", name=topo).first, depois=450)
        for i, texto in enumerate(caminho):
            item = self.p.item_menu(texto)
            if i < len(caminho) - 1:
                self.ir(item, 0.4, horizontal_primeiro=i > 0)
                self.esperar(450)
            else:
                self.clicar(item, 0.4, depois=100, horizontal_primeiro=i > 0)
        self.carregar(f"() => oW5Portal.windows.length > {antes}")
        janela = self.js("() => oW5Portal.windows[oW5Portal.windows.length - 1].id")
        self.carregar(janela=janela, extra=900)
        return janela

    def engrenagem(self, *caminho):
        self.esperar(300)
        self.clicar(self.pg.locator("#barraTarefasBotaoStatus"), depois=450)
        for i, texto in enumerate(caminho):
            item = self.p.item_menu(texto)
            if i < len(caminho) - 1:
                self.ir(item, 0.4, horizontal_primeiro=i > 0)
                self.esperar(500)
            else:
                self.clicar(item, 0.4, depois=700, horizontal_primeiro=i > 0)

    def conferir(self, nome):
        sobrou = self.js(CONFERIR)
        if sobrou:
            ACHADOS.append((nome, sobrou))


def roteiro(p):
    with open(ICONE, "rb") as f:
        icone = "data:image/png;base64," + base64.b64encode(f.read()).decode()
    p.preparar({"temaAlfaAceito": True, "temaFonteAceita": True,
                "fluxos": {"notificarAoAbrir": False, "som": False, "tempoNotificacao": 5}})
    pg = p.page
    p.js("() => " + ANONIMIZAR_SEMPRE)          # cuida também de todas as telas (iframes)
    p.js(CAMADAS, [icone])
    g = Gravador(pg)
    r = Roteiro(p, g)
    r.js("() => window.__camadas.capa('abertura')")
    r.js("() => window.__camadas.cursorVisivel(false)")     # sem cursor na capa
    r.mover(LARGURA / 2, ALTURA / 2 + 120, 0.05)
    r.esperar(400)
    g.comecar()

    # 0) Abertura
    r.esperar(2600)
    r.js("() => window.__camadas.capa(null)")
    r.esperar(900)                                            # a capa some em 0,8 s
    r.js("() => window.__camadas.cursorVisivel(true)")        # o cursor aparece já no DealerNet

    # 1) Barra de tarefas
    r.legenda("Barra de tarefas", "Todas as janelas abertas, sempre à mão")
    a = r.abrir_menu("Cadastro", "Pessoas")
    b = r.abrir_menu("CRM", "Pesquisas")
    r.conferir("barra")
    r.clicar(p.botao(a), depois=700)
    r.clicar(p.botao(b), depois=700)
    r.clicar(p.botao(a), depois=500)
    r.legenda("Clique direito: mais opções", "Duplicar, reabrir, fechar as outras...")
    r.clicar(p.botao(b), botao="right", depois=1500)
    r.js("() => Ext.menu.MenuMgr.hideAll()")
    r.esperar(300)

    # 2) Atalhos
    r.legenda("Atalhos de teclado", "Funcionam em qualquer tela")
    r.mover(700, 380, 0.4)
    r.teclas("Alt+KeyE", ["Alt", "E"], "janela da direita")
    r.teclas("Alt+KeyE", ["Alt", "E"], "janela da direita")
    r.teclas("Alt+KeyQ", ["Alt", "Q"], "janela da esquerda")
    r.teclas("Alt+Shift+KeyD", ["Alt", "Shift", "D"], "duplicar", depois=300)
    r.carregar("() => oW5Portal.windows.length === 3")
    r.carregar(janela=p.ativa(), extra=700)
    r.teclas("Alt+Shift+KeyW", ["Alt", "Shift", "W"], "fechar", depois=1200)
    r.teclas("Alt+KeyS", ["Alt", "S"], "minimizar", depois=1300)
    r.clicar(p.botao(a), depois=900)

    # 3) Aviso de novos fluxos
    r.legenda("Aviso de novos fluxos", "Com som opcional e notificação do sistema")
    r.esperar(800)
    p.simular_aumento(p.primeiro_fluxo(), 3)
    inicio = time.time()
    while not p.js("() => !!document.querySelector('.barraTarefasNotificacao.visivel')"):
        if time.time() - inicio > 1.5:
            g.pausar()
        if time.time() - inicio > 30:
            raise testar.Falha("o aviso de fluxos não apareceu")
        r.esperar(100)
    g.continuar()
    r.esperar(700)
    r.ir(pg.locator(".barraTarefasNotificacao.visivel"), 0.6)
    r.conferir("fluxos")
    r.esperar(2200)
    r.mover(640, 420, 0.5)
    r.esperar(5500)

    # 4) Avisos das telas
    r.legenda("Avisos das telas em destaque", "Não passam mais despercebidos")
    r.clicar(p.botao(a), depois=900)
    r.mover(150, 450, 0.4)
    p.js(f"""() => {{ const d = document.querySelector('#{a} iframe').contentDocument;
        d.getElementById('gxErrorViewer').innerHTML = '<div>Atenção!! Informe o CPF ou o CNPJ da pessoa antes de continuar.</div>'; }}""")
    r.esperar(4800)
    r.clicar(p.tela(a).locator("#dnf-aviso-pilula.dnf-visivel"), depois=1300)
    r.ir(p.tela(a).locator("#dnf-aviso .dnf-copiar"), 0.5)
    r.esperar(900)
    r.clicar(p.tela(a).locator("#dnf-aviso .dnf-fechar"), depois=1200)
    p.js(f"() => {{ document.querySelector('#{a} iframe').contentDocument.getElementById('gxErrorViewer').innerHTML = ''; }}")

    # 5) Busca nas listas (só abrir, nunca salvar)
    r.legenda("Busca nas listas", "Em \"Buscar na lista\" (ou Alt+F): parte do nome, sem acento, em qualquer ordem")
    e = r.abrir_menu("Administração", "Empresarial", "Empresa")
    r.clicar(p.tela(e).locator("#vUPDATE_0001"), depois=100)
    r.carregar("() => true", extra=4000)
    r.clicar(p.tela(e).locator("input[name=PARGERAL]"), depois=100)
    r.carregar("() => true", extra=5000)
    r.clicar(p.tela(e).locator("span.x-tab-strip-text", has_text="Flag"), depois=100)
    r.carregar("() => true", extra=2500)
    r.clicar(p.tela(e).locator("select[id^='PARAMETROEMPRESAGERALFLAG_TIPO_']").last, 0.5, depois=1300)
    pg.keyboard.type("hh", delay=250)                        # como na lista do navegador: a segunda opção com H
    r.esperar(900)
    r.clicar(p.tela(e).locator("#dnf-busca .dnf-barra-busca"), 0.4, depois=500)
    pg.keyboard.type("integracao", delay=110)
    r.conferir("busca")
    r.esperar(2200)
    pg.keyboard.press("Escape")
    r.esperar(300)
    g.pausar()
    p.js(f"() => Ext.getCmp('{e}').close()")             # fecha sem Confirmar: nada é salvo
    r.esperar(800)
    g.continuar()

    # 6) Aparência dos botões
    r.legenda("Do seu jeito", "12 formatos de botão, 8 preenchimentos e efeitos")
    r.engrenagem("Configurações...")
    r.esperar(500)
    r.clicar(pg.locator('.barraTarefasConfig .dbtAba[data-aba="barra"]'), depois=300)
    pg.locator(".barraTarefasConfig .dbtPreviaFundo").scroll_into_view_if_needed()
    r.esperar(400)
    pronto = pg.locator('.barraTarefasConfig select[name="botaoPronto"]')
    r.ir(pronto, 0.5)
    for nome in ("moderno", "setas", "neon", "bolinhas", "etiquetas", "setas"):
        pronto.select_option(nome)
        r.esperar(1500)
    r.clicar(pg.get_by_role("button", name="Salvar"), depois=1000)

    # 7) Temas de cores
    r.legenda("Temas de cores", "Claros e escuros, para o portal inteiro (alfa)")
    for tema in ("Dracula", "Nord", "GitHub Light", "Catppuccin Mocha"):
        r.engrenagem("Tema", tema)
        r.esperar(1400)
        r.conferir(f"tema {tema}")
    r.clicar(p.botao(b), depois=1200)
    r.clicar(p.botao(a), depois=1500)

    # 8) Configurações
    r.legenda("Tudo configurável", "Com busca nas configurações")
    r.engrenagem("Configurações...")
    for aba in ("fluxos", "atalhos", "tema"):
        r.clicar(pg.locator(f'.barraTarefasConfig .dbtAba[data-aba="{aba}"]'), depois=1300)
    r.clicar(pg.locator(".barraTarefasConfig .dbtCampoBuscaConfig"), depois=300)
    pg.keyboard.type("som volume", delay=110)
    r.esperar(2600)
    # (a aba Sobre fica de fora: o nome e o contato do autor seriam trocados pela anonimização)
    r.clicar(pg.get_by_role("button", name="Cancelar"), depois=600)
    r.legenda(None)
    r.esperar(500)

    # 9) Encerramento
    r.js("() => window.__camadas.cursorVisivel(false)")
    r.js("() => window.__camadas.capa('fim')")
    r.esperar(4500)
    g.parar()

    # Volta ao normal (fora do vídeo)
    p.js("() => DealerTema.definir({ tema: 'off' })")
    p.js("() => oW5Portal.closeAllWindows()")
    duracao = g.montar(DESTINO)
    print(f"vídeo: {os.path.relpath(DESTINO, RAIZ)} ({duracao:.1f}s, {len(g.quadros)} quadros)")


def ocr(video):
    if not shutil.which("tesseract"):
        print("OCR: tesseract não encontrado, pulei a conferência dos quadros")
        return
    pasta = tempfile.mkdtemp(prefix="dealerfluxo-ocr-")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-i", video, "-vf", "fps=2", os.path.join(pasta, "%04d.png")], check=True)
    for nome in sorted(os.listdir(pasta)):
        texto = subprocess.run(["tesseract", os.path.join(pasta, nome), "-", "-l", LINGUAS], capture_output=True, text=True,
                               env={**os.environ, "OMP_THREAD_LIMIT": "1"}).stdout.upper()
        achou = [x for x in PROCURAR if x in texto]
        if achou:
            ACHADOS.append((f"quadro {nome} (OCR)", achou))
    shutil.rmtree(pasta)


if __name__ == "__main__":
    args = types.SimpleNamespace(url=os.environ["DN_URL"], extensao=True, navegador="chromium", mostrar=False)
    with sync_playwright() as pw:
        original = pw.chromium.launch_persistent_context
        pw.chromium.launch_persistent_context = lambda *a, **k: original(*a, **{**k, "device_scale_factor": ESCALA})
        testar.rodar_em_tela(pw, args, f"{LARGURA}x{ALTURA}", os.environ["DN_USUARIO"], os.environ["DN_SENHA"],
                             [("video", "video", roteiro)], tempfile.mkdtemp())
    if os.path.exists(DESTINO):
        ocr(DESTINO)
    shutil.rmtree(QUADROS, ignore_errors=True)
    print("ACHADOS:", ACHADOS)
