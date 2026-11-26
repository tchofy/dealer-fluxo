#!/usr/bin/env python3
"""
Testes automáticos do Dealer/Fluxo, no portal DealerNet de verdade, navegando como um usuário
(cliques, teclado e arrastos com o mouse).

Uso:
    DN_URL=https://<empresa>.dealernetworkflow.com.br/ DN_USUARIO=seu.usuario DN_SENHA='sua senha' python3 testes/testar.py
    (sem as variáveis, a senha é pedida no terminal)

Opções:
    --tela 1280x620        tamanho da área da página (pode repetir; padrão: 1280x620 e 1920x960)
    --extensao             testa a extensão gerada (extensao/build/chrome-teste) em vez de injetar o userscript;
                           inclui o teste "outro_dominio" (portal em outro endereço, via um proxy local)
    --navegador firefox    roda no Firefox do Playwright (padrão: chromium). No Firefox a extensão é instalada
                           como temporária, e o teste que precisa de rede lenta simulada é pulado
    --mostrar              abre o navegador na tela (padrão: invisível)
    --so nome1,nome2       roda só esses testes
    --lista                lista os testes e sai
    --url URL              endereço do portal (ou a variável DN_URL), ex.: https://<empresa>.dealernetworkflow.com.br/

Segurança: os testes só abrem telas de consulta (Cadastro > Pessoas, CRM > Pesquisas) e geram um relatório
(Títulos Emitidos a Receber, só leitura), nunca salvam nada, e desmarcam os fluxos que marcarem na Caixa de Entrada. As configurações do
Dealer/Fluxo usadas nos testes ficam num perfil temporário do navegador, separado do seu.

Saída: resumo no terminal; capturas de tela das falhas em testes/resultados/<data-hora>/.
"""
import argparse
import datetime
import http.server
import threading
import getpass
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback

from playwright.sync_api import sync_playwright

import firefox_rdp
import proxy_portal

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
USERSCRIPT = os.path.join(RAIZ, "userscript.js")
SORTABLE = os.path.join(RAIZ, "extensao", "vendor", "Sortable.min.js")
# Versão de teste da extensão: igual à normal, mas já com permissão para todos os sites (os testes não
# conseguem clicar no pedido de permissão do navegador)
EXTENSAO = {"chromium": os.path.join(RAIZ, "extensao", "build", "chrome-teste"),
            "firefox": os.path.join(RAIZ, "extensao", "build", "firefox-teste")}
PORTA_RDP = 6111
PREFS_FIREFOX = {
    "devtools.debugger.remote-enabled": True,      # para instalar a extensão e falar com o fundo dela
    "devtools.debugger.prompt-connection": False,
    "devtools.chrome.enabled": True,
}
PORTA_PROXY = 8765
PORTA_TELEMETRIA = 8766          # a build de teste da extensão manda a telemetria para cá (nunca para o servidor real)
HOST_PROXY = "dealer-teste.localhost"
CHAVE_CONFIG = "DealerBarraDeTarefas.config"

# Erros do próprio portal que aparecem mesmo sem o Dealer/Fluxo (não contam como falha)
RUIDO_DO_PORTAL = ["reading 'clientHeight'", 'access property "clientHeight"', "Missing required parameters: sitekey"]  # (Chromium, Firefox, reCAPTCHA do login)

# Registra avisos de fluxo e erros desde o começo de cada carregamento da página
SCRIPT_INICIAL = """
if (window.top === window) {
    window.__avisos = [];
    new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n => {
        if (n.classList && n.classList.contains('barraTarefasNotificacao')) {
            const t = n.querySelector('strong');
            window.__avisos.push(t ? t.textContent.trim() : '?');
        }
    }))).observe(document, { childList: true, subtree: true });
}
"""


class Falha(Exception):
    pass


def fazer_login(pg, base, usuario, senha):
    """Login preenchendo um campo de cada vez. Só envia se os dois campos estiverem certos: a página move o
    foco enquanto carrega (no Firefox a senha chegou a cair no campo do usuário) e cada envio errado conta
    como tentativa de senha errada na conta."""
    pg.goto(base.rstrip("/") + "/LoginAux.aspx?Windows")
    campo_usuario = pg.locator("#vUSUARIO_IDENTIFICADORALTERNATIVO")
    campo_senha = pg.locator("#vUSUARIOSENHA_SENHA")
    pg.wait_for_load_state("load")
    pg.wait_for_timeout(1000)
    for _ in range(3):
        campo_usuario.fill(usuario)
        campo_usuario.press("Tab")  # o portal passa o usuário para maiúsculas ao sair do campo
        pg.wait_for_timeout(500)
        campo_senha.fill(senha)
        pg.wait_for_timeout(300)
        if campo_usuario.input_value().lower() == usuario.lower() and campo_senha.input_value() == senha:
            break
    else:
        raise SystemExit("Não consegui preencher o login com segurança (nada foi enviado)")
    pg.get_by_role("button", name="Submit").click()
    try:
        pg.wait_for_url("**/Portal/default.html*", timeout=30000)
    except Exception:
        raise SystemExit("Login falhou (usuário/senha?)")
    esperar_portal(pg)


PORTAL_PRONTO = "() => !!(window.oW5Portal && oW5Portal.statusbar && oW5Portal.statusbar.rendered)"


def esperar_portal(pg, timeout=30000):
    """Espera o portal terminar de abrir. Recarregar antes disso pode interromper o carregamento das
    configurações do portal, e aí ele mesmo vai para logout.aspx (encerra a sessão; visto no Firefox)."""
    try:
        pg.wait_for_function(PORTAL_PRONTO, timeout=timeout)
    except Exception:
        if "logout" in pg.url.lower() or "login" in pg.url.lower():
            raise SystemExit(f"O portal encerrou a sessão (está em {pg.url}). Rode os testes de novo.")
        raise Falha("o portal não terminou de abrir")
    try:
        pg.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass


def verificar(condicao, mensagem):
    if not condicao:
        raise Falha(mensagem)


TESTES = []


def teste(descricao, so_extensao=False, so_chromium=False):
    def registrar(funcao):
        funcao.so_extensao = so_extensao
        funcao.so_chromium = so_chromium
        TESTES.append((funcao.__name__, descricao, funcao))
        return funcao
    return registrar


# ---------------------------------------------------------------------------------------------------------
# Portal: login, instalação do script e ações de usuário
# ---------------------------------------------------------------------------------------------------------

class Portal:
    def __init__(self, page, args):
        self.page = page
        self.args = args
        self.erros = []
        page.on("pageerror", lambda e: self.erros.append(str(e)))

    # --- básico ---
    def esperar(self, ms):
        self.page.wait_for_timeout(ms)

    def js(self, codigo, arg=None):
        return self.page.evaluate(codigo, arg) if arg is not None else self.page.evaluate(codigo)

    def esperar_condicao(self, condicao, timeout=10000):
        """Espera uma condição verificada pelo Python (sem falhar; quem chama verifica depois)."""
        limite = time.time() + timeout / 1000
        while time.time() < limite:
            try:
                if condicao():
                    return True
            except Exception:
                pass
            self.esperar(300)
        return False

    def esperar_js(self, codigo, timeout=10000, mensagem="condição não aconteceu"):
        try:
            self.page.wait_for_function(codigo, timeout=timeout)
        except Exception:
            raise Falha(f"{mensagem} (esperou {timeout / 1000:.0f}s)")

    def login(self, usuario, senha, pagina=None, base=None):
        fazer_login(pagina or self.page, base or self.args.url, usuario, senha)

    def instalar_script(self):
        """Sem a extensão (modo rápido para desenvolver): injeta o Sortable e o código-fonte direto na página."""
        self.page.add_script_tag(path=SORTABLE)
        with open(USERSCRIPT, encoding="utf-8") as f:
            self.page.add_script_tag(content=f.read())

    def preparar(self, config=None, mostrar_tutoriais=False):
        """Recarrega o portal com uma configuração conhecida e sem janelas abertas."""
        cfg = dict(config or {})
        if not mostrar_tutoriais:
            cfg.setdefault("tutoriaisOcultos", {"boasVindas": True, "fluxos": True, "privacidade": True})
        esperar_portal(self.page)
        self.js("([chave, valor]) => localStorage.setItem(chave, valor)", [CHAVE_CONFIG, json.dumps(cfg)])
        self.js("() => localStorage.removeItem('DealerTema.config')")   # tema sempre desligado (padrão) no começo
        try:
            self.page.reload(wait_until="domcontentloaded")
        except Exception:
            # O Firefox às vezes interrompe o recarregamento (NS_BINDING_ABORTED); abre de novo o endereço
            self.esperar(1000)
            self.page.goto(self.args.url.rstrip("/") + "/Portal/default.html", wait_until="domcontentloaded")
        esperar_portal(self.page)
        if not self.args.extensao:
            self.instalar_script()
        self.esperar_js("() => window.__dealerFluxoCarregado && document.getElementById('barraTarefasBotaoStatus')",
                        20000, "o Dealer/Fluxo não carregou")
        try:
            self.page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        self.js("() => { oW5Portal.closeAllWindows(); Ext.menu.MenuMgr.hideAll(); }")
        self.esperar(500)
        self.erros.clear()

    def config_salva(self):
        return json.loads(self.js(f"() => localStorage.getItem('{CHAVE_CONFIG}') || '{{}}'"))

    # --- menus e janelas ---
    def abrir_menu(self, topo, *caminho):
        pg = self.page
        antes = self.js("() => oW5Portal.windows.length")
        self.js("() => Ext.menu.MenuMgr.hideAll()")
        self.esperar(200)
        pg.get_by_role("button", name=topo).first.click()
        self.esperar(600)
        for i, texto in enumerate(caminho):
            item = self.item_menu(texto)
            if i < len(caminho) - 1:
                item.hover()
                self.esperar(600)
            else:
                item.click()
        self.esperar_js(f"() => oW5Portal.windows.length > {antes}", 15000, f"a janela de {caminho[-1]} não abriu")
        janela = self.js("() => oW5Portal.windows[oW5Portal.windows.length - 1].id")
        self.esperar_tela_carregada(janela)
        return janela

    def abrir_pessoas(self):
        return self.abrir_menu("Cadastro", "Pessoas")

    def abrir_pesquisas(self):
        return self.abrir_menu("CRM", "Pesquisas")

    def abrir_relatorio_titulos(self):
        """Financeiro > Relatórios > Contas a Receber > Títulos Emitidos a Receber (há outro 'Contas a Receber'
        direto em Financeiro, por isso o segundo item visível)."""
        pg = self.page
        antes = self.js("() => oW5Portal.windows.length")
        self.js("() => Ext.menu.MenuMgr.hideAll()")
        self.esperar(200)
        pg.get_by_role("button", name="Financeiro").first.click()
        self.esperar(600)
        self.item_menu("Relatórios").hover()
        self.esperar(700)
        pg.locator(".x-menu-item-text").filter(has_text=re.compile("^Contas a Receber$")).locator("visible=true").nth(1).hover()
        self.esperar(800)
        self.item_menu("Títulos Emitidos a Receber").click()
        self.esperar_js(f"() => oW5Portal.windows.length > {antes}", 15000, "a janela do relatório não abriu")
        janela = self.js("() => oW5Portal.windows[oW5Portal.windows.length - 1].id")
        self.esperar_tela_carregada(janela)
        return janela

    def item_menu(self, texto, exato=True):
        padrao = re.compile("^" + re.escape(texto) + "$") if exato else re.compile(re.escape(texto))
        return self.page.locator(".x-menu-item-text").filter(has_text=padrao).locator("visible=true").first

    def esperar_tela_carregada(self, janela, timeout=20000):
        self.esperar_js(f"""() => {{ const f = document.querySelector('#{janela} iframe');
            try {{ return f && f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.body.children.length > 0; }}
            catch (e) {{ return false; }} }}""", timeout, f"a tela da janela {janela} não carregou")
        self.esperar(500)

    def tela(self, janela):
        return self.page.frame_locator(f"#{janela} iframe")

    def url_tela(self, janela):
        return self.js(f"() => document.querySelector('#{janela} iframe').contentWindow.location.href.split('/').pop()")

    def botao(self, janela):
        return self.page.locator(f'#barraDeTarefas button[data-window-id="{janela}"]')

    def classes_botao(self, janela):
        return self.js(f"() => {{ const b = document.querySelector('#barraDeTarefas button[data-window-id=\"{janela}\"]'); return b ? [...b.classList] : null }}")

    def ativa(self):
        return self.js("() => { const a = Ext.WindowMgr.getActive(); return a && a.id }")

    def minimizadas(self):
        return self.js("() => document.querySelector('#W5-minimized-menu button').textContent.trim()")

    def zindex(self, janela):
        return self.js(f"() => +document.getElementById('{janela}').style.zIndex")

    def posicao(self, janela):
        return self.js(f"() => {{ const w = Ext.getCmp('{janela}'); return [...w.getPosition(), ...Object.values(w.getSize())] }}")

    def restaurar_tamanho(self, janela, x, y):
        self.js(f"() => {{ const w = Ext.getCmp('{janela}'); if (w.maximized) w.restore(); w.setPosition({x}, {y}); }}")
        self.esperar(300)

    def menu_contexto(self, janela):
        self.botao(janela).click(button="right")
        self.esperar(400)

    def menu_engrenagem(self, texto):
        self.esperar(300)   # o ExtJS ignora um clique no botão logo depois de fechar o menu dele
        self.page.locator("#barraTarefasBotaoStatus").click()
        self.esperar(300)
        self.item_menu(texto).click()
        self.esperar(800)

    def aba_config(self, aba):
        """Abre uma aba da janela de configurações (barra, telas, fluxos, escolha, atalhos)."""
        self.page.locator(f'.barraTarefasConfig .dbtAba[data-aba="{aba}"]').click()
        self.esperar(200)

    def mover_mouse_humano(self, x0, y0, x1, y1, passos=6):
        """Movimento rápido mas em velocidade humana (um passo a cada ~16 ms, como 60 fps)."""
        for i in range(1, passos + 1):
            self.page.mouse.move(x0 + (x1 - x0) * i / passos, y0 + (y1 - y0) * i / passos)
            self.esperar(16)

    def latencia(self, ms):
        if self.args.navegador != "chromium":
            return  # só o Chromium simula rede lenta (os testes que dependem disso são pulados no Firefox)
        if not hasattr(self, "_cdp"):
            self._cdp = self.page.context.new_cdp_session(self.page)
            self._cdp.send("Network.enable")
        self._cdp.send("Network.emulateNetworkConditions",
                       {"offline": False, "latency": ms, "downloadThroughput": -1, "uploadThroughput": -1})

    # --- geometria ---
    def caixa(self, seletor):
        return self.js(f"""() => {{ const e = [...document.querySelectorAll('{seletor}')].filter(x => x.offsetWidth).pop();
            if (!e) return null; const r = e.getBoundingClientRect();
            return {{ top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight }} }}""")

    def verificar_na_tela(self, seletor, nome):
        c = self.caixa(seletor)
        verificar(c is not None, f"{nome} não está visível")
        verificar(c["top"] >= 0 and c["left"] >= 0 and c["bottom"] <= c["h"] + 0.5 and c["right"] <= c["w"] + 0.5,
                  f"{nome} não cabe na tela: topo={c['top']:.0f} base={c['bottom']:.0f} esq={c['left']:.0f} "
                  f"dir={c['right']:.0f} (tela {c['w']}x{c['h']})")

    # --- Caixa de Entrada (tela de fundo) ---
    def caixa_entrada(self):
        return self.page.frame_locator("iframe.W5Portal_Window_Frame").first

    def frame_caixa_entrada(self):
        for f in self.page.frames:
            if "WP_Fluxo" in f.url and f.parent_frame == self.page.main_frame:
                return f
        raise Falha("Caixa de Entrada (WP_Fluxo) não encontrada")

    def fluxos_marcados(self):
        return self.frame_caixa_entrada().evaluate("""() => [...document.querySelectorAll('[id*="IMGFLUXO_"]')]
            .filter(i => /IcoMarcado\\.gif$/.test(i.getAttribute('src') || '')).map(i => i.id)""")

    def fluxo_marcado_visivel(self):
        """O fluxo marcado está na tela, sem outra aba (Definições...) desenhada por cima."""
        return self.frame_caixa_entrada().evaluate("""() => {
            const img = [...document.querySelectorAll('[id*="IMGFLUXO_"]')].find(i => /IcoMarcado\\.gif$/.test(i.getAttribute('src') || ''));
            if (!img) return false;
            const r = img.getBoundingClientRect(); const topo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!topo && (topo === img || img.contains(topo)); }""")

    def desmarcar_fluxos(self):
        for img in self.fluxos_marcados():
            self.caixa_entrada().locator(f"#{img}").click()
            self.esperar(2000)

    def simular_aumento(self, inicio_nome, quanto):
        """Aumenta a quantidade de um fluxo só na cópia da página deste navegador (nada vai para o servidor)."""
        ok = self.frame_caixa_entrada().evaluate("""([inicio, quanto]) => {
            const s = [...document.querySelectorAll('span[id*="vTMPFLUXOPROCESSO_DESCRICAO_"]')].find(x => x.textContent.startsWith(inicio));
            if (!s) return false;
            s.textContent = s.textContent.replace(/\\((\\d+)\\)/, (m, n) => '(' + (Number(n) + quanto) + ')');
            return true; }""", [inicio_nome, quanto])
        verificar(ok, f"fluxo '{inicio_nome}' não está na Caixa de Entrada")

    def avisos(self):
        return self.js("() => window.__avisos || []")

    def primeiro_fluxo(self):
        nome = self.frame_caixa_entrada().evaluate("""() => { const s = document.querySelector('span[id*="vTMPFLUXOPROCESSO_DESCRICAO_"]');
            return s ? s.textContent.trim().replace(/\\s*\\(\\d+\\)$/, '') : null }""")
        verificar(nome, "a Caixa de Entrada não tem nenhum fluxo pendente (alguns testes precisam de pelo menos um)")
        return nome


# ---------------------------------------------------------------------------------------------------------
# Testes
# ---------------------------------------------------------------------------------------------------------

@teste("Script carrega: barra, engrenagem e sino criados, barra de status do tamanho original")
def carregamento(p):
    p.preparar()
    verificar(p.js("() => !!document.getElementById('barraDeTarefas')"), "barra de tarefas não foi criada")
    verificar(p.js("() => document.getElementById('barraDeTarefas').style.display === 'none'"), "barra visível sem janelas abertas")
    verificar(p.js("() => !!document.getElementById('barraTarefasBotaoFluxos')"), "botão do sino não foi criado")
    verificar(p.js("() => typeof Sortable === 'function'"), "Sortable não carregou")
    p.verificar_na_tela("#W5-minimized-menu", "botão Minimizadas do portal")
    p.verificar_na_tela("#barraTarefasBotaoStatus", "botão da engrenagem")
    # Sino na barra do alto, logo à direita do "Minimiza todas janelas"; engrenagem compacta na barra de status
    p.verificar_na_tela("#barraTarefasBotaoFluxos", "botão do sino")
    sino = p.caixa("#barraTarefasBotaoFluxos")
    minimizar_todas = p.caixa("table.minimizeAll")
    verificar(abs(sino["top"] - minimizar_todas["top"]) <= 6, "o sino não está na mesma barra do 'Minimiza todas janelas'")
    verificar(0 <= sino["left"] - minimizar_todas["right"] <= 6,
              f"o sino deveria ficar logo à direita do 'Minimiza todas janelas' (distância {sino['left'] - minimizar_todas['right']:.0f}px)")
    engrenagem = p.caixa("#barraTarefasBotaoStatus")
    verificar(engrenagem["right"] - engrenagem["left"] <= 36, f"engrenagem ocupa {engrenagem['right'] - engrenagem['left']:.0f}px")
    verificar(p.js("() => document.querySelector('.x-toolbar:has(#W5-minimized-menu) #barraTarefasBotaoStatus') !== null"),
              "a engrenagem saiu da barra de status")


@teste("Aviso de boas-vindas aparece na 1a vez, cabe na tela e respeita 'Não mostrar novamente'")
def boas_vindas(p):
    p.preparar(mostrar_tutoriais=True)
    p.esperar_js("() => !!document.querySelector('.barraTarefasTutorial')", 6000, "o aviso de boas-vindas não apareceu")
    p.esperar(500)
    verificar("chamado" in p.js("() => document.querySelector('.barraTarefasTutorial').textContent"), "texto do aviso sobre chamados não encontrado")
    p.verificar_na_tela(".x-window.barraTarefasJanela", "janela de boas-vindas")
    entendi = p.page.get_by_role("button", name="Entendi")
    verificar(entendi.is_visible(), "botão Entendi não está visível")
    verificar(p.page.locator("#dbtNaoMostrar_boasVindas").is_checked(), "'Não mostrar novamente' deveria vir marcado")
    entendi.click()
    p.esperar(400)
    verificar(p.config_salva().get("tutoriaisOcultos", {}).get("boasVindas") is True, "'Não mostrar novamente' não foi salvo")
    # Depois das boas-vindas, uma vez só: o aviso das estatísticas de uso, com a opção ali mesmo
    p.esperar_js("() => !!document.getElementById('dbtAvisoTelemetria')", 6000, "o aviso das estatísticas de uso não apareceu")
    p.verificar_na_tela(".x-window.barraTarefasJanela", "aviso das estatísticas de uso")
    verificar(p.page.locator("#dbtAvisoTelemetria").is_checked(), "as estatísticas de uso deveriam vir ligadas")
    p.page.get_by_role("button", name="OK").click()
    p.esperar(400)
    salvo = p.config_salva()
    verificar(salvo.get("tutoriaisOcultos", {}).get("privacidade") is True and salvo.get("telemetria") is True,
              "o aviso das estatísticas não ficou marcado como visto")
    # Recarrega mantendo a configuração salva: não pode aparecer de novo
    p.page.reload(wait_until="domcontentloaded")
    if not p.args.extensao:
        p.instalar_script()
    p.esperar_js("() => window.__dealerFluxoCarregado", 20000)
    p.esperar(3000)
    verificar(not p.js("() => !!document.querySelector('.barraTarefasTutorial')"), "o aviso apareceu de novo")


@teste("Barra aparece com janelas, não esconde os itens da barra de status e some quando todas fecham")
def layout_barra(p):
    p.preparar()
    altura_original = p.js("() => oW5Portal.statusbar.getHeight()")
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    p.esperar(500)
    verificar(p.js("() => document.getElementById('barraDeTarefas').style.display !== 'none'"), "barra não apareceu")
    verificar(p.js("() => document.querySelectorAll('#barraDeTarefas button').length") == 2, "deveria ter 2 botões")
    p.verificar_na_tela("#barraDeTarefas", "barra de tarefas")
    p.verificar_na_tela("#W5-minimized-menu", "botão Minimizadas do portal (barra de status)")
    p.verificar_na_tela("#barraTarefasBotaoStatus", "botão da engrenagem")
    sb = p.caixa(".x-toolbar:has(#W5-minimized-menu)")
    verificar(abs(sb["bottom"] - sb["h"]) <= 1, f"barra de status não está colada no rodapé (base {sb['bottom']:.0f}, tela {sb['h']})")
    jan = p.caixa(f"#{b}")
    verificar(jan["bottom"] <= sb["top"] + 1, "janela maximizada passa por cima da barra de status")
    p.js("() => oW5Portal.closeAllWindows()")
    p.esperar(600)
    verificar(p.js("() => oW5Portal.statusbar.getHeight()") == altura_original, "barra de status não voltou ao tamanho original")
    verificar(p.js("() => document.getElementById('barraDeTarefas').style.display === 'none'"), "barra continuou visível sem janelas")


@teste("Clicar nos botões alterna a janela da frente (z-index e janela ativa do ExtJS)")
def alternar_janelas(p):
    p.preparar()
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    p.restaurar_tamanho(a, 300, 220)   # janelas sobrepostas, mas com os dois títulos visíveis
    p.restaurar_tamanho(b, 20, 60)
    for janela, outra in ((a, b), (b, a), (a, b)):
        p.botao(janela).click()
        p.esperar(300)
        verificar(p.ativa() == janela, f"{janela} deveria estar ativa")
        verificar(p.zindex(janela) > p.zindex(outra), f"{janela} deveria estar na frente de {outra}")
        verificar("ativo" in p.classes_botao(janela) and "ativo" not in p.classes_botao(outra), "destaque do botão errado")
    # Clique no título da outra janela (pelo portal): o botão acompanha
    p.page.locator(f"#{b} .x-window-header-text").click()
    p.esperar(300)
    verificar("ativo" in p.classes_botao(b), "botão não acompanhou o clique no título da janela")


@teste("Minimizar pelo portal e restaurar pela barra mantém o contador 'Minimizadas' certo")
def minimizar_restaurar(p):
    p.preparar()
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    # Mesmo com o aviso de fluxos na tela (canto superior direito), os botões da janela ficam livres
    p.page.locator(f"#{b} .x-tool-minimize").click(timeout=5000)
    p.esperar(800)
    verificar("botaoMinimizado" in p.classes_botao(b), "botão não ficou como minimizado")
    verificar(p.minimizadas() == "Minimizadas (1)", f"contador errado: {p.minimizadas()}")
    p.botao(b).click()
    p.esperar(800)
    verificar(p.ativa() == b and p.minimizadas() == "Minimizadas (0)", f"não restaurou direito ({p.minimizadas()})")
    p.page.locator(".minimizeAll").first.click()
    p.esperar(900)
    verificar(p.minimizadas() == "Minimizadas (2)", f"Minimizar todas: contador {p.minimizadas()}")
    p.botao(a).click()
    p.esperar(800)
    p.botao(b).click()
    p.esperar(800)
    verificar(p.minimizadas() == "Minimizadas (0)", f"depois de restaurar as duas: {p.minimizadas()}")
    itens = p.js("() => oW5Portal.statusbar.minimizedWindows.items.items.filter(i => !i.hidden).length")
    verificar(itens == 0, f"sobraram {itens} itens no menu Minimizadas")


@teste("Atalhos de teclado (padrão) funcionam com o cursor dentro da tela: Alt+Q/E, Alt+Shift+número, Alt+S, Alt+Shift+D/W/C")
def atalhos(p):
    p.preparar()
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    p.botao(a).click()
    p.esperar(300)
    p.tela(a).locator("#vPESSOA_NOME").click()  # cursor dentro da tela
    teclado = p.page.keyboard
    teclado.press("Alt+KeyE"); p.esperar(500)
    verificar(p.ativa() == b, "Alt+E não foi para a janela da direita")
    teclado.press("Alt+KeyE"); p.esperar(500)
    verificar(p.ativa() == a, "Alt+E não deu a volta para a primeira")
    teclado.press("Alt+KeyQ"); p.esperar(500)
    verificar(p.ativa() == b, "Alt+Q não funcionou")
    teclado.press("Alt+Shift+Digit1"); p.esperar(500)
    verificar(p.ativa() == a, "Alt+Shift+1 não funcionou")
    teclado.press("Alt+KeyS"); p.esperar(800)
    verificar("botaoMinimizado" in p.classes_botao(a), "Alt+S não minimizou")
    teclado.press("Alt+Shift+Digit1"); p.esperar(800)
    verificar(p.ativa() == a and "botaoMinimizado" not in p.classes_botao(a), "Alt+Shift+1 não restaurou a janela minimizada")
    p.tela(a).locator("#vPESSOA_NOME").click()
    teclado.press("Alt+Shift+KeyD")
    p.esperar_js("() => oW5Portal.windows.length === 3", 10000, "Alt+Shift+D não duplicou a janela")
    p.esperar_tela_carregada(p.ativa())
    teclado.press("Alt+Shift+KeyW")
    p.esperar_js("() => oW5Portal.windows.length === 2", 10000, "Alt+Shift+W não fechou a janela ativa")
    p.tela(a).locator("#vPESSOA_NOME").click()
    teclado.press("Alt+Shift+KeyC")
    p.esperar_js("() => !!document.querySelector('.x-window.barraTarefasJanela .barraTarefasConfig')", 5000, "Alt+Shift+C não abriu as configurações")
    p.page.get_by_role("button", name="Cancelar").click()


@teste("Duplicar cria uma janela de verdade; botão do meio fecha; Alt+Shift+T e o menu reabrem")
def duplicar_reabrir(p):
    p.preparar()
    a = p.abrir_pesquisas()
    p.menu_contexto(a)
    p.item_menu("Duplicar").click()
    p.esperar_js(f"() => oW5Portal.windows.length === 2", 10000, "a cópia não abriu")
    copia = p.js("() => oW5Portal.windows[1].id")
    verificar(p.js(f"() => Ext.getCmp('{copia}') instanceof Ext.Window"), "a cópia não é uma Ext.Window")
    verificar("(Cópia)" in p.js(f"() => Ext.getCmp('{copia}').title"), "título da cópia sem '(Cópia)'")
    p.esperar_tela_carregada(copia)
    verificar(p.url_tela(copia) == p.url_tela(a), "a cópia não abriu a mesma tela")
    p.botao(copia).click(button="middle")
    p.esperar(700)
    verificar(p.js("() => oW5Portal.windows.length") == 1 and p.botao(copia).count() == 0, "botão do meio não fechou a janela")
    p.botao(a).click()
    p.page.keyboard.press("Alt+Shift+KeyT")
    p.esperar_js("() => oW5Portal.windows.length === 2", 10000, "Alt+Shift+T não reabriu")
    nova = p.js("() => oW5Portal.windows[1].id")
    p.esperar_tela_carregada(nova)
    p.botao(nova).click(button="middle")
    p.esperar(700)
    p.page.locator("#barraTarefasBotaoStatus").click()
    p.esperar(300)
    p.item_menu("Reabrir janela fechada").hover()
    p.esperar(500)
    p.item_menu("(Cópia)", exato=False).click()
    p.esperar_js("() => oW5Portal.windows.length === 2", 10000, "o menu da engrenagem não reabriu")


@teste("Menu de contexto: ícones, título alinhado e fecha ao clicar dentro de uma tela")
def menu_contexto(p):
    p.preparar()
    a = p.abrir_pessoas()
    p.menu_contexto(a)
    medidas = p.js("""() => { const m = [...document.querySelectorAll('.x-menu')].find(x => x.offsetWidth && x.querySelector('.barraTarefasMenuTitulo'));
        if (!m) return null;
        const t = m.querySelector('.barraTarefasMenuTitulo'), txt = m.querySelector('.x-menu-item-text');
        const icones = [...m.querySelectorAll('img.dbt-ico')];
        const r = e => e.getBoundingClientRect();
        return {
            recuoTitulo: r(t).left + parseFloat(getComputedStyle(t).paddingLeft), textoItem: r(txt).left,
            icones: icones.length, semImagem: icones.filter(i => { const cs = getComputedStyle(i); return !/url[(]/.test(cs.webkitMaskImage || cs.maskImage || ''); }).length,
            desalinhados: icones.filter(i => { const a = i.closest('a').querySelector('.x-menu-item-text');
                return Math.abs((r(i).top + r(i).height / 2) - (r(a).top + r(a).height / 2)) > 3; }).length,
            menu: [r(m).top, r(m).bottom, r(m).left, r(m).right, innerWidth, innerHeight]
        } }""")
    verificar(medidas is not None, "menu de contexto não abriu")
    verificar(abs(medidas["recuoTitulo"] - medidas["textoItem"]) <= 2, f"título desalinhado: {medidas['recuoTitulo']:.0f} vs {medidas['textoItem']:.0f}")
    verificar(medidas["icones"] >= 5 and medidas["semImagem"] == 0, f"ícones faltando ({medidas})")
    verificar(medidas["desalinhados"] == 0, f"{medidas['desalinhados']} ícones desalinhados com o texto")
    t, b, l, r, w, h = medidas["menu"]
    verificar(t >= 0 and b <= h and l >= 0 and r <= w, "menu de contexto sai da tela")
    p.tela(a).locator("body").click(position={"x": 600, "y": 300})
    p.esperar(400)
    verificar(not p.js("() => [...document.querySelectorAll('.x-menu')].some(m => m.offsetWidth && m.querySelector('.barraTarefasMenuTitulo') && getComputedStyle(m).visibility !== 'hidden')"),
              "o menu continuou aberto depois do clique dentro da tela")


@teste("Arrastar e redimensionar rápido, soltando o mouse sobre outra janela, funciona")
def arrastar_redimensionar(p):
    p.preparar()
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    w, h = p.page.viewport_size["width"], p.page.viewport_size["height"]
    p.restaurar_tamanho(a, int(w * 0.45), int(h * 0.45))
    p.restaurar_tamanho(b, 20, 80)
    p.botao(b).click()
    p.esperar(300)
    # Redimensionar rápido pelo canto inferior direito, soltando sobre a outra janela
    inicial = p.posicao(b)
    caixa = p.page.locator(f"#{b}").bounding_box()
    cx, cy = caixa["x"] + caixa["width"] - 2, caixa["y"] + caixa["height"] - 2
    p.page.mouse.move(cx, cy)
    p.page.mouse.down()
    p.mover_mouse_humano(cx, cy, cx - 150, cy - 80)
    p.page.mouse.up()
    p.esperar(600)
    menor = p.posicao(b)
    verificar(menor[2] <= inicial[2] - 120 and menor[3] <= inicial[3] - 60, f"redimensionar rápido não funcionou: {inicial[2:]} -> {menor[2:]}")
    # Arrastar rápido pelo título, soltando sobre a outra janela
    antes = p.posicao(b)
    cab = p.page.locator(f"#{b} .x-window-header").bounding_box()
    x, y = cab["x"] + 120, cab["y"] + 8
    p.page.mouse.move(x, y)
    p.page.mouse.down()
    p.mover_mouse_humano(x, y, x + 200, y + 120)
    p.page.mouse.up()
    p.esperar(600)
    depois = p.posicao(b)
    verificar(depois[0] > -1000, f"a janela sumiu depois do arrasto rápido (posição {depois[:2]})")
    verificar(abs((depois[0] - antes[0]) - 200) <= 25 and abs((depois[1] - antes[1]) - 120) <= 25, f"não moveu certo: {antes[:2]} -> {depois[:2]}")
    verificar(p.js("() => !document.body.classList.contains('barraTarefasArrastando')"), "iframes continuaram sem receber o mouse")


@teste("Botão 'Início' tem a aparência dos botões do portal e volta a tela para a página inicial")
def voltar_inicio(p):
    p.preparar()
    a = p.abrir_pessoas()
    tela = p.tela(a)
    tela.locator("#vPESSOA_CODIGO").fill("1")
    tela.locator("#IMGREFRESH").click()
    tela.locator("#vUPDATE_0001").wait_for(timeout=15000)
    tela.locator("#vUPDATE_0001").click()  # abre o cadastro (não salva nada)
    p.esperar_js(f"() => document.querySelector('#{a} iframe').contentWindow.location.href.includes('wp_pessoa.aspx')", 15000, "Modifica não abriu o cadastro")
    p.esperar_tela_carregada(a)
    ferramenta = p.js(f"""() => {{ const t = document.querySelector('#{a} .x-tool-dbt-inicio'), imp = document.querySelector('#{a} .x-tool-W5Portal_Icon_Print');
        const ct = getComputedStyle(t), ci = getComputedStyle(imp);
        return {{ visivel: t.offsetWidth > 0, fundo: ct.backgroundImage, fundoImprimir: ci.backgroundImage,
                  icone: getComputedStyle(t, '::before').content, alturaIgual: Math.abs(t.offsetHeight - imp.offsetHeight) <= 2 }} }}""")
    verificar(ferramenta["visivel"], "botão Início não está visível")
    verificar(ferramenta["icone"] not in ("none", "normal", '""'), "botão Início sem ícone")
    if ferramenta["fundoImprimir"] != "none":
        verificar(ferramenta["fundo"] == ferramenta["fundoImprimir"], "botão Início sem o mesmo fundo do botão Imprimir")
    verificar(ferramenta["alturaIgual"], "botão Início com tamanho diferente do botão Imprimir")
    p.page.locator(f"#{a} .x-tool-dbt-inicio").click()
    p.esperar_js(f"() => document.querySelector('#{a} iframe').contentWindow.location.href.includes('wp_pessoaconsulta.aspx')", 15000, "não voltou para wp_pessoaconsulta.aspx")


@teste("Indicador de carregamento aparece durante a consulta e o ✔ quando termina em segundo plano", so_chromium=True)
def indicador_carregamento(p):
    p.preparar()
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    p.botao(a).click()
    p.esperar(300)
    p.latencia(2500)
    try:
        p.tela(a).locator("#IMGREFRESH").click(no_wait_after=True)
        p.esperar(700)
        verificar("carregando" in p.classes_botao(a), "indicador de carregamento não apareceu")
        p.page.keyboard.press("Alt+KeyE")
        p.esperar(300)
        verificar(p.ativa() == b, "não trocou de janela durante a consulta")
        p.esperar_js(f"() => document.querySelector('#barraDeTarefas button[data-window-id=\"{a}\"]').classList.contains('concluido')",
                     10000, "o ✔ de concluído não apareceu")
        verificar("carregando" not in p.classes_botao(a), "indicador continuou depois de terminar")
    finally:
        p.latencia(0)
    p.botao(a).click()
    p.esperar(300)
    verificar("concluido" not in p.classes_botao(a), "o ✔ não sumiu ao voltar para a janela")


@teste("Configurações: cabem na tela, gravam atalho, avisam conflito, aplicam altura e persistem")
def configuracoes(p):
    p.preparar()
    p.abrir_pessoas()
    p.menu_engrenagem("Configurações...")
    p.verificar_na_tela(".x-window.barraTarefasJanela", "janela de configurações")
    salvar = p.page.get_by_role("button", name="Salvar")
    verificar(salvar.is_visible(), "botão Salvar não está visível")
    cfg = p.page.locator(".barraTarefasConfig")
    # Cada aba cabe na janela, e a janela na tela
    for aba in ("barra", "telas", "fluxos", "atalhos", "privacidade", "sobre"):
        p.aba_config(aba)
        p.verificar_na_tela(".x-window.barraTarefasJanela", f"janela de configurações (aba {aba})")
        verificar(salvar.is_visible(), f"botão Salvar não está visível na aba {aba}")
    # Aba Café: QR code do Pix carregado e o "copia e cola" com o código (CRC conferido pelo gerar_pix.py)
    p.aba_config("sobre")
    sobre = cfg.locator('[data-painel="sobre"]').inner_text()
    versao_tema = p.js("() => window.DealerTema ? DealerTema.versao : null")
    verificar(re.search(r"Versão \d+\.\d+\.\d+", sobre) and (not versao_tema or f"Dealer/Tema {versao_tema}" in sobre),
              f"a aba Sobre não mostra as versões: {sobre[:120]!r}")
    verificar("Igor Lima" in sobre and "igor.lima@grupogr7.com.br" in sobre and "Doações" in sobre and "bloqueado" in sobre,
              "a aba Sobre está sem autor, contato ou o texto das doações")
    verificar(p.js("() => { const i = document.querySelector('.dbtPixQr'); return i.complete && i.naturalWidth > 0; }"),
              "o QR code do Pix não carregou")
    pix = cfg.locator(".dbtPixCodigo").input_value()
    verificar(pix.startswith("000201") and "BR.GOV.BCB.PIX" in pix and pix[-8:-4] == "6304", f"código Pix estranho: {pix!r}")
    p.aba_config("atalhos")
    cfg.locator('input.dbtAtalho[data-acao="fechar"]').click()
    p.page.keyboard.press("KeyQ")
    verificar("Ctrl ou Alt" in cfg.locator('input.dbtAtalho[data-acao="fechar"]').input_value(), "aceitou atalho sem Ctrl/Alt")
    p.page.keyboard.press("Escape")
    cfg.locator('input.dbtAtalho[data-acao="duplicar"]').click()
    p.page.keyboard.press("Alt+KeyQ")          # o mesmo da janela da esquerda
    salvar.click()
    p.esperar(500)
    verificar(p.page.locator(".x-window-dlg").is_visible(), "não avisou o atalho repetido")
    p.page.locator(".x-window-dlg").get_by_role("button").first.click()
    cfg.locator('[data-limpar="duplicar"]').click()
    cfg.locator('input.dbtAtalho[data-acao="proxima"]').click()
    p.page.keyboard.press("Alt+Shift+KeyL")
    altura_antes = p.js("() => oW5Portal.statusbar.getHeight()")
    p.aba_config("barra")
    cfg.locator('input[name="alturaBarra"]').fill("40")
    salvar.click()
    p.esperar(600)
    verificar(p.js("() => oW5Portal.statusbar.getHeight()") == altura_antes + 8, "altura da barra não foi aplicada")
    salvo = p.config_salva()
    verificar(salvo.get("atalhos", {}).get("proxima") == "Alt+Shift+KeyL" and salvo.get("alturaBarra") == 40, "configuração não foi salva")
    p.verificar_na_tela("#W5-minimized-menu", "botão Minimizadas com a barra mais alta")
    # Persistência: recarrega sem mexer no localStorage
    p.page.reload(wait_until="domcontentloaded")
    if not p.args.extensao:
        p.instalar_script()
    p.esperar_js("() => window.__dealerFluxoCarregado", 20000)
    p.esperar(1500)
    b = p.abrir_pessoas()
    c = p.abrir_pesquisas()
    p.botao(b).click()
    p.page.keyboard.press("Alt+Shift+KeyL")
    p.esperar(500)
    verificar(p.ativa() == c, "atalho gravado não funciona depois de recarregar")
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    p.page.get_by_role("button", name="Restaurar padrões").click()
    p.esperar(400)
    p.page.locator(".x-window-dlg").get_by_role("button").first.click()  # Sim/Yes
    p.esperar(500)
    verificar(p.config_salva().get("atalhos", {}).get("proxima") == "Alt+KeyE", "Restaurar padrões não funcionou")


@teste("Aparência dos botões: estilos prontos, prévia e barra na hora, Cancelar volta, Salvar grava, círculo com iniciais")
def aparencia_botoes(p):
    p.preparar()
    a = p.abrir_pessoas()
    p.abrir_pesquisas()
    classes = lambda sel: p.js(f"() => [...document.querySelector('{sel}').classList].filter(c => /^dbt[featnh]-/.test(c)).sort()")
    padrao = ["dbta-cor", "dbte-solido", "dbtf-reto", "dbth-nenhum", "dbtn-nenhum"]
    verificar(classes("#barraDeTarefas") == padrao, f"classes iniciais da barra: {classes('#barraDeTarefas')}")
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    cfg = p.page.locator(".barraTarefasConfig")
    verificar(cfg.locator('select[name="botaoPronto"]').input_value() == "classico", "o padrão não aparece como Clássico")
    cfg.locator('select[name="botaoPronto"]').select_option("setas")
    p.esperar(300)
    setas = ["dbta-cor", "dbte-brilhante", "dbtf-divisa", "dbth-reflexo", "dbtn-deslizar"]
    verificar(classes("#barraDeTarefas") == setas, f"a barra não mudou na hora: {classes('#barraDeTarefas')}")
    verificar(classes(".dbtPreviaBarra") == setas, "a prévia não mudou")
    verificar(cfg.locator('select[name="botaoFormato"]').input_value() == "divisa", "o estilo pronto não preencheu o formato")
    cfg.locator('select[name="botaoAtivo"]').select_option("pulsar")
    p.esperar(200)
    verificar(cfg.locator('select[name="botaoPronto"]').input_value() == "", "mudar um campo não virou Personalizado")
    # Clicar num botão da prévia o torna o ativo
    cfg.locator(".dbtPreviaBarra button").nth(1).click()
    verificar(p.js("() => document.querySelectorAll('.dbtPreviaBarra button')[1].classList.contains('ativo')"), "a prévia não trocou o ativo")
    p.page.get_by_role("button", name="Cancelar").click()
    p.esperar(500)
    verificar(classes("#barraDeTarefas") == padrao, f"Cancelar não voltou a aparência: {classes('#barraDeTarefas')}")
    # Salvar: círculo com as iniciais
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    cfg.locator('select[name="botaoFormato"]').select_option("circulo")
    cfg.locator('select[name="botaoEstilo"]').select_option("vidro")
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    salvo = p.config_salva()
    verificar(salvo.get("botaoFormato") == "circulo" and salvo.get("botaoEstilo") == "vidro", f"não salvou: {salvo}")
    verificar("dbtf-circulo" in classes("#barraDeTarefas"), "a barra não ficou com o formato salvo")
    ini = p.js(f"() => document.querySelector('#barraDeTarefas button[data-window-id=\"{a}\"]').dataset.iniciais")
    verificar(ini == "PE", f"iniciais de Pessoas: {ini!r}")
    largura = p.js(f"() => document.querySelector('#barraDeTarefas button[data-window-id=\"{a}\"]').offsetWidth")
    verificar(largura < 40, f"o botão em círculo está largo demais: {largura}px")
    # Doca (enfeite) só nos formatos que encaixam nela; aba pendurada na linha de cima da barra de status
    def forma(f):
        p.js(f"""() => {{ const c = document.getElementById('barraDeTarefas');
            [...c.classList].filter(x => x.startsWith('dbtf-')).forEach(x => c.classList.remove(x)); c.classList.add('dbtf-{f}'); }}""")
        p.esperar(200)
    doca = lambda: p.js("() => { const d = getComputedStyle(document.getElementById('barraDeTarefas'), '::before'); return d.content !== 'none' && parseFloat(d.width) > 0; }")
    for f, tem in (("divisa", True), ("inclinado", True), ("etiqueta", True), ("pontas", True), ("reto", False), ("seta", False), ("aba", False)):
        forma(f)
        verificar(doca() == tem, f"formato {f}: doca {'faltando' if tem else 'sobrando'}")
    forma("aba")
    topos = p.js(f"""() => [oW5Portal.statusbar.getEl().dom.getBoundingClientRect().top,
        document.querySelector('#barraDeTarefas button[data-window-id="{a}"]').getBoundingClientRect().top]""")
    verificar(0 <= topos[1] - topos[0] <= 1.5, f"a aba não está pendurada na linha de cima da barra de status (barra {topos[0]}, aba {topos[1]})")
    forma("circulo")
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    p.page.get_by_role("button", name="Restaurar padrões").click()
    p.esperar(400)
    p.page.locator(".x-window-dlg").get_by_role("button").first.click()
    p.esperar(500)
    verificar(classes("#barraDeTarefas") == padrao, "Restaurar padrões não voltou a aparência")


@teste("Notificação de fluxos: tutorial, lista, filtro, desmarcar, personalizado e salvar; tudo cabe na tela")
def config_fluxos(p):
    p.preparar(config={"tutoriaisOcultos": {"boasVindas": True, "privacidade": True}})
    p.menu_engrenagem("Notificação de fluxos...")
    p.esperar_js("() => !!document.querySelector('.barraTarefasTutorial')", 5000, "tutorial de fluxos não apareceu")
    p.verificar_na_tela(".x-window.barraTarefasJanela:has(.barraTarefasTutorial)", "tutorial de fluxos")
    p.page.locator("#dbtNaoMostrar_fluxos").check()
    p.page.get_by_role("button", name="Entendi").click()
    p.esperar(400)
    p.verificar_na_tela(".x-window.barraTarefasJanela", "janela de notificação de fluxos")
    verificar(p.page.get_by_role("button", name="Salvar").is_visible(), "botão Salvar não está visível")
    cfg = p.page.locator(".barraTarefasConfig")
    verificar(cfg.locator('.dbtAba.ativa[data-aba="fluxos"]').count() == 1, "o menu do sino não abriu a aba de notificação de fluxos")
    # Som: o botão Testar toca o som escolhido (dois tons no padrão), trocar o som já toca o novo, e o volume
    # acima de 100% mostra o aviso de risco
    p.js("""() => { window.__sons = []; window.__picos = [];
        const orig = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function () { window.__sons.push(this.state); return orig.call(this); };
        const rampa = AudioParam.prototype.exponentialRampToValueAtTime;
        AudioParam.prototype.exponentialRampToValueAtTime = function (v, t) { if (v > 0.001) window.__picos.push(v); return rampa.call(this, v, t); }; }""")
    limpar_sons = lambda: p.js("() => { window.__sons = []; window.__picos = []; }")
    cfg.locator(".dbtTestarSom").click()
    # O primeiro som espera o áudio do navegador acordar (na máquina do GitHub, com o som virtual, demora mais)
    p.esperar_condicao(lambda: len(p.js("() => window.__sons")) >= 2, 5000)
    p.esperar(300)
    verificar(len(p.js("() => window.__sons")) == 2, f"o botão Testar não tocou o som: {p.js('() => window.__sons')}")
    verificar(cfg.locator(".dbtAvisoVolume").is_hidden(), "o aviso de volume alto aparece com 100%")
    limpar_sons()
    cfg.locator('select[name="somTipo"]').select_option("tres")
    p.esperar(600)
    verificar(len(p.js("() => window.__sons")) == 3, f"trocar o som não tocou as três notas: {p.js('() => window.__sons')}")
    verificar(cfg.locator('select[name="somTipo"] option').count() >= 6, "poucas opções de som")
    cfg.locator('input[name="volume"]').fill("150")
    verificar(cfg.locator(".dbtAvisoVolume").is_visible() and "audição" in cfg.locator(".dbtAvisoVolume").inner_text(),
              "volume acima de 100% não mostrou o aviso de risco")
    verificar("150%" in cfg.locator(".dbtVolumeValor").inner_text(), "o valor do volume não aparece")
    limpar_sons()
    cfg.locator(".dbtTestarSom").click()
    p.esperar(600)
    picos = p.js("() => window.__picos")
    verificar(picos and abs(max(picos) - 0.9) < 0.001, f"volume de 150% não aumentou o som (picos {picos})")
    cfg.locator('input[name="som"]').check()
    total = cfg.locator(".dbtListaFluxos label").count()     # a lista de fluxos fica na mesma aba
    verificar(total >= 260, f"lista de fluxos com só {total} itens")
    cfg.locator(".dbtFiltroLista").fill("agendamento")
    visiveis = cfg.locator(".dbtListaFluxos label:visible").count()
    verificar(0 < visiveis < 20, f"filtro mostrou {visiveis} fluxos")
    cfg.get_by_role("button", name="Desmarcar todos").click()
    verificar(f"{total - visiveis} de {total}" in cfg.locator(".dbtContagem").inner_text(), "Desmarcar todos não agiu só nos filtrados")
    cfg.locator(".dbtNovoPersonalizado").fill("FLX_TesteAutomatico")
    cfg.get_by_role("button", name="Adicionar").click()
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    salvo = p.config_salva()
    verificar(salvo["fluxos"]["som"] is True, "a opção de som não foi salva")
    verificar(salvo["fluxos"]["somTipo"] == "tres" and salvo["fluxos"]["volume"] == 150,
              f"som/volume não foram salvos: {salvo['fluxos'].get('somTipo')}, {salvo['fluxos'].get('volume')}")
    verificar(len(salvo["fluxos"]["desativados"]) == visiveis, "fluxos desmarcados não foram salvos")
    verificar(salvo["fluxos"]["personalizados"] == ["FLX_TesteAutomatico"], "fluxo personalizado não foi salvo")
    verificar(salvo["tutoriaisOcultos"].get("fluxos") is True, "'Não mostrar novamente' do tutorial não foi salvo")
    p.menu_engrenagem("Notificação de fluxos...")
    verificar(not p.js("() => !!document.querySelector('.barraTarefasTutorial')"), "tutorial apareceu de novo")
    p.page.get_by_role("button", name="Cancelar").click()


@teste("Avisos de fluxos: só avisa fluxos novos (não tarefas, nem troca de filtro); aviso cabe na tela; som só para fluxos novos")
def avisos_fluxos(p):
    p.preparar(config={"fluxos": {"notificarAoAbrir": True, "som": True}})
    # Conta os sons tocados (cada som = 2 tons) e se o navegador deixou o áudio tocar
    p.js("""() => { window.__sons = []; const orig = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function () { window.__sons.push(this.state); return orig.call(this); }; }""")
    p.esperar_js("() => (window.__avisos || []).length > 0", 15000, "não avisou os fluxos pendentes ao abrir")
    verificar(p.avisos() == ["Fluxos pendentes"], f"avisos ao abrir: {p.avisos()}")
    p.esperar(800)  # animação de entrada
    p.verificar_na_tela(".barraTarefasNotificacao", "aviso de fluxos")
    # No canto superior direito, logo abaixo da barra do alto
    alto = p.caixa(".x-toolbar:has(table.minimizeAll)")
    aviso = p.caixa(".barraTarefasNotificacao")
    largura_tela = p.js("() => window.innerWidth")
    verificar(alto["bottom"] + 55 <= aviso["top"] <= alto["bottom"] + 90,
              f"aviso deveria ficar abaixo da barra do alto, do título das janelas e do botão 'Aviso' das telas (topo {aviso['top']:.0f}px)")
    verificar(abs(aviso["right"] - largura_tela) <= 2, "aviso não está encostado na direita")
    inicial = len(p.avisos())
    # Marcar um fluxo mostra as tarefas dele ("Confirmar (76)"...): não pode virar aviso
    p.caixa_entrada().locator('[id*="IMGFLUXO_0001"]').click()
    p.esperar(7000)
    tarefas = p.frame_caixa_entrada().evaluate("() => document.querySelectorAll('span[id*=\"TAREFA_NOME_\"]').length")
    p.desmarcar_fluxos()
    verificar(len(p.avisos()) == inicial, f"marcar um fluxo gerou aviso ({tarefas} tarefas na tela): {p.avisos()}")
    # Visualizar Todos os Fluxos esvazia a lista; desmarcar volta tudo: não pode avisar
    p.caixa_entrada().locator('[id$="IMGMOSTRAFLUXO"]').click()
    p.esperar(12000)
    p.caixa_entrada().locator('[id$="IMGMOSTRAFLUXO"]').click()
    p.esperar(12000)
    verificar(len(p.avisos()) == inicial, f"marcar/desmarcar 'Visualizar Todos os Fluxos' gerou aviso: {p.avisos()}")
    # Aumento de verdade (simulado só neste navegador): um aviso, sino vermelho até abrir o menu
    p.simular_aumento(p.primeiro_fluxo(), 2)
    p.esperar(6500)
    verificar(p.avisos()[inicial:] == ["Novos fluxos"], f"aumento deveria gerar 1 aviso 'Novos fluxos': {p.avisos()[inicial:]}")
    sons = p.js("() => window.__sons")
    verificar(len(sons) == 2 and all(s == "running" for s in sons),
              f"deveria tocar 1 som (2 tons, áudio liberado) só no aumento, não ao abrir/marcar fluxo: {sons}")
    verificar(p.js("() => document.getElementById('barraTarefasBotaoFluxos').classList.contains('dbt-novidade')"), "sino não ficou destacado")
    p.page.locator("#barraTarefasBotaoFluxos").click()
    p.esperar(400)
    verificar(not p.js("() => document.getElementById('barraTarefasBotaoFluxos').classList.contains('dbt-novidade')"), "sino continuou destacado depois de abrir o menu")
    p.js("() => Ext.menu.MenuMgr.hideAll()")


@teste("Aviso: X e contagem regressiva; pausa com o mouse; clicar ao lado do texto só fecha, no texto abre o fluxo, botão do meio só fecha")
def aviso_interacao(p):
    p.preparar(config={"fluxos": {"notificarAoAbrir": True, "tempoNotificacao": 30, "pausarAoPassarMouse": True}})
    p.esperar_js("() => document.querySelector('.barraTarefasNotificacao.visivel')", 20000, "o aviso não apareceu")
    p.esperar(800)
    p.verificar_na_tela(".barraTarefasNotificacao .dbtFechar", "X do aviso")
    tempo = lambda: int(re.search(r"(\d+)s", p.page.locator(".barraTarefasNotificacao .dbtTempo").inner_text()).group(1))
    t1 = tempo()
    verificar(25 <= t1 <= 30, f"contagem deveria começar perto de 30s: {t1}s")
    p.esperar(2200)
    t2 = tempo()
    verificar(t2 < t1, f"contagem não diminuiu ({t1}s -> {t2}s)")
    # Mouse em cima, no espaço em branco à direita do primeiro fluxo: pausa
    texto = p.page.locator(".barraTarefasNotificacao .dbtLinhaFluxo").first.bounding_box()
    linha = p.page.locator(".barraTarefasNotificacao .dbtLinhas > div").first.bounding_box()
    verificar(texto["width"] < linha["width"] - 40, "o link do fluxo ocupa a linha inteira (deveria ser só o texto)")
    x, y = texto["x"] + texto["width"] + 25, texto["y"] + texto["height"] / 2
    p.page.mouse.move(x, y)
    p.esperar(300)
    t3 = tempo()
    p.esperar(2200)
    verificar(tempo() == t3, "a contagem não pausou com o mouse em cima")
    verificar(p.page.locator(".barraTarefasNotificacao .dbtTempo .fa-pause").count() == 1, "não mostra que está pausado")
    # Clicar ao lado do texto fecha sem abrir/marcar fluxo
    p.page.mouse.click(x, y)
    p.esperar(1500)
    verificar(p.page.locator(".barraTarefasNotificacao").count() == 0, "clicar no espaço em branco não fechou o aviso")
    verificar(p.fluxos_marcados() == [], f"clicar no espaço em branco marcou um fluxo: {p.fluxos_marcados()}")
    # X fecha
    p.preparar(config={"fluxos": {"notificarAoAbrir": True, "tempoNotificacao": 30}})
    p.esperar_js("() => document.querySelector('.barraTarefasNotificacao.visivel')", 20000, "o aviso não apareceu (2a vez)")
    p.esperar(800)
    p.page.locator(".barraTarefasNotificacao .dbtFechar").click()
    p.esperar(1000)
    verificar(p.page.locator(".barraTarefasNotificacao").count() == 0, "o X não fechou o aviso")
    verificar(p.fluxos_marcados() == [], "o X marcou um fluxo")
    # Clicar no texto de um fluxo abre o fluxo (marca na Caixa de Entrada)
    p.preparar(config={"fluxos": {"notificarAoAbrir": True, "tempoNotificacao": 30}})
    p.esperar_js("() => document.querySelector('.barraTarefasNotificacao.visivel')", 20000, "o aviso não apareceu (3a vez)")
    p.esperar(800)
    p.page.locator(".barraTarefasNotificacao .dbtLinhaFluxo").first.click()
    p.esperar_condicao(lambda: len(p.fluxos_marcados()) == 1, 20000)
    marcados = p.fluxos_marcados()
    p.desmarcar_fluxos()
    verificar(len(marcados) == 1, f"clicar no texto do fluxo deveria marcar 1 fluxo: {marcados}")
    # Clique do meio em cima do texto de um fluxo só fecha (não abre o fluxo)
    p.preparar(config={"fluxos": {"notificarAoAbrir": True, "tempoNotificacao": 30}})
    p.esperar_js("() => document.querySelector('.barraTarefasNotificacao.visivel')", 20000, "o aviso não apareceu (4a vez)")
    p.esperar(800)
    p.page.locator(".barraTarefasNotificacao .dbtLinhaFluxo").first.click(button="middle")
    p.esperar(1500)
    verificar(p.page.locator(".barraTarefasNotificacao").count() == 0, "o clique do meio no fluxo não fechou o aviso")
    p.esperar(3000)
    marcados = p.fluxos_marcados()
    if marcados:
        p.desmarcar_fluxos()
    verificar(marcados == [], f"o clique do meio abriu o fluxo: {marcados}")


@teste("Avisos das telas: cartão no meio com 'Copiar erro' e 'Fechar' à direita, clicar fecha, vai para a pílula 'Aviso' depois de 3 s (configurável), opção para desligar")
def aviso_tela(p):
    p.preparar()
    a = p.abrir_pessoas()
    p.esperar(1500)
    frame = p.page.frame_locator(f"#{a} iframe")
    tela = lambda codigo, arg=None: p.page.evaluate(
        f"([id, arg]) => {{ const doc = document.querySelector('#' + id + ' iframe').contentDocument; return ({codigo})(doc, arg); }}", [a, arg])
    verificar(tela("(doc) => !!doc.getElementById('gxErrorViewer')"), "a tela não tem o #gxErrorViewer")
    # A área de transferência de verdade precisa de permissão; aqui guardamos o texto copiado
    tela("(doc) => { const w = doc.defaultView; w.__copiado = null; try { Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { w.__copiado = t; return Promise.resolve(); } } }); } catch (e) {} }")
    afastar = lambda: p.page.mouse.move(5, 300)   # mouse em cima do cartão pausa o tempo
    # Mensagem como o GeneXus escreve (só na cópia da página deste navegador)
    MSG = "Atenção!! Aviso de teste do Dealer/Fluxo."
    MSG2 = "Segunda mensagem de teste."
    escrever = "(doc, msgs) => { doc.getElementById('gxErrorViewer').innerHTML = (msgs || []).map(m => '<div>' + m + '</div>').join(''); }"
    afastar()
    tela(escrever, [MSG])
    p.esperar(700)
    cartao = frame.locator("#dnf-aviso.dnf-visivel")
    verificar(cartao.count() == 1 and MSG in cartao.inner_text(), "o cartão do aviso não apareceu no meio da tela")
    caixa = cartao.bounding_box()
    janela = p.caixa(f"#{a} iframe")
    meio = (janela["left"] + janela["right"]) / 2
    verificar(abs(caixa["x"] + caixa["width"] / 2 - meio) < 30, "o cartão não está centralizado na tela")
    verificar(tela("(doc) => getComputedStyle(doc.querySelector('#gxErrorViewer > div')).borderLeftWidth") == "3px",
              "a mensagem original não ganhou o visual de alerta")
    # Copiar erro: copia o texto e não fecha o cartão
    copiar = frame.locator("#dnf-aviso .dnf-copiar")
    verificar(copiar.inner_text() == "Copiar erro", f"botão de copiar com texto errado: {copiar.inner_text()!r}")
    copiar.click()
    p.esperar(300)
    copiado = p.page.evaluate(f"() => document.querySelector('#{a} iframe').contentWindow.__copiado")
    verificar(copiado == MSG, f"'Copiar erro' copiou {copiado!r}")
    verificar(copiar.inner_text() == "Copiado!", "o botão não mostrou 'Copiado!'")
    verificar(cartao.count() == 1, "clicar em 'Copiar erro' fechou o cartão")
    # Com o mouse em cima, não some; ao sair, vai para a pílula depois de 3 s (padrão)
    p.esperar(3500)
    verificar(cartao.count() == 1, "o cartão sumiu com o mouse em cima dele")
    afastar()
    p.esperar(2500)
    verificar(cartao.count() == 1, "o cartão sumiu antes dos 3 s")
    p.esperar(1300)
    verificar(frame.locator("#dnf-aviso.dnf-visivel").count() == 0, "o cartão não sumiu depois de 3 s")
    pilula = frame.locator("#dnf-aviso-pilula.dnf-visivel")
    verificar(pilula.count() == 1 and pilula.inner_text().strip() == "Aviso", f"a pílula 'Aviso' não apareceu: {pilula.all_inner_texts()}")
    pilula.click()
    p.esperar(600)
    verificar(frame.locator("#dnf-aviso.dnf-visivel").count() == 1, "clicar na pílula não mostrou o cartão de novo")
    caixa_msgs = frame.locator("#dnf-aviso .dnf-msgs").bounding_box()
    caixa_botoes = frame.locator("#dnf-aviso .dnf-acoes").bounding_box()
    verificar(caixa_botoes["x"] >= caixa_msgs["x"] + caixa_msgs["width"] - 1, "os botões não estão à direita do texto")
    # Botão Fechar: vai para a pílula
    frame.locator("#dnf-aviso .dnf-fechar").click()
    p.esperar(700)
    verificar(frame.locator("#dnf-aviso.dnf-visivel").count() == 0, "o botão Fechar não fechou")
    verificar(pilula.count() == 1, "depois de Fechar a pílula não apareceu")
    pilula.click()
    p.esperar(600)
    # Clicar no cartão também fecha na hora
    frame.locator("#dnf-aviso .dnf-msgs").click()
    p.esperar(700)
    verificar(frame.locator("#dnf-aviso.dnf-visivel").count() == 0, "clicar no cartão não fechou")
    verificar(pilula.count() == 1, "depois de clicar no cartão a pílula não apareceu")
    afastar()
    # Duas mensagens: "Copiar erros" copia as duas
    tela(escrever, [MSG, MSG2])
    p.esperar(700)
    verificar(cartao.count() == 1 and copiar.inner_text() == "Copiar erros", "com duas mensagens o botão deveria ser 'Copiar erros'")
    copiar.click()
    p.esperar(300)
    copiado = p.page.evaluate(f"() => document.querySelector('#{a} iframe').contentWindow.__copiado")
    verificar(copiado == MSG + "\n" + MSG2, f"'Copiar erros' copiou {copiado!r}")
    # Mensagem apagada: some tudo
    tela(escrever, [])
    p.esperar(700)
    verificar(frame.locator("#dnf-aviso, #dnf-aviso-pilula").count() == 0, "o aviso não sumiu quando a mensagem foi apagada")
    # Tempo configurável: 1 s
    p.menu_engrenagem("Configurações...")
    p.aba_config("telas")
    p.page.locator('.barraTarefasConfig input[name="avisosTelaSegundos"]').fill("1")
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    verificar(p.config_salva().get("avisosTelaSegundos") == 1, f"o tempo não foi salvo: {p.config_salva().get('avisosTelaSegundos')}")
    afastar()
    tela(escrever, [MSG])
    p.esperar(700)
    verificar(cartao.count() == 1, "o cartão não apareceu (tempo de 1 s)")
    p.esperar(1200)
    verificar(cartao.count() == 0 and pilula.count() == 1, "com 1 s o cartão não foi para a pílula")
    tela(escrever, [])
    p.esperar(500)
    # Desligado nas configurações: nada aparece e a mensagem fica com o visual original
    p.menu_engrenagem("Configurações...")
    p.aba_config("telas")
    p.page.locator('.barraTarefasConfig input[name="avisosTela"]').uncheck()
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    verificar(p.config_salva().get("avisosTela") is False, "a opção não foi salva")
    tela(escrever, [MSG])
    p.esperar(900)
    verificar(frame.locator("#dnf-aviso").count() == 0, "o cartão apareceu com a opção desligada")
    verificar(tela("(doc) => getComputedStyle(doc.querySelector('#gxErrorViewer > div')).borderLeftWidth") != "3px",
              "a mensagem original continuou destacada com a opção desligada")


@teste("Busca nas listas: lista própria igual à do navegador (digitar o começo, letra repetida, Tab, setas, Esc); Alt+F e a barra do alto passam para a busca (com erros de digitação); botão colado à seta; listas curtas e opção desligada ficam com a do navegador")
def busca_listas(p):
    p.preparar()
    a = p.abrir_pessoas()
    p.esperar(1000)
    frame = p.page.frame_locator(f"#{a} iframe")
    # Duas listas como as do GeneXus (só na cópia da página deste navegador): uma longa e uma com 5 opções, e um
    # campo de texto
    opcoes = ["", "Aceita Venda Direta", "Bloqueia Faturamento", "Calcula ICMS ST", "Flag de Integração Stellantis",
              "Habilita Nota Fiscal Eletrônica"] + [f"Parâmetro {i}" for i in range(30)]
    p.page.evaluate("""([id, opcoes]) => { const doc = document.querySelector('#' + id + ' iframe').contentDocument;
        const criar = (idLista, textos) => { const s = doc.createElement('select'); s.id = idLista;
            s.setAttribute('onchange', 'window.__mudou = (window.__mudou || 0) + 1');
            textos.forEach((t, i) => s.add(new Option(t, String(i)))); return s; };
        const caixa = doc.createElement('div'); caixa.style.cssText = 'position:fixed;left:20px;top:60px;z-index:99999';
        const texto = doc.createElement('input'); texto.id = 'dnfTesteTexto';
        caixa.append(criar('dnfTesteLonga', opcoes), criar('dnfTesteCurta', ['a', 'b', 'c', 'd', 'e']), texto);
        doc.body.appendChild(caixa); }""", [a, opcoes])
    mudou = lambda: p.page.evaluate(f"() => document.querySelector('#{a} iframe').contentWindow.__mudou || 0")
    ativo = lambda: p.page.evaluate(f"() => document.querySelector('#{a} iframe').contentDocument.activeElement.id")
    longa, painel, lupa = frame.locator("#dnfTesteLonga"), frame.locator("#dnf-busca"), frame.locator("#dnf-lupa")
    marcada = lambda: painel.locator("li.dnf-marcada").inner_text().strip()
    campo = painel.locator("input")
    afastar = lambda: p.page.mouse.move(900, 600)
    janelas = p.js("() => oW5Portal.windows.length")

    # Clique: a nossa lista, como a do navegador (sem campo de busca, foco na própria lista)
    longa.click()
    p.esperar(300)
    verificar(painel.count() == 1 and "dnf-modo-lista" in painel.get_attribute("class"), "clicar na lista longa não abriu a lista própria")
    verificar(not campo.is_visible() and painel.locator(".dnf-barra-busca").is_visible(), "a lista própria deveria ter a barra 'Buscar na lista', sem campo")
    verificar(painel.locator("li").count() == 36 and ativo() == "dnfTesteLonga", "a lista própria não tem todas as opções ou tirou o foco da lista")
    # "pp" = a segunda opção que começa com P; Tab escolhe e vai para o próximo campo
    p.page.keyboard.type("pp", delay=80)
    verificar(marcada() == "Parâmetro 1", f"'pp' deveria marcar a segunda opção com P, marcou {marcada()!r}")
    p.page.keyboard.press("Tab")
    p.esperar(300)
    verificar(longa.input_value() == "7" and mudou() == 1, f"Tab não escolheu a opção marcada (valor {longa.input_value()}, change {mudou()})")
    verificar(painel.count() == 0 and ativo() == "dnfTesteCurta", f"Tab não fechou a lista e passou para o próximo campo (foco em {ativo()!r})")
    # Pelo teclado (Alt+Seta para baixo), digitar o começo ("Bl") e Enter
    longa.focus()
    p.esperar(1200)
    p.page.keyboard.press("Alt+ArrowDown")
    p.esperar(200)
    verificar(painel.count() == 1, "Alt+Seta para baixo não abriu a lista própria")
    p.page.keyboard.type("Bl", delay=80)
    verificar(marcada() == "Bloqueia Faturamento", f"digitar 'Bl' marcou {marcada()!r}")
    p.page.keyboard.press("Enter")
    p.esperar(200)
    verificar(longa.input_value() == "2" and painel.count() == 0 and ativo() == "dnfTesteLonga", "Enter não escolheu ou tirou o foco da lista")
    # Setas, Home/End e Esc (fecha sem mudar e sem fechar a janela do portal)
    p.page.keyboard.press("F4")
    p.esperar(200)
    p.page.keyboard.press("End")
    verificar(marcada() == "Parâmetro 29", "End não foi para a última opção")
    p.page.keyboard.press("ArrowUp")
    verificar(marcada() == "Parâmetro 28", "Seta para cima não subiu uma opção")
    p.page.keyboard.press("Escape")
    p.esperar(200)
    verificar(painel.count() == 0 and longa.input_value() == "2" and p.js("() => oW5Portal.windows.length") == janelas,
              "Esc não fechou só a lista, sem mudar a opção")
    # Com a lista própria aberta, Alt+F passa para a busca (com erros de digitação)
    longa.click()
    p.esperar(200)
    p.page.keyboard.press("Alt+KeyF")
    p.esperar(200)
    verificar("dnf-modo-busca" in painel.get_attribute("class") and campo.is_visible() and ativo() != "dnfTesteLonga",
              "Alt+F com a lista aberta não passou para a busca")
    verificar("36 opções" in painel.locator(".dnf-rodape").inner_text(), "o rodapé não mostra o total de opções")
    p.page.keyboard.type("flga stelantis")   # dois erros de digitação
    p.esperar(200)
    verificar(painel.locator("li").all_inner_texts() == ["Flag de Integração Stellantis"],
              f"a busca não filtrou com erros de digitação: {painel.locator('li').all_inner_texts()}")
    p.page.keyboard.press("Enter")
    p.esperar(300)
    verificar(longa.input_value() == "4" and painel.count() == 0, "Enter não escolheu a opção da busca")
    # A barra "Buscar na lista" também passa para a busca; clique numa opção filtrada
    longa.click()
    p.esperar(200)
    painel.locator(".dnf-barra-busca").click()
    p.esperar(200)
    verificar(campo.is_visible(), "clicar em 'Buscar na lista' não mostrou o campo de busca")
    p.page.keyboard.type("nota eletronica")
    p.esperar(200)
    painel.locator("li", has_text="Eletrônica").click()
    verificar(longa.input_value() == "5", "clicar na opção filtrada não a escolheu")
    # Segundo clique na lista fecha
    longa.click()
    p.esperar(200)
    longa.click()
    p.esperar(200)
    verificar(painel.count() == 0, "o segundo clique na lista não fechou a lista própria")
    # Botão colado à seta, com a altura da lista, e abre direto na busca
    verificar(lupa.count() == 1 and lupa.is_visible(), "o botão de busca não aparece com a lista em foco")
    cl, cb = longa.bounding_box(), lupa.bounding_box()
    verificar(abs((cb["x"] + cb["width"]) - (cl["x"] + cl["width"] - 1 - 18)) <= 2 and abs(cb["height"] - (cl["height"] - 2)) <= 1,
              f"o botão não está colado à seta com a altura da lista (lista {cl}, botão {cb})")
    lupa.click()
    p.esperar(300)
    verificar(painel.count() == 1 and campo.is_visible(), "o botão não abriu a busca")
    p.page.keyboard.press("Escape")
    p.esperar(200)
    verificar(painel.count() == 0 and lupa.count() == 1, "Esc na busca não fechou ou o botão não voltou")
    # Alt+F com a lista fechada e em foco
    p.page.keyboard.press("Alt+KeyF")
    p.esperar(200)
    verificar(campo.is_visible(), "Alt+F com a lista fechada não abriu a busca")
    p.page.keyboard.press("Escape")
    # Alt+F fora de uma lista não faz nada; o botão some ao sair e aparece com o mouse em cima
    frame.locator("#dnfTesteTexto").click()
    afastar()
    p.esperar(800)
    verificar(lupa.count() == 0, "o botão não sumiu ao sair da lista")
    p.page.keyboard.press("Alt+KeyF")
    p.esperar(200)
    verificar(painel.count() == 0, "Alt+F fora de uma lista abriu a busca")
    longa.hover()
    p.esperar(200)
    verificar(lupa.count() == 1, "o botão não apareceu com o mouse em cima da lista")
    afastar()
    p.esperar(600)
    # Lista com até 5 opções: a do navegador, sem botão
    frame.locator("#dnfTesteCurta").click()
    p.esperar(300)
    verificar(painel.count() == 0 and lupa.count() == 0, "lista com só 5 opções ganhou a lista própria ou o botão")
    p.page.keyboard.press("Escape")
    # Desligada nas configurações: tudo como no navegador
    p.menu_engrenagem("Configurações...")
    p.aba_config("telas")
    p.page.locator('.barraTarefasConfig input[name="buscaListas"]').uncheck()
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    verificar(p.config_salva().get("buscaListas") is False, "a opção não foi salva")
    longa.click()
    p.esperar(300)
    verificar(painel.count() == 0 and lupa.count() == 0, "com a opção desligada apareceu a lista própria ou o botão")
    p.page.keyboard.press("Escape")
    longa.focus()
    p.page.keyboard.press("Alt+KeyF")
    p.esperar(300)
    verificar(painel.count() == 0, "Alt+F abriu a busca com a opção desligada")


@teste("Configurações: busca (edita direto no resultado), Tutoriais e ícones nas abas; fluxos desligados só em instalação nova; aviso sem links")
def config_busca(p):
    pg = p.page
    def recarregar(cfg):
        if cfg is None:
            p.js(f"() => localStorage.removeItem('{CHAVE_CONFIG}')")
        else:
            p.js("([c, v]) => localStorage.setItem(c, v)", [CHAVE_CONFIG, json.dumps(cfg)])
        pg.reload(wait_until="domcontentloaded")
        esperar_portal(pg)
        if not p.args.extensao:
            p.instalar_script()
        p.esperar_js("() => window.__dealerFluxoCarregado && document.getElementById('barraTarefasBotaoStatus')", 20000)
        p.esperar(1500)
        for _ in range(3):                   # boas-vindas e, um segundo depois de fechar, o aviso de estatísticas
            p.js("() => Ext.WindowMgr.each(w => { if (w.el && w.el.hasClass('barraTarefasJanela')) w.close(); })")
            p.esperar(1300)
    def fluxos_ligados():
        p.menu_engrenagem("Configurações...")
        p.aba_config("fluxos")
        p.esperar(400)
        if pg.get_by_role("button", name="Entendi").is_visible():     # tutorial dos fluxos (instalação nova)
            pg.get_by_role("button", name="Entendi").click()
            p.esperar(400)
        ligado = pg.locator('.barraTarefasConfig [data-painel="fluxos"] input[name="ativo"]').is_checked()
        pg.get_by_role("button", name="Cancelar").click()
        p.esperar(400)
        return ligado
    ocultos = {"boasVindas": True, "fluxos": True, "privacidade": True}
    # Instalação nova: notificação de fluxos desligada (a engrenagem continua com "Notificação de fluxos...")
    p.preparar()
    recarregar(None)
    verificar(not fluxos_ligados(), "a notificação de fluxos veio ligada numa instalação nova")
    pg.locator("#barraTarefasBotaoStatus").click()
    p.esperar(300)
    verificar(p.item_menu("Notificação de fluxos...").is_visible(), "a engrenagem não tem mais 'Notificação de fluxos...'")
    p.js("() => Ext.menu.MenuMgr.hideAll()")
    # Instalação antiga que nunca mexeu na notificação: continua ligada; quem desligou continua desligado
    recarregar({"tutoriaisOcultos": ocultos, "fluxos": {"som": False}})
    verificar(fluxos_ligados(), "a notificação foi desligada numa instalação que já existia")
    recarregar({"tutoriaisOcultos": ocultos, "fluxos": {"ativo": False}})
    verificar(not fluxos_ligados(), "a notificação desligada pelo usuário foi religada")

    # Busca nas configurações
    p.preparar()
    p.menu_engrenagem("Configurações...")
    cfg = pg.locator(".barraTarefasConfig")
    icones = p.js("""() => [...document.querySelectorAll('.barraTarefasConfig .dbtAba')].map(a => {
        const i = a.querySelector('.dbtAbaIco'); return !!i && getComputedStyle(i).webkitMaskImage !== 'none'; })""")
    verificar(icones and all(icones), f"abas sem ícone: {icones}")
    busca = cfg.locator(".dbtCampoBuscaConfig")
    busca.fill("volume")
    p.esperar(300)
    visiveis = p.js("""() => [...document.querySelectorAll('.barraTarefasConfig .dbtAbaPainel')]
        .filter(x => x.offsetParent).map(x => x.dataset.painel)""")
    verificar(visiveis == ["fluxos"], f"buscar 'volume' mostrou as abas {visiveis}")
    volume = cfg.locator('input[name="volume"]')
    verificar(volume.is_visible(), "o campo do volume não aparece no resultado")
    verificar(not cfg.locator('input[name="intervaloAtualizacao"]').is_visible(), "linhas que não batem continuam visíveis")
    volume.fill("40")
    busca.fill("xyzzy")
    p.esperar(200)
    verificar(cfg.locator(".dbtSemResultado").is_visible(), "busca sem resultado não avisou")
    busca.fill("atalhos")                    # o nome da aba: a aba inteira
    p.esperar(200)
    verificar(cfg.locator('[data-painel="atalhos"] input.dbtAtalho').count() >= 9 and
              cfg.locator('[data-painel="atalhos"] input.dbtAtalho[data-acao="fechar"]').is_visible(), "buscar o nome da aba não mostrou a aba")
    busca.fill("som volume")                 # o nome do grupo (Som) conta junto com o da linha
    p.esperar(200)
    verificar(volume.is_visible() and not cfg.locator('input[name="som"]').is_visible(),
              "'som volume' não achou só a linha do volume (no grupo Som)")
    busca.fill("BOTAO MEIO")                 # maiúsculas e sem acento
    p.esperar(200)
    verificar(cfg.locator('input[name="botaoMeioFecha"]').is_visible(), "a busca diferencia maiúsculas/acentos")
    busca.press("Escape")
    p.esperar(200)
    verificar(busca.input_value() == "" and "dbtBuscando" not in (cfg.get_attribute("class") or ""), "Esc não limpou a busca")
    verificar(cfg.locator(".x-window") .count() == 0 and pg.locator(".x-window.barraTarefasJanela").is_visible(), "Esc fechou a janela")
    busca.fill("som")
    cfg.locator('.dbtAba[data-aba="barra"]').click()  # clicar numa aba sai da busca
    p.esperar(200)
    verificar(busca.input_value() == "" and cfg.locator('[data-painel="barra"]').is_visible() and
              not cfg.locator('[data-painel="fluxos"]').is_visible(), "clicar numa aba não saiu da busca")
    pg.get_by_role("button", name="Salvar").click()
    p.esperar(600)
    verificar(p.config_salva()["fluxos"]["volume"] == 40, "o campo mudado no resultado da busca não foi salvo")

    # Tutoriais
    p.menu_engrenagem("Configurações...")
    pg.get_by_role("button", name="Tutoriais").click()
    p.esperar(400)
    for item, titulo in (("Boas-vindas e aviso", "Bem-vindo"), ("Notificação de fluxos", "notificação de fluxos"),
                         ("Estatísticas de uso (privacidade)", "Estatísticas")):
        if not p.item_menu(item).is_visible():
            pg.get_by_role("button", name="Tutoriais").click()
            p.esperar(400)
        p.item_menu(item).click()
        p.esperar(600)
        janela = pg.locator(".x-window.barraTarefasJanela", has=pg.locator(".barraTarefasTutorial")).last
        verificar(janela.is_visible() and titulo in janela.locator(".x-window-header-text").inner_text(), f"o tutorial '{item}' não abriu")
        janela.get_by_role("button").last.click()
        p.esperar(500)
    verificar(pg.locator(".x-window.barraTarefasJanela .barraTarefasConfig").is_visible(), "fechar o tutorial fechou as configurações")
    pg.get_by_role("button", name="Cancelar").click()
    p.esperar(400)

    # Aviso de fluxos sem links: clicar na linha do fluxo só fecha
    p.preparar(config={"fluxos": {"ativo": True, "notificarAoAbrir": True, "linksAviso": False}})
    # Na máquina do GitHub a Caixa de Entrada demora mais para carregar
    p.esperar_js("() => !!document.querySelector('.barraTarefasNotificacao.visivel')", 45000, "o aviso de fluxos não apareceu")
    p.esperar(600)
    aviso = pg.locator(".barraTarefasNotificacao.visivel")
    verificar(aviso.locator(".dbtLinhaFluxo, [data-chave], .dbtAcoes").count() == 0, "o aviso tem links com a opção desligada")
    aviso.locator(".dbtLinhas > div").first.click()
    p.esperar(700)
    verificar(pg.locator(".barraTarefasNotificacao.visivel").count() == 0, "clicar no aviso não fechou")
    verificar(not p.fluxos_marcados(), "clicar no aviso sem links abriu o fluxo")


@teste("Impressão da OS: documentos marcados abrem em janelas (sem baixar); duplicar e reabrir; desligado, baixa como antes (só com DN_OS_TESTE=<número da OS>)")
def documentos_os(p):
    numero = os.environ.get("DN_OS_TESTE")
    if not numero:
        print("         (pulado: defina DN_OS_TESTE com uma OS que tenha 2 documentos na impressão; o teste manda imprimir)")
        return
    pg = p.page
    p.preparar()
    downloads = []
    pg.on("download", lambda d: downloads.append(d))
    def quadro(trecho, timeout=20):
        fim = time.time() + timeout
        while time.time() < fim:
            for f in pg.frames:
                if trecho in f.url.lower():
                    return f
            p.esperar(300)
        raise Falha(f"a tela {trecho} não abriu")
    def documentos():
        return p.js("""() => oW5Portal.windows.filter(w => w.__dnfDocumento).map(w => [w.id, w.title,
            ((w.el.dom.querySelector('iframe') || {}).src || '').slice(0, 5)])""")
    def imprimir(marcar):
        j = p.abrir_menu("Oficina", "Ordem de Serviço/Orçamento")
        f = quadro("wp_oficinaconsulta")
        f.locator("#vCODIGO").fill(numero)
        f.locator("#vCODIGO").press("Tab")
        f.locator("#IMAGE1").click()
        p.esperar(4000)
        f.locator("#vUPDATEOS_0001").click()
        dados = quadro("wp_oficinadados")
        p.esperar(5000)
        pg.mouse.move(5, 400)              # o aviso da tela (se houver) vai para o botão "Aviso" e não cobre nada
        p.esperar(4000)
        for _ in range(3):                 # o GeneXus às vezes ignora o clique enquanto termina de montar a tela
            dados.locator("#BTNIMPRIMEOS").click()
            p.esperar(2500)
            if any("wp_osimpressao" in fr.url.lower() for fr in pg.frames):
                break
        f = quadro("wp_osimpressao")
        p.esperar(2500)
        opcao = f.locator("#dnfDocumentosOSOpcao input")
        verificar(opcao.count() == 1, "a caixa 'Abrir os documentos em janelas' não apareceu na impressão da OS")
        if opcao.is_checked() != marcar:
            opcao.click()
            p.esperar(300)
        f.locator("input[name=vSEL_0001]").check()
        f.locator("input[name=vSEL_0002]").check()
        f.locator("#IMGCONFIRMA").click()
        return j
    # Ligado: abre um documento por janela, com o PDF (blob), sem baixar nada
    imprimir(True)
    p.esperar_condicao(lambda: len(documentos()) >= 2 and all(d[2] == "blob:" for d in documentos()), 30000)
    docs = documentos()
    verificar(len(docs) == 2 and all(d[2] == "blob:" for d in docs) and all(f"OS {numero}" in d[1] for d in docs),
              f"os documentos não abriram em janelas: {docs}")
    p.esperar(2000)
    verificar(not downloads, f"baixou com a opção ligada: {[d.suggested_filename for d in downloads]}")
    verificar(any("wp_osimpressao" in fr.url.lower() for fr in pg.frames), "a tela de impressão se perdeu depois de Imprimir")
    verificar(p.js("() => oW5Portal.windows.some(w => /^Impressão da OS/.test(w.title))"), "a janela do PDF da OS não abriu")
    # Duplicar, fechar e reabrir uma janela de documento (menu do botão na barra: no Firefox o visualizador de PDF
    # fica com o teclado, e os atalhos não chegam nele)
    primeiro = docs[0][0]
    p.menu_contexto(primeiro)
    p.item_menu("Duplicar").click()
    p.esperar(1500)
    verificar(len(documentos()) == 3, f"duplicar a janela do documento não funcionou: {documentos()}")
    copia = [d[0] for d in documentos() if d[0] not in (docs[0][0], docs[1][0])][0]
    p.menu_contexto(copia)
    p.item_menu("Fechar").click()
    p.esperar(800)
    verificar(len(documentos()) == 2, "fechar a janela do documento não funcionou")
    p.menu_contexto(primeiro)
    p.item_menu("Reabrir janela fechada").hover()
    p.esperar(600)
    pg.locator(".x-menu-item-text").filter(has_text="(Cópia)").locator("visible=true").first.click()
    p.esperar_condicao(lambda: len(documentos()) == 3 and all(d[2] == "blob:" for d in documentos()), 8000)
    verificar(len(documentos()) == 3 and all(d[2] == "blob:" for d in documentos()), f"reabrir a janela do documento não trouxe o PDF: {documentos()}")
    p.js("() => oW5Portal.closeAllWindows()")
    p.esperar(1500)
    # Desligado pela caixa da própria tela: nada abre sozinho e o link baixa como antes
    imprimir(False)
    p.esperar(12000)
    verificar(p.config_salva().get("documentosOSJanelas") is False, "a caixa da tela não desligou a opção")
    verificar(not documentos(), "com a opção desligada os documentos abriram em janelas")
    f = quadro("wp_osimpressao")
    f.evaluate("() => gx.evt.execEvt(\"E'BAIXARDOC'.\", document.querySelector('a[href*=BAIXARDOC]'))")
    p.esperar_condicao(lambda: len(downloads) > 0, 15000)
    verificar(downloads and downloads[0].suggested_filename.lower().endswith(".zip"), "com a opção desligada o link não baixou o ZIP")
    p.js("() => oW5Portal.closeAllWindows()")


@teste("Tema (alfa): desligado; caixa de aceite libera a aba e o menu Tema da engrenagem; muda na hora e Cancelar volta; aceite da depuração; aceite e menu da fonte; ícones e sino com tema; mantém ao recarregar")
def tema(p):
    p.preparar()
    verificar(p.js("() => !!window.DealerTema"), "o motor de temas (window.DealerTema) não carregou")
    verificar(p.js("() => DealerTema.config().tema") == "off", f"o tema não vem desligado: {p.js('() => DealerTema.config()')}")
    esquema = lambda: p.js("() => document.documentElement.getAttribute('data-dealer-tema-esquema')")
    verificar(esquema() is None, "a página abriu com tema")
    a = p.abrir_pessoas()
    esquema_tela = lambda j: p.js(f"() => document.querySelector('#{j} iframe').contentDocument.documentElement.getAttribute('data-dealer-tema-esquema')")
    def tem_no_menu(texto):
        p.esperar(300)
        p.page.locator("#barraTarefasBotaoStatus").click()
        p.esperar(400)
        tem = p.page.locator(".x-menu-item-text").filter(has_text=re.compile(f"^{texto}$")).locator("visible=true").count() > 0
        p.js("() => Ext.menu.MenuMgr.hideAll()")
        return tem
    tem_menu_tema = lambda: tem_no_menu("Tema")
    verificar(not tem_menu_tema(), "o menu Tema apareceu antes de aceitar o aviso de alfa")
    p.menu_engrenagem("Configurações...")
    p.aba_config("tema")
    cfg = p.page.locator(".barraTarefasConfig")
    lista = cfg.locator('select[name="temaEsquema"]')
    aceite = cfg.locator('input[name="temaAlfaAceito"]')
    p.verificar_na_tela(".x-window.barraTarefasJanela", "janela de configurações (aba Tema)")
    aviso_alfa = cfg.locator('.dbtAvisoAlfa:has(input[name="temaAlfaAceito"])')
    verificar(aviso_alfa.is_visible() and "alfa" in aviso_alfa.inner_text(), "sem o aviso de versão alfa na aba")
    aviso_fonte = cfg.locator('.dbtAvisoAlfa:has(input[name="temaFonteAceita"])')
    verificar("cortar" in aviso_fonte.inner_text(), "sem o aviso de texto cortado na fonte")
    verificar(not aceite.is_checked() and lista.is_disabled() and cfg.locator('select[name="temaFonte"]').is_disabled(),
              "a aba não está bloqueada antes do aceite")
    # Aceite libera; o tema muda na hora (antes de salvar), no portal e na tela aberta
    aceite.check()
    verificar(lista.is_enabled(), "marcar o aceite não liberou a lista de temas")
    lista.select_option("dracula")
    p.esperar(900)
    verificar(esquema() == "dracula" and esquema_tela(a) == "dracula", "o tema não mudou na hora ao escolher na lista")
    lista.select_option("nord")
    p.esperar(900)
    verificar(esquema() == "nord", "trocar de tema na lista não foi na hora")
    # Cancelar volta ao que estava, e o aceite não fica gravado
    p.page.get_by_role("button", name="Cancelar").click()
    p.esperar(800)
    verificar(esquema() is None and p.js("() => DealerTema.config().tema") == "off", "Cancelar não voltou ao tema de antes")
    verificar(not p.config_salva().get("temaAlfaAceito") and not tem_menu_tema(), "o aceite ficou gravado mesmo cancelando")
    # Aceitar e salvar: aparece o menu Tema na engrenagem
    p.menu_engrenagem("Configurações...")
    p.aba_config("tema")
    aceite.check()
    lista.select_option("dracula")
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(800)
    verificar(p.config_salva().get("temaAlfaAceito") is True, "o aceite do aviso de alfa não foi gravado")
    p.page.locator("#barraTarefasBotaoStatus").click()
    p.esperar(400)
    p.item_menu("Tema").hover()
    p.esperar(700)
    verificar(p.item_menu("Original (sem tema)").is_visible(), "o submenu Tema não abriu")
    p.item_menu("Nord").click()
    p.esperar(1000)
    verificar(esquema() == "nord" and esquema_tela(a) == "nord", "escolher Nord no menu da engrenagem não aplicou")
    # Com tema: o sino não ganha a seta do motor, e os ícones dos menus seguem as cores do tema
    seta = p.js("() => getComputedStyle(document.querySelector('#barraTarefasBotaoFluxos em'), '::after').content")
    verificar(seta in ("none", "normal"), f"o sino tem a seta do tema: {seta!r}")
    p.page.locator("#barraTarefasBotaoStatus").click()
    p.esperar(400)
    icone = p.js("""() => { const i = [...document.querySelectorAll('.x-menu-item-icon.dbt-ico')].find(e => e.offsetParent);
        const cs = getComputedStyle(i); return [cs.backgroundColor, cs.webkitMaskImage || cs.maskImage]; }""")
    fundo = p.js("() => getComputedStyle(document.querySelector('.x-menu')).backgroundColor")
    verificar("url(" in icone[1] and icone[0] != fundo, f"ícone do menu sem máscara ou da cor do fundo: {icone}, fundo {fundo}")
    p.js("() => Ext.menu.MenuMgr.hideAll()")
    # Depuração: bloqueada até marcar o aceite dela
    p.menu_engrenagem("Configurações...")
    p.aba_config("tema")
    ocultos = cfg.locator('input[name="temaOcultos"]')
    aceite_dep = cfg.locator('input[name="temaDepuracaoAceita"]')
    verificar(ocultos.is_disabled() and "desenvolvedores" in cfg.locator(".dbtAvisoDepuracao").inner_text(),
              "as opções de depuração não estão bloqueadas com o aviso")
    aceite_dep.check()
    verificar(ocultos.is_enabled(), "o aceite da depuração não liberou as opções")
    ocultos.check()
    p.esperar(500)
    verificar(p.js("() => DealerTema.config().ocultos") is True, "a opção de botões escondidos não valeu na hora")
    aceite_dep.uncheck()
    p.esperar(500)
    verificar(not ocultos.is_checked() and ocultos.is_disabled() and p.js("() => DealerTema.config().ocultos") is False,
              "desmarcar o aceite da depuração não desligou as opções")
    # Fonte e tamanho: outro aceite (fonte do sistema: sem download nos testes)
    fonte = cfg.locator('select[name="temaFonte"]')
    aceite_fonte = cfg.locator('input[name="temaFonteAceita"]')
    verificar(fonte.is_disabled() and not aceite_fonte.is_checked(), "fonte liberada sem o aceite dela")
    aceite_fonte.check()
    verificar(fonte.is_enabled(), "o aceite da fonte não liberou a lista")
    fonte.select_option("sistema")
    cfg.locator('select[name="temaTamanho"]').select_option("120")
    p.esperar(900)
    tamanho = lambda: p.js(f"() => getComputedStyle(document.querySelector('#{a} iframe').contentDocument.documentElement).fontSize")
    verificar(p.js("() => DealerTema.config().fonte") == "sistema" and tamanho() == "19.2px",
              f"fonte/tamanho não mudaram na hora (tamanho {tamanho()})")
    # Imagens sem ícone: abre e fecha
    cfg.locator("[data-tema-semicone]").click()
    p.esperar(500)
    verificar(p.page.locator("textarea.dbtSemIcone").is_visible(), "a lista de imagens sem ícone não abriu")
    p.page.locator(".x-window:has(textarea.dbtSemIcone)").get_by_role("button", name="Fechar").click()
    p.esperar(300)
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(800)
    verificar(p.config_salva().get("temaFonteAceita") is True, "o aceite da fonte não foi gravado")
    # Menu Fonte da engrenagem: tamanho na hora
    p.esperar(300)
    p.page.locator("#barraTarefasBotaoStatus").click()
    p.esperar(400)
    p.item_menu("Fonte").hover()
    p.esperar(700)
    p.item_menu("Tamanho do texto").hover()
    p.esperar(700)
    p.item_menu("110%").click()
    p.esperar(900)
    verificar(tamanho() == "17.6px", f"o tamanho escolhido no menu Fonte não valeu (tamanho {tamanho()})")
    # Recarregar mantém tema e tamanho
    p.page.reload(wait_until="domcontentloaded")
    if not p.args.extensao:
        p.instalar_script()
    p.esperar_js("() => window.__dealerFluxoCarregado && document.getElementById('barraTarefasBotaoStatus')", 20000, "o Dealer/Fluxo não carregou de novo")
    verificar(esquema() == "nord", "o tema não ficou depois de recarregar")
    b = p.abrir_pessoas()
    verificar(esquema_tela(b) == "nord", "tela aberta depois de recarregar veio sem o tema")
    verificar(p.js(f"() => getComputedStyle(document.querySelector('#{b} iframe').contentDocument.documentElement).fontSize") == "17.6px",
              "o tamanho do texto não ficou depois de recarregar")
    # Desmarcar os aceites volta ao original na hora (cada um o seu) e tira os menus
    p.menu_engrenagem("Configurações...")
    p.aba_config("tema")
    aceite.uncheck()
    p.esperar(900)
    c = p.js("() => DealerTema.config()")
    verificar(esquema() is None and lista.is_disabled() and c["tamanho"] == 110, f"desmarcar o aceite de alfa não voltou só o tema: {c}")
    aceite_fonte.uncheck()
    p.esperar(900)
    c = p.js("() => DealerTema.config()")
    verificar(c["fonte"] == "original" and c["tamanho"] == 100 and fonte.is_disabled(), f"desmarcar o aceite da fonte não voltou ao original: {c}")
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(800)
    verificar(not p.config_salva().get("temaAlfaAceito") and not p.config_salva().get("temaFonteAceita"), "os aceites continuaram gravados")
    verificar(not tem_menu_tema() and not tem_no_menu("Fonte"), "os menus Tema/Fonte continuaram depois de desmarcar os aceites")


@teste("Relatório (Títulos Emitidos a Receber, ou Resumo da Agenda do CRM sem o menu Financeiro): indicador enquanto o relatório é gerado e ✔ ao terminar em segundo plano")
def relatorio(p):
    p.preparar()
    # Financeiro > ... > Títulos Emitidos a Receber; sem o menu Financeiro (conta de testes), CRM > Relatórios >
    # Resumo da Agenda, que funciona igual (data inicial, Gerar, o relatório abre em outra janela)
    financeiro = p.page.get_by_role("button", name="Financeiro").count() > 0
    outra = p.abrir_pessoas()
    rel = p.abrir_relatorio_titulos() if financeiro else p.abrir_menu("CRM", "Relatórios", "Resumo da Agenda")
    tela = p.tela(rel)
    # Período longo + "Não Recebidos": o servidor leva alguns segundos para gerar (só consulta, nada é gravado)
    campo = tela.locator("#vDATAINICIO")
    campo.click()
    campo.press("Control+a")
    campo.type("01012026", delay=50)
    campo.press("Tab")
    p.esperar(1500)
    if financeiro:
        radio = tela.locator('input[type=radio][name="vOPCAOTITULOPAGO"][value="2"]')
        for _ in range(3):  # a tela se redesenha depois da data; repete se o clique se perder
            radio.click()
            p.esperar(1200)
            if radio.is_checked():
                break
        verificar(radio.is_checked(), "não conseguiu marcar 'Não Recebidos'")
    antes = p.js("() => oW5Portal.windows.length")
    p.latencia(1500)  # garante alguns segundos de geração mesmo se o servidor estiver rápido
    try:
        tela.locator("#BTNGERAR").click()
        p.esperar_js(f"() => oW5Portal.windows.length > {antes}", 20000, "a janela com o relatório não abriu")
        janela = p.js("() => oW5Portal.windows[oW5Portal.windows.length - 1].id")
        p.esperar_js(f"() => document.querySelector('#barraDeTarefas button[data-window-id=\"{janela}\"]')?.classList.contains('carregando')",
                     4000, "o indicador não apareceu enquanto o relatório é gerado")
        p.botao(outra).click()
        p.esperar(300)
        verificar("carregando" in p.classes_botao(janela), "indicador sumiu antes do relatório chegar")
        p.esperar_js(f"() => document.querySelector('#barraDeTarefas button[data-window-id=\"{janela}\"]').classList.contains('concluido')",
                     90000, "o ✔ de concluído não apareceu quando o relatório terminou")
    finally:
        p.latencia(0)
    verificar(p.js(f"""() => !!document.querySelector('#{janela} iframe').contentDocument.querySelector('iframe')
        .contentWindow.location.href.includes('reportingservices')"""), "o relatório não carregou na janela")
    p.botao(janela).click()
    p.esperar(300)
    verificar("concluido" not in p.classes_botao(janela), "o ✔ não sumiu ao voltar para a janela do relatório")


@teste("Clicar num fluxo do sino mostra a Caixa de Entrada com o fluxo marcado (também a partir de Definições)")
def abrir_fluxo(p):
    p.preparar(config={"fluxos": {"notificarAoAbrir": False}})
    p.esperar(3000)
    nome = p.primeiro_fluxo()
    a = p.abrir_pessoas()
    p.page.locator("#barraTarefasBotaoFluxos").click()
    p.esperar(400)
    p.item_menu(nome, exato=False).click()
    p.esperar_condicao(lambda: len(p.fluxos_marcados()) == 1, 20000)
    p.esperar(500)
    verificar(p.js(f"() => Ext.getCmp('{a}').minimized") is True, "a janela aberta não foi minimizada")
    marcados = p.fluxos_marcados()
    visivel = p.fluxo_marcado_visivel()
    p.desmarcar_fluxos()
    verificar(len(marcados) == 1, f"deveria ter 1 fluxo marcado: {marcados}")
    verificar(visivel, "o fluxo marcado não está visível na Caixa de Entrada")
    definicoes = p.caixa_entrada().get_by_text("Definições", exact=True)
    if not definicoes.count() or not definicoes.first.is_visible():
        print("         (parte 2 pulada: este usuário não tem a aba Definições na Caixa de Entrada)")
        return
    definicoes.click()
    p.esperar(2500)
    p.page.locator("#barraTarefasBotaoFluxos").click()
    p.esperar(400)
    p.item_menu(nome, exato=False).click()
    p.esperar_condicao(lambda: len(p.fluxos_marcados()) == 1, 20000)
    p.esperar(500)
    marcados = p.fluxos_marcados()
    visivel = p.fluxo_marcado_visivel()
    p.desmarcar_fluxos()
    verificar(len(marcados) == 1, f"a partir de Definições, deveria ter 1 fluxo marcado: {marcados}")
    verificar(visivel, "a partir de Definições, a Caixa de Entrada não voltou a aparecer")


class ExtensaoChromium:
    """Usa a extensão como o usuário: popup e página de configurações (abertos em abas)."""
    def __init__(self, contexto):
        self.contexto = contexto
        self.sw = contexto.service_workers[0] if contexto.service_workers else contexto.wait_for_event("serviceworker", timeout=15000)
        self.id = self.sw.url.split("/")[2]
        self.paginas = []

    def _abrir(self, caminho):
        pg = self.contexto.new_page()
        self.paginas.append(pg)
        pg.goto(f"chrome-extension://{self.id}/{caminho}")
        return pg

    def aba(self, inicio_url):
        return self.sw.evaluate(f"async () => (await chrome.tabs.query({{}})).find(t => t.url.startsWith('{inicio_url}')).id")

    def ativar(self, aba):
        popup = self._abrir(f"popup.html?aba={aba}")
        popup.get_by_text("Esta é a página que abre depois do login").wait_for(timeout=10000)
        verificar(popup.locator("#sites li").count() == 1, "a lista deveria ter só o endereço padrão")
        popup.get_by_role("button", name="Ativar Dealer/Fluxo neste site").click()
        popup.get_by_text("está ativo neste site").wait_for(timeout=15000)
        verificar(popup.locator("#sites li").count() == 2, "o site ativado não apareceu na lista do popup")

    def registrados(self):
        return self.sw.evaluate("async () => (await chrome.scripting.getRegisteredContentScripts()).map(r => r.matches.find(m => m.includes('/Portal/')) || r.matches[0])")

    def remover(self, host):
        opcoes = self._abrir("opcoes.html")
        opcoes.locator("#sites li").nth(1).wait_for(timeout=5000)
        verificar(host in opcoes.locator("#sites li").nth(1).inner_text(), "o site não aparece nas configurações")
        opcoes.locator("button.remover").click()
        opcoes.get_by_text("Removido").wait_for(timeout=5000)
        verificar(opcoes.locator("#sites li").count() == 1, "o site continuou na lista depois de remover")

    def fundo(self, expressao):
        """Avalia uma expressão (pode usar await) no fundo da extensão."""
        return self.sw.evaluate(f"async () => {{ return ({expressao}); }}")

    def fechar(self):
        for pg in self.paginas:
            try:
                pg.close()
            except Exception:
                pass


class ExtensaoFirefox:
    """No Firefox o Playwright não abre as páginas moz-extension://: faz o que o popup e as configurações
    fazem chamando o fundo da extensão (as mesmas funções que eles chamam)."""
    def __init__(self, id_extensao):
        self.ext = firefox_rdp.Extensao(PORTA_RDP, id_extensao)

    def aba(self, inicio_url):
        return self.ext.avaliar(f"(await chrome.tabs.query({{}})).find(t => t.url.startsWith('{inicio_url}')).id")

    def ativar(self, aba):
        url = self.ext.avaliar(f"(await chrome.tabs.get({aba})).url")
        site = self.ext.avaliar(f"(u => ({{origem: `${{u.protocol}}//${{u.hostname}}/*`, padrao: `${{u.protocol}}//${{u.hostname}}${{u.pathname}}*`}}))(new URL({json.dumps(url)}))")
        self.ext.avaliar(f"chrome.storage.local.set({{pendente: {{...{json.dumps(site)}, aba: {aba}}}}})")
        verificar(self.ext.avaliar("concluirPendente()") is True, "o fundo da extensão não concluiu a ativação")

    def registrados(self):
        return self.ext.avaliar("(await chrome.scripting.getRegisteredContentScripts()).map(r => r.matches.find(m => m.includes('/Portal/')) || r.matches[0])")

    def remover(self, host):
        sites = self.ext.avaliar("(await chrome.storage.local.get('sites')).sites || []")
        verificar(len(sites) == 1 and host in sites[0]["padrao"], f"sites guardados: {sites}")
        self.ext.avaliar(f"removerSite({json.dumps(sites[0]['id'])})")
        verificar(self.ext.avaliar("(await chrome.storage.local.get('sites')).sites") == [], "o site continuou na lista depois de remover")

    def fundo(self, expressao):
        return self.ext.avaliar(expressao)

    def fechar(self):
        # Uma conexão de depuração aberta faz a próxima (outro teste) esperar para sempre pelo fundo da extensão
        try:
            self.ext.c.s.close()
        except Exception:
            pass


def extensao_do_teste(p):
    if p.args.navegador == "firefox":
        with open(os.path.join(EXTENSAO["firefox"], "manifest.json"), encoding="utf-8") as f:
            return ExtensaoFirefox(json.load(f)["browser_specific_settings"]["gecko"]["id"])
    return ExtensaoChromium(p.page.context)


class ServidorTelemetria:
    """Faz o papel do servidor da telemetria (a build de teste manda para cá) e guarda o que recebeu."""
    def __init__(self, porta):
        self.recebidos = []
        recebidos = self.recebidos

        class Tratador(http.server.BaseHTTPRequestHandler):
            def _cabecalhos(self, status):
                self.send_response(status)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_OPTIONS(self):
                self._cabecalhos(204)

            def do_POST(self):
                corpo = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    recebidos.append((self.path, json.loads(corpo)))
                except ValueError:
                    recebidos.append((self.path, corpo.decode("utf-8", "replace")))
                self._cabecalhos(204)

            def log_message(self, *args):
                pass

        self.servidor = http.server.ThreadingHTTPServer(("127.0.0.1", porta), Tratador)
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()

    def de(self, caminho):
        return [corpo for c, corpo in self.recebidos if c == caminho]

    def fechar(self):
        self.servidor.shutdown()
        self.servidor.server_close()


@teste("Telemetria: conta trocas de tema, envia só os campos combinados (sem usuário, empresa, endereços), não repete, "
       "prévia, imagens sem ícone (opt-in) uma vez, desligar para tudo", so_extensao=True)
def telemetria(p):
    p.preparar({"temaAlfaAceito": True})
    ext = extensao_do_teste(p)
    # O armazenamento da extensão dura o perfil inteiro: os testes anteriores também trocaram o tema
    ext.fundo("await chrome.storage.local.remove('telemetria')")
    p.preparar({"temaAlfaAceito": True})
    recebido = p.args.telemetria
    recebido.recebidos.clear()
    hoje = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).strftime("%Y-%m-%d")
    estado = lambda: ext.fundo("await globalThis.__telemetria.ler()")
    enviar = lambda: (ext.fundo("await globalThis.__telemetria.enviar(true)"), p.esperar(500))
    try:
        consentimento = ext.fundo("await (async () => { const d = (await chrome.permissions.getAll()).data_collection; return Array.isArray(d) ? d : null; })()")
        if consentimento is not None and "technicalAndInteraction" not in consentimento:
            # Firefox sem a permissão de dados (extensão temporária não passa pela tela de instalação, onde ela
            # vem marcada; o pedido só pode vir de um clique numa página da extensão): nada é guardado nem enviado,
            # e a aba Privacidade avisa. O caminho completo do envio é testado no Chromium.
            p.esperar(3000)
            p.page.locator("#barraTarefasBotaoStatus").click()
            p.esperar(400)
            p.item_menu("Tema").hover()
            p.esperar(700)
            p.item_menu("Nord").click()
            p.esperar(2500)
            enviar()
            verificar(estado()["dias"] == {} and recebido.recebidos == [], f"guardou/enviou sem a permissão do Firefox: {estado()} {recebido.recebidos}")
            p.menu_engrenagem("Configurações...")
            p.aba_config("privacidade")
            p.esperar_js("() => /Firefox não está permitindo/.test(document.querySelector('.dbtSituacaoTelemetria').textContent)", 5000,
                         "a aba Privacidade não avisou que o Firefox não permite o envio")
            p.page.get_by_role("button", name="Cancelar").click()
            return
        p.esperar_condicao(lambda: hoje in estado()["dias"], 8000)
        verificar(hoje in estado()["dias"], f"o estado do dia não chegou ao fundo da extensão: {estado()}")
        # Troca de tema pelo menu da engrenagem: conta uma vez
        p.esperar(300)
        p.page.locator("#barraTarefasBotaoStatus").click()
        p.esperar(400)
        p.item_menu("Tema").hover()
        p.esperar(700)
        p.item_menu("Nord").click()
        p.esperar(2500)
        dia = estado()["dias"][hoje]
        verificar(dia["contadores"].get("temaMenu") == 1 and dia["dados"].get("tema") == "nord", f"contagem/estado: {dia}")
        # Envio (os testes incluem o dia de hoje; de verdade só dias que já terminaram)
        enviar()
        pings = recebido.de("/ping")
        verificar(len(pings) == 1, f"pings recebidos: {pings}")
        ping = pings[0]
        verificar(set(ping) == {"dia", "versao", "navegador", "dados"} and ping["dia"] == hoje, f"ping: {ping}")
        permitidos = {"sistema", "tela", "dominio", "alturaBarra", "tema", "fonte", "tamanho", "imagens", "versaoTema", "uso"}
        verificar(set(ping["dados"]) <= permitidos, f"campos fora da lista: {set(ping['dados']) - permitidos}")
        verificar(ping["dados"]["tema"] == "nord" and ping["dados"]["uso"] == {"temaMenu": 1} and ping["dados"]["dominio"] == "padrao",
                  f"dados do ping: {ping['dados']}")
        texto = json.dumps(ping, ensure_ascii=False).lower()
        empresa = re.sub(r"^https?://([^./]+).*$", r"\1", p.args.url).lower()   # o subdomínio do portal (nome da empresa)
        for proibido in (p.args.usuario.lower(), empresa, "dealernetworkflow", ".aspx", "http"):
            verificar(proibido not in texto, f"o ping contém {proibido!r}: {ping}")
        enviar()
        verificar(len(recebido.de("/ping")) == 1, "o mesmo dia foi enviado de novo")
        # Prévia na aba Privacidade
        p.menu_engrenagem("Configurações...")
        p.aba_config("privacidade")
        p.page.locator("[data-telemetria-previa]").click()
        p.esperar_js("() => !!document.querySelector('.x-window textarea.dbtSemIcone')", 6000, "a prévia não abriu")
        verificar('"navegador"' in p.page.locator(".x-window textarea.dbtSemIcone").input_value(), "a prévia não mostra o ping")
        p.page.locator(".x-window:has(textarea.dbtSemIcone)").get_by_role("button", name="Fechar").click()
        p.esperar(300)
        # Imagens sem ícone (opt-in, na aba Tema): uma imagem de teste que o tema não conhece
        p.js("""() => localStorage.setItem('DealerTema.semIcone', JSON.stringify({
            'btntestedealerfluxo.png': ['btnTesteDealerFluxo.png', 'Teste do Dealer/Fluxo', 'teste.aspx', 'rótulo deduzido'] }))""")
        p.aba_config("tema")
        p.page.locator('.barraTarefasConfig input[name="telemetriaSemIcone"]').check()
        firefox = ext.fundo("await (async () => { const d = (await chrome.permissions.getAll()).data_collection; return Array.isArray(d) && !d.includes('websiteContent'); })()")
        if firefox:
            verificar("Firefox" in p.page.locator(".dbtSemIconeFirefox").inner_text(), "sem o aviso de permissão do Firefox para as imagens")
        p.page.get_by_role("button", name="Salvar").click()
        p.esperar(2500)
        enviar()
        relatos = recebido.de("/semicone")
        if firefox:
            verificar(relatos == [], "enviou as imagens sem a permissão do Firefox")
        else:
            verificar(len(relatos) == 1 and relatos[0]["itens"] == [["btnTesteDealerFluxo.png", "Teste do Dealer/Fluxo", "teste.aspx", "rótulo deduzido"]],
                      f"imagens sem ícone enviadas: {relatos}")
            verificar(set(relatos[0]) == {"versao", "versaoTema", "itens"}, f"campos do relato: {relatos[0]}")
            p.js("() => DealerTema.definir({ tema: 'dracula' })")   # muda o estado: a lista vai de novo ao fundo
            p.esperar(2500)
            enviar()
            verificar(len(recebido.de("/semicone")) == 1, "a mesma imagem foi enviada de novo")
        # Desligar: apaga o que não foi enviado e não conta nem envia mais nada
        p.menu_engrenagem("Configurações...")
        p.aba_config("privacidade")
        p.page.locator('.barraTarefasConfig input[name="telemetria"]').uncheck()
        p.page.get_by_role("button", name="Salvar").click()
        p.esperar(2500)
        verificar(estado()["dias"] == {} and not estado()["ativo"], f"desligar não apagou os dados pendentes: {estado()}")
        antes = len(recebido.recebidos)
        p.js("() => DealerTema.definir({ tema: 'nord' })")
        p.esperar(2500)
        enviar()
        verificar(len(recebido.recebidos) == antes, f"enviou depois de desligar: {recebido.recebidos[antes:]}")
    finally:
        p.js("() => { localStorage.removeItem('DealerTema.semIcone'); DealerTema.definir({ tema: 'off' }); }")
        ext.fechar()


@teste("Extensão em portal de outro endereço: ativar pelo botão da extensão, usar a barra, remover nas configurações",
       so_extensao=True)
def outro_dominio(p):
    contexto = p.page.context
    if p.args.navegador == "firefox":
        with open(os.path.join(EXTENSAO["firefox"], "manifest.json"), encoding="utf-8") as f:
            ext = ExtensaoFirefox(json.load(f)["browser_specific_settings"]["gecko"]["id"])
    else:
        ext = ExtensaoChromium(contexto)
    base = f"http://{HOST_PROXY}:{PORTA_PROXY}"
    portal = contexto.new_page()
    try:
        # Login no "outro portal" (o mesmo servidor, visto por um proxy local em outro endereço)
        fazer_login(portal, base, p.args.usuario, p.args.senha)
        esperar_portal(portal)
        portal.wait_for_timeout(3000)
        verificar(not portal.evaluate("() => !!document.getElementById('barraTarefasBotaoStatus')"),
                  "o Dealer/Fluxo rodou num endereço que não foi ativado")

        ext.ativar(ext.aba(base + "/Portal/"))
        portal.wait_for_function("() => !!document.getElementById('barraTarefasBotaoStatus')", timeout=40000)
        registrados = ext.registrados()
        # dois por site: o tema (document_start) e o Dealer/Fluxo
        # três por site: o tema (document_start), a ponte da telemetria e o Dealer/Fluxo
        verificar(registrados == [f"http://{HOST_PROXY}/Portal/default.html*"] * 3, f"scripts registrados: {registrados}")

        # Endereço novo = configurações novas: o aviso de boas-vindas aparece; fecha como um usuário
        portal.locator(".barraTarefasTutorial").wait_for(timeout=10000)
        portal.get_by_role("button", name="Entendi").click()
        # ... e depois dele, o aviso das estatísticas de uso
        portal.locator("#dbtAvisoTelemetria").wait_for(timeout=10000)
        portal.get_by_role("button", name="OK").click()
        portal.wait_for_timeout(800)

        # A barra funciona de verdade nesse endereço
        antes = portal.evaluate("() => oW5Portal.windows.length")
        portal.get_by_role("button", name="Cadastro").first.click()
        portal.wait_for_timeout(600)
        portal.locator(".x-menu-item-text").filter(has_text=re.compile("^Pessoas$")).locator("visible=true").first.click()
        portal.wait_for_function(f"() => oW5Portal.windows.length > {antes}", timeout=15000)
        portal.wait_for_timeout(1000)
        verificar(portal.locator("#barraDeTarefas button[data-window-id]").count() == 1, "a janela não apareceu na barra")

        ext.remover(HOST_PROXY)
        verificar(ext.registrados() == [], "o script continuou registrado depois de remover")
        portal.reload()
        esperar_portal(portal)
        portal.wait_for_timeout(3000)
        verificar(not portal.evaluate("() => !!document.getElementById('barraTarefasBotaoStatus')"),
                  "o Dealer/Fluxo continuou rodando depois de remover o site")
    finally:
        ext.fechar()
        try:
            portal.close()
        except Exception:
            pass
        p.page.bring_to_front()


# ---------------------------------------------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------------------------------------------

@teste("Tela de login (LoginAux.aspx): abre já com o tema escolhido, sem o Dealer/Fluxo", so_extensao=True)
def tema_login(p):
    # Último teste de propósito: abrir a tela de login pode encerrar a sessão do portal
    p.preparar()
    p.js("() => DealerTema.definir({ tema: 'dracula' })")
    login = p.page.context.new_page()
    try:
        login.goto(p.args.url.rstrip("/") + "/LoginAux.aspx?Windows", wait_until="domcontentloaded")
        try:
            login.wait_for_function("() => document.documentElement.getAttribute('data-dealer-tema-esquema') === 'dracula'", timeout=10000)
        except Exception:
            raise Falha("a tela de login abriu sem o tema")
        login.wait_for_load_state("load")
        login.wait_for_timeout(1500)
        verificar(login.evaluate("() => !window.__dealerFluxoCarregado && !document.getElementById('barraTarefasBotaoStatus')"),
                  "o Dealer/Fluxo rodou na tela de login")
        # Com usuário lembrado, o login mostra o nome e esconde o campo de usuário: só a senha fica visível
        verificar(login.locator("#vUSUARIOSENHA_SENHA").is_visible(), "a tela de login não mostrou o campo de senha")
    finally:
        login.close()
        p.js("() => DealerTema.definir({ tema: 'off' })")


# No GitHub Actions (CI=true) o que é impresso é editado antes: o registro dos testes fica guardado no GitHub
# (e é público se o repositório for público), e as mensagens de falha podem trazer dados do portal (endereço,
# usuário, textos e números das telas). Localmente sai tudo; DN_LOG_COMPLETO=1 desliga a edição no CI.
EDITAR_REGISTRO = os.environ.get("CI") == "true" and os.environ.get("DN_LOG_COMPLETO") != "1"


def editar_registro(texto):
    if not EDITAR_REGISTRO:
        return texto
    texto = str(texto)
    texto = re.split(r"\n\s*Call log:", texto)[0]                      # registro do Playwright (traz HTML da tela)
    url = os.environ.get("DN_URL", "")
    host = re.sub(r"^https?://([^/]+).*$", r"\1", url) if url else ""
    if host:
        texto = re.sub(re.escape(host), "[portal]", texto, flags=re.I)
        texto = re.sub(r"\b" + re.escape(host.split(".")[0]) + r"\b", "[empresa]", texto, flags=re.I)
    usuario = os.environ.get("DN_USUARIO", "")
    if usuario:
        texto = re.sub(re.escape(usuario), "[usuario]", texto, flags=re.I)
    texto = re.sub(r">[^<>]{2,}<", ">…<", texto)                         # textos dentro de HTML
    texto = re.sub(r"\d{5,}(?!\d)(?!\s*ms)", "#####", texto)                            # documentos, números de OS, telefones
    return texto


def executavel_chromium():
    # O Google Chrome de marca não aceita mais --load-extension; só o Chromium do sistema ou o do Playwright
    for caminho in ("/usr/sbin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"):
        if os.path.exists(caminho):
            return caminho
    return None  # usa o Chromium do Playwright


def rodar_em_tela(pw, args, tela, usuario, senha, selecionados, pasta):
    largura, altura = (int(x) for x in tela.lower().split("x"))
    perfil = tempfile.mkdtemp(prefix="dealerfluxo-teste-")
    extensao = EXTENSAO[args.navegador]
    if args.extensao and not os.path.exists(os.path.join(extensao, "manifest.json")):
        raise SystemExit("Rode python3 extensao/build.py antes de usar --extensao")
    opcoes = dict(headless=not args.mostrar, viewport={"width": largura, "height": altura})
    if args.navegador == "firefox":
        opcoes["firefox_user_prefs"] = PREFS_FIREFOX
        if args.extensao:
            opcoes["args"] = ["-start-debugger-server", str(PORTA_RDP)]
        contexto = pw.firefox.launch_persistent_context(perfil, **opcoes)
        if args.extensao:
            r = firefox_rdp.instalar_temporario(PORTA_RDP, extensao)
            verificar("addon" in r, f"o Firefox não instalou a extensão: {r}")
    else:
        opcoes["executable_path"] = executavel_chromium()
        if args.extensao:
            opcoes["args"] = [f"--disable-extensions-except={extensao}", f"--load-extension={extensao}"]
            if opcoes["headless"]:
                opcoes["args"].append("--headless=new")
                opcoes["headless"] = False
        contexto = pw.chromium.launch_persistent_context(perfil, **opcoes)
    proxy = proxy_portal.iniciar_em_segundo_plano(PORTA_PROXY, args.url) if args.extensao else None
    args.telemetria = ServidorTelemetria(PORTA_TELEMETRIA) if args.extensao else None
    resultados = []
    try:
        contexto.add_init_script(SCRIPT_INICIAL)
        page = contexto.pages[0] if contexto.pages else contexto.new_page()
        portal = Portal(page, args)
        args.usuario, args.senha = usuario, senha
        portal.login(usuario, senha)
        for nome, descricao, funcao in selecionados:
            inicio = time.time()
            try:
                funcao(portal)
                erros = [e for e in portal.erros if not any(r in e for r in RUIDO_DO_PORTAL)]
                verificar(not erros, f"erros de JavaScript na página: {erros}")
                resultados.append((nome, True, "", time.time() - inicio))
                print(f"  OK     {nome:24} {time.time() - inicio:5.1f}s")
            except Exception as e:
                arquivo = os.path.join(pasta, f"{tela}-{nome}.png")
                try:
                    page.screenshot(path=arquivo)
                except Exception:
                    arquivo = "(sem captura)"
                motivo = editar_registro(str(e) if isinstance(e, Falha) else f"{type(e).__name__}: {e}")
                if not isinstance(e, Falha):
                    print(editar_registro(traceback.format_exc()), file=sys.stderr)
                resultados.append((nome, False, motivo, time.time() - inicio))
                print(f"  FALHOU {nome:24} {time.time() - inicio:5.1f}s  {motivo}\n         captura: {os.path.relpath(arquivo, RAIZ)}")
            finally:
                try:
                    portal.latencia(0)
                except Exception:
                    pass
    finally:
        contexto.close()
        if proxy:
            proxy.shutdown()
            proxy.server_close()
        if args.telemetria:
            args.telemetria.fechar()
        shutil.rmtree(perfil, ignore_errors=True)
    return resultados


def main():
    analisador = argparse.ArgumentParser(description="Testes do Dealer/Fluxo no portal DealerNet")
    analisador.add_argument("--tela", action="append", help="LARGURAxALTURA da área da página")
    analisador.add_argument("--extensao", action="store_true")
    analisador.add_argument("--mostrar", action="store_true")
    analisador.add_argument("--navegador", choices=["chromium", "firefox"], default="chromium")
    analisador.add_argument("--so", default="")
    analisador.add_argument("--lista", action="store_true")
    analisador.add_argument("--url", default=os.environ.get("DN_URL"))
    args = analisador.parse_args()
    if not args.url:
        raise SystemExit("Informe o endereço do portal: --url https://<empresa>.dealernetworkflow.com.br/ (ou a variável DN_URL)")

    if args.lista:
        for nome, descricao, funcao in TESTES:
            notas = (["só com --extensao"] if funcao.so_extensao else []) + (["só no Chromium"] if funcao.so_chromium else [])
            print(f"{nome:24} {descricao}{'  [' + ', '.join(notas) + ']' if notas else ''}")
        return 0

    selecionados = [t for t in TESTES if (args.extensao or not t[2].so_extensao) and
                    (args.navegador == "chromium" or not t[2].so_chromium)]
    if args.so:
        nomes = [n.strip() for n in args.so.split(",") if n.strip()]
        desconhecidos = set(nomes) - {t[0] for t in TESTES}
        if desconhecidos:
            raise SystemExit(f"Testes desconhecidos: {', '.join(sorted(desconhecidos))} (use --lista)")
        selecionados = [t for t in selecionados if t[0] in nomes]

    usuario = os.environ.get("DN_USUARIO") or input("Usuário DealerNet: ")
    senha = os.environ.get("DN_SENHA") or getpass.getpass("Senha: ")
    telas = args.tela or ["1280x620", "1920x960"]
    pasta = os.path.join(AQUI, "resultados", datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
    os.makedirs(pasta, exist_ok=True)

    todos = {}
    with sync_playwright() as pw:
        for tela in telas:
            print(f"\nTela {tela} ({'extensão' if args.extensao else 'userscript'}, {args.navegador}):")
            todos[tela] = rodar_em_tela(pw, args, tela, usuario, senha, selecionados, pasta)

    falhas = [(tela, r) for tela, rs in todos.items() for r in rs if not r[1]]
    total = sum(len(rs) for rs in todos.values())
    print(f"\n{total - len(falhas)} de {total} testes passaram.")
    for tela, (nome, _, motivo, _) in falhas:
        print(f"  {tela} {nome}: {motivo}")
    if not falhas:
        shutil.rmtree(pasta, ignore_errors=True)
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
