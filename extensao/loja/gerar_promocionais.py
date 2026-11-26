#!/usr/bin/env python3
"""
Gera as imagens promocionais da Chrome Web Store, a partir do ícone (icones/original.png) e das capturas desta
pasta (feitas por testes/capturas_loja.py, já anonimizadas):

    promo-pequeno-440x280.png      "Bloco promocional pequeno"
    promo-letreiro-1400x560.png    "Bloco de promoção de letreiro"
    miniatura-video-1280x720.png   miniatura do vídeo no YouTube (dealer-fluxo-video.mp4)

    python3 extensao/loja/gerar_promocionais.py

O layout é HTML desenhado pelo navegador do Playwright no tamanho exato; o PNG sai em RGB de 24 bits, sem
alfa, como a loja pede.
"""
import base64
import os

from PIL import Image
from playwright.sync_api import sync_playwright

import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "testes"))
from testar import executavel_chromium  # o Chromium do sistema (o mesmo dos testes)

AQUI = os.path.dirname(os.path.abspath(__file__))
ICONE = os.path.join(AQUI, "..", "icones", "original.png")
CAPTURA_FRENTE = os.path.join(AQUI, "4-avisos-das-telas.png")
CAPTURA_FUNDO = os.path.join(AQUI, "1-barra-de-tarefas-e-aviso-de-fluxos.png")
CAPTURA_TEMA = os.path.join(AQUI, "3-temas-de-cores.png")
CAPTURA_BOTOES = os.path.join(AQUI, "2-aparencia-dos-botoes.png")

AZUL = "#031a5c"        # cores do ícone
AZUL_CLARO = "#6fa0dc"
VERMELHO = "#ed1c2b"


def dados(caminho):
    with open(caminho, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


ESTILO_BASE = f"""
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{ width: 100%; height: 100%; overflow: hidden; }}
body {{
    font-family: "Noto Sans", "Segoe UI", Arial, sans-serif; color: #fff;
    background: radial-gradient(120% 140% at 0% 0%, #0b2c86 0%, {AZUL} 55%, #020f3a 100%);
}}
.icone {{ border-radius: 18%; box-shadow: 0 10px 30px rgba(0,0,0,.35); }}
.nome {{ font-weight: 800; letter-spacing: -0.5px; line-height: 1; }}
.nome span {{ color: {AZUL_CLARO}; }}
.onda {{ height: 5px; border-radius: 3px; background: linear-gradient(90deg, {VERMELHO}, {VERMELHO} 70%, rgba(237,28,43,0)); }}
.oficial {{ color: rgba(255,255,255,.6); }}
"""


def html_pequeno(icone):
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{ESTILO_BASE}
    body {{ display: flex; align-items: center; gap: 22px; padding: 0 28px; }}
    .icone {{ width: 112px; height: 112px; flex: none; }}
    .nome {{ font-size: 34px; white-space: nowrap; }}
    .onda {{ width: 170px; margin: 11px 0 13px; }}
    .lema {{ font-size: 16px; line-height: 1.35; font-weight: 500; color: rgba(255,255,255,.92); }}
    .oficial {{ font-size: 12px; margin-top: 10px; }}
    </style></head><body>
    <img class="icone" src="{icone}">
    <div>
        <div class="nome">Dealer<span>/</span>Fluxo</div>
        <div class="onda"></div>
        <div class="lema">Barra de tarefas, atalhos e aviso de fluxos para o DealerNet Workflow</div>
        <div class="oficial">Extensão não oficial</div>
    </div></body></html>"""


def html_letreiro(icone, frente, fundo):
    itens = ["Barra de tarefas com as janelas abertas", "Atalhos de teclado em qualquer tela",
             "Aviso de novos fluxos, com som opcional", "Temas de cores claros e escuros"]
    lista = "".join(f'<li><span class="marca">&#10003;</span>{t}</li>' for t in itens)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{ESTILO_BASE}
    body {{ position: relative; }}
    .texto {{ position: absolute; left: 80px; top: 0; bottom: 0; width: 600px;
              display: flex; flex-direction: column; justify-content: center; }}
    .titulo {{ display: flex; align-items: center; gap: 22px; }}
    .icone {{ width: 96px; height: 96px; }}
    .nome {{ font-size: 60px; }}
    .onda {{ width: 300px; margin: 22px 0 22px; }}
    .lema {{ font-size: 26px; font-weight: 600; line-height: 1.3; margin-bottom: 22px; }}
    ul {{ list-style: none; }}
    li {{ font-size: 21px; line-height: 1.25; margin: 0 0 12px; color: rgba(255,255,255,.92); display: flex; align-items: center; }}
    .marca {{ display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; margin-right: 12px;
              border-radius: 50%; background: {VERMELHO}; font-size: 15px; font-weight: 800; flex: none; }}
    .oficial {{ font-size: 15px; margin-top: 12px; }}
    .tela {{ position: absolute; width: 580px; border-radius: 10px; box-shadow: 0 24px 60px rgba(0,0,0,.5);
             border: 1px solid rgba(255,255,255,.18); }}
    .fundo {{ left: 770px; top: 40px; transform: rotate(4deg); }}
    .frente {{ left: 700px; top: 160px; transform: rotate(-3deg); }}
    </style></head><body>
    <img class="tela fundo" src="{fundo}">
    <img class="tela frente" src="{frente}">
    <div class="texto">
        <div class="titulo"><img class="icone" src="{icone}"><div class="nome">Dealer<span>/</span>Fluxo</div></div>
        <div class="onda"></div>
        <div class="lema">Mais agilidade no DealerNet Workflow</div>
        <ul>{lista}</ul>
        <div class="oficial">Extensão não oficial, gratuita e de código aberto (GPL-3.0)</div>
    </div></body></html>"""


def html_miniatura(icone, tema, botoes):
    """Miniatura do YouTube: pouco texto e grande (aparece pequena na lista de vídeos)."""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{ESTILO_BASE}
    body {{ position: relative; }}
    .tela {{ position: absolute; border-radius: 12px; box-shadow: 0 26px 70px rgba(0,0,0,.55);
             border: 2px solid rgba(255,255,255,.22); }}
    .fundo {{ width: 620px; left: 700px; top: 60px; transform: rotate(5deg); }}
    .frente {{ width: 580px; left: 665px; top: 335px; transform: rotate(-4deg); }}
    .texto {{ position: absolute; left: 64px; top: 0; bottom: 0; width: 600px;
              display: flex; flex-direction: column; justify-content: center; }}
    .icone {{ width: 150px; height: 150px; margin-bottom: 26px; }}
    .nome {{ font-size: 88px; letter-spacing: -2px; text-shadow: 0 4px 18px rgba(0,0,0,.35); }}
    .onda {{ width: 340px; height: 9px; border-radius: 5px; margin: 28px 0 26px; }}
    .lema {{ font-size: 46px; font-weight: 800; line-height: 1.12; }}
    .lema span {{ color: {VERMELHO}; background: #fff; padding: 0 12px; border-radius: 8px; display: inline-block; margin-top: 10px; }}
    </style></head><body>
    <img class="tela fundo" src="{tema}">
    <img class="tela frente" src="{botoes}">
    <div class="texto">
        <img class="icone" src="{icone}">
        <div class="nome">Dealer<span>/</span>Fluxo</div>
        <div class="onda"></div>
        <div class="lema">DealerNet Workflow<br><span>mais ágil</span></div>
    </div></body></html>"""


def desenhar(navegador, html, largura, altura, destino):
    pagina = navegador.new_page(viewport={"width": largura, "height": altura}, device_scale_factor=1)
    pagina.set_content(html, wait_until="load")
    pagina.wait_for_timeout(300)
    temporario = destino + ".tmp.png"
    pagina.screenshot(path=temporario)
    pagina.close()
    Image.open(temporario).convert("RGB").save(destino, optimize=True)   # 24 bits, sem alfa
    os.remove(temporario)
    img = Image.open(destino)
    print(f"{os.path.relpath(destino, AQUI)}: {img.size[0]}x{img.size[1]} {img.mode}")


def main():
    icone, frente, fundo = dados(ICONE), dados(CAPTURA_FRENTE), dados(CAPTURA_FUNDO)
    with sync_playwright() as pw:
        navegador = pw.chromium.launch(executable_path=executavel_chromium())
        desenhar(navegador, html_pequeno(icone), 440, 280, os.path.join(AQUI, "promo-pequeno-440x280.png"))
        desenhar(navegador, html_letreiro(icone, frente, fundo), 1400, 560, os.path.join(AQUI, "promo-letreiro-1400x560.png"))
        desenhar(navegador, html_miniatura(icone, dados(CAPTURA_TEMA), dados(CAPTURA_BOTOES)), 1280, 720,
                 os.path.join(AQUI, "miniatura-video-1280x720.png"))
        navegador.close()


if __name__ == "__main__":
    main()
