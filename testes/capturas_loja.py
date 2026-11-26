"""
Capturas de tela para as lojas (1280x800, o tamanho da Chrome Web Store), com a extensão de verdade e os dados
pessoais trocados por dados de demonstração (usuário, empresa, servidor; logotipos escondidos; ver loja_comum.py).

    python3 extensao/build.py
    DN_URL=https://<empresa>.dealernetworkflow.com.br/ DN_USUARIO=seu.usuario DN_SENHA='...' python3 testes/capturas_loja.py

Grava em extensao/loja/. A Chrome Web Store aceita até 5 capturas (as de 1 a 5); o Firefox aceita todas.
Só abre telas e menus: na 5a captura abre Administração > Empresarial > Empresa > Modifica > Geral > Flag para
mostrar a busca na lista, e fecha sem Confirmar (nada é salvo).
Ao final, lista o que ainda aparecesse de pessoal em texto visível ("ACHADOS"): deve ficar vazio.
"""
import os, sys, types, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import testar
from loja_comum import ANONIMIZAR, CONFERIR
from playwright.sync_api import sync_playwright

DESTINO = os.environ.get("DESTINO") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extensao", "loja")
ACHADOS = []


def capturar(p, nome, mover_mouse=True):
    p.js(ANONIMIZAR)
    p.esperar(300)
    sobrou = p.js(CONFERIR)
    if sobrou:
        ACHADOS.append((nome, sobrou))
    if mover_mouse:
        p.page.mouse.move(640, 790)  # tira o mouse de cima de dicas
        p.esperar(200)
    p.js(ANONIMIZAR)
    p.page.screenshot(path=os.path.join(DESTINO, f"{nome}.png"))
    print("capturado:", nome, "sobrou:", sobrou)


def aparencia(p, pronto):
    """Escolhe um estilo pronto dos botões pela janela de configurações (e salva)."""
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    p.page.locator('.barraTarefasConfig select[name="botaoPronto"]').select_option(pronto)
    p.page.get_by_role("button", name="Salvar").click()
    p.esperar(600)


def capturas(p):
    p.preparar({"temaAlfaAceito": True, "temaFonteAceita": True,
                "fluxos": {"notificarAoAbrir": False, "som": False}})
    pg = p.page

    # 1) Barra de tarefas com janelas e o aviso de novos fluxos (botões no estilo "Moderno")
    aparencia(p, "moderno")
    a = p.abrir_pessoas()
    b = p.abrir_pesquisas()
    p.botao(a).click(); p.esperar(500)
    p.tela(a).locator("#vPESSOA_NOME").click()
    pg.keyboard.press("Alt+Shift+KeyD")                       # uma terceira janela (duplicada)
    p.esperar_js("() => oW5Portal.windows.length === 3", 10000)
    p.esperar_tela_carregada(p.ativa())
    p.botao(b).click(); p.esperar(800)
    p.simular_aumento(p.primeiro_fluxo(), 3)
    p.esperar_js("() => !!document.querySelector('.barraTarefasNotificacao.visivel')", 20000, "o aviso de fluxos não apareceu")
    p.esperar(800)
    pg.mouse.move(1000, 200)                                  # mouse em cima: o aviso fica parado
    p.esperar(400)
    capturar(p, "1-barra-de-tarefas-e-aviso-de-fluxos")
    p.js("() => document.querySelectorAll('.barraTarefasNotificacao').forEach(n => n.remove())")

    # 2) Aparência dos botões (aba Barra, com a prévia e a barra de verdade no estilo "Setas")
    p.menu_engrenagem("Configurações...")
    p.aba_config("barra")
    pg.locator('.barraTarefasConfig select[name="botaoPronto"]').select_option("setas")
    pg.locator(".barraTarefasConfig .dbtPreviaFundo").scroll_into_view_if_needed()
    p.esperar(600)
    capturar(p, "2-aparencia-dos-botoes")
    pg.get_by_role("button", name="Salvar").click(); p.esperar(600)

    # 3) Tema escuro + menu Tema da engrenagem (botões em "Setas")
    p.js("() => DealerTema.definir({ tema: 'dracula' })"); p.esperar(1500)
    pg.locator("#barraTarefasBotaoStatus").click(); p.esperar(400)
    p.item_menu("Tema").hover(); p.esperar(800)
    p.item_menu("Dracula").hover(); p.esperar(300)        # o submenu fica aberto, com o tema atual marcado
    capturar(p, "3-temas-de-cores", mover_mouse=False)
    p.js("() => Ext.menu.MenuMgr.hideAll()"); p.esperar(400)

    # 4) Aviso da tela em destaque (mensagem simulada, só nesta cópia da página), em tema claro
    p.js("() => DealerTema.definir({ tema: 'github-light' })"); p.esperar(1500)
    aparencia(p, "neon")
    p.botao(a).click(); p.esperar(600)
    pg.mouse.move(5, 400)
    p.js(f"""() => {{ const d = document.querySelector('#{a} iframe').contentDocument;
        d.getElementById('gxErrorViewer').innerHTML = '<div>Atenção!! Informe o CPF ou o CNPJ da pessoa antes de continuar.</div>'; }}""")
    p.esperar(1200)
    capturar(p, "4-avisos-das-telas")
    p.js(f"() => {{ document.querySelector('#{a} iframe').contentDocument.getElementById('gxErrorViewer').innerHTML = ''; }}")
    p.esperar(600)

    # 5) Busca nas listas: Administração > Empresarial > Empresa > Modifica > Geral > Flag (só abrir, nunca salvar)
    p.js("() => DealerTema.definir({ tema: 'off' })"); p.esperar(1000)
    aparencia(p, "classico")
    e = p.abrir_menu("Administração", "Empresarial", "Empresa")
    p.esperar(1500)
    p.tela(e).locator("#vUPDATE_0001").click(); p.esperar(4000)
    p.tela(e).locator("input[name=PARGERAL]").click(); p.esperar(5000)
    p.tela(e).locator("span.x-tab-strip-text", has_text="Flag").click(); p.esperar(2500)
    p.tela(e).locator("select[id^='PARAMETROEMPRESAGERALFLAG_TIPO_']").last.focus(); p.esperar(400)
    p.tela(e).locator("#dnf-lupa").click(); p.esperar(500)
    pg.keyboard.type("integracao", delay=60); p.esperar(600)
    capturar(p, "5-busca-nas-listas")
    pg.keyboard.press("Escape"); p.esperar(300)
    p.js(f"() => Ext.getCmp('{e}').close()")                 # fecha sem Confirmar: nada é salvo
    p.esperar(800)

    # 6) Notificação de fluxos: sons e volume (tema Nord, botões "Bolinhas")
    p.js("() => DealerTema.definir({ tema: 'nord' })"); p.esperar(1500)
    aparencia(p, "bolinhas")
    p.menu_engrenagem("Configurações...")
    p.aba_config("fluxos"); p.esperar(500)
    capturar(p, "6-notificacao-de-fluxos")
    pg.get_by_role("button", name="Cancelar").click(); p.esperar(500)

    # 7) Busca nas configurações (tema Catppuccin Latte, botões "Abas")
    p.js("() => DealerTema.definir({ tema: 'catppuccin-latte' })"); p.esperar(1500)
    aparencia(p, "abas")
    p.menu_engrenagem("Configurações...")
    pg.locator(".barraTarefasConfig .dbtCampoBuscaConfig").fill("tempo"); p.esperar(500)
    capturar(p, "7-busca-nas-configuracoes")
    pg.get_by_role("button", name="Cancelar").click(); p.esperar(500)

    p.js("() => DealerTema.definir({ tema: 'off' })")
    p.js("() => oW5Portal.closeAllWindows()")


if __name__ == "__main__":
    os.makedirs(DESTINO, exist_ok=True)
    args = types.SimpleNamespace(url=os.environ["DN_URL"], extensao=True, navegador="chromium", mostrar=False)
    with sync_playwright() as pw:
        testar.rodar_em_tela(pw, args, "1280x800", os.environ["DN_USUARIO"], os.environ["DN_SENHA"],
                             [("capturas", "capturas", capturas)], tempfile.mkdtemp())
    print("ACHADOS:", ACHADOS)
