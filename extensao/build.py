#!/usr/bin/env python3
"""
Gera a extensão Dealer/Fluxo para Chrome e Firefox a partir do userscript.

    python3 build.py

Resultado:
    build/chrome/   e build/firefox/   -> pastas para carregar sem empacotar (para testar)
    build/chrome-teste/, build/firefox-teste/ -> só para os testes automáticos (ver abaixo); nunca publique
    dist/dealer-fluxo-chrome-<versão>.zip   -> enviar para a Chrome Web Store
    dist/dealer-fluxo-firefox-<versão>.zip  -> enviar para addons.mozilla.org

O código da página é o mesmo do userscript (../userscript.js), sem o cabeçalho ==UserScript==.
Tema de cores (Dealer/Tema): a fonte é ../../Tema Escuro/dealer-tema.lib.js, quando essa pasta existe (na máquina
do autor). Sem ela (ex.: quem clonou só este repositório), o build usa a cópia que já está dentro do userscript.js.
O build copia o arquivo sem alterar: (1) para dentro do userscript.js, entre os marcadores
"// ==== Dealer/Tema" e "// ==== fim do Dealer/Tema ====" (atualiza o userscript.js se o tema mudou), e
(2) para a extensão como dealer-tema.js, um content script próprio em document_start (o portal já abre com
as cores do tema). Nunca edite o trecho do tema dentro do userscript.js: rode o build de novo.
O Sortable vai junto em vendor/ (as lojas não aceitam código carregado de CDN).
src/ tem a parte própria da extensão: background.js (registra o script nos portais que o usuário
ativou), popup.html (botão da extensão) e opcoes.html (configurações), que usam sites.js e sites.css.

A versão de teste já vem com permissão para todos os sites: os testes automáticos não conseguem clicar
no pedido de permissão do navegador. O resto é igual.
"""
import json
import os
import re
import shutil
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
USERSCRIPT = os.path.join(AQUI, "..", "userscript.js")
TEMA = os.path.join(AQUI, "..", "..", "Tema Escuro", "dealer-tema.lib.js")
INICIO_TEMA = "// ==== Dealer/Tema (gerado a partir de ../Tema Escuro/dealer-tema.lib.js, não editar aqui) ===="
FIM_TEMA = "// ==== fim do Dealer/Tema ===="

# ID da extensão no Firefox. Depois de publicado, NÃO pode mudar (é o que liga as atualizações).
ID_FIREFOX = "dealerfluxo@igorslime"

ARQUIVOS_SRC = ["background.js", "popup.html", "opcoes.html", "sites.js", "sites.css", "telemetria-ponte.js", "managed_schema.json"]

# Telemetria: endereço do servidor. A build de teste usa um servidor local (os testes nunca enviam para o real).
ENDERECO_TELEMETRIA = "https://dealer-fluxo-ping.igorslime.workers.dev"
ENDERECO_TELEMETRIA_TESTE = "http://127.0.0.1:8766"

PAGINAS = [
    "https://*.dealernetworkflow.com.br/Portal/default.html*",
    "http://*.dealernetworkflow.com.br/Portal/default.html*",
]
# O tema vale também na tela de login (página própria, fora do portal); o Dealer/Fluxo não roda lá
PAGINAS_TEMA = PAGINAS + [
    "https://*.dealernetworkflow.com.br/LoginAux.aspx*",
    "http://*.dealernetworkflow.com.br/LoginAux.aspx*",
]


def ler_tema():
    if not os.path.exists(TEMA):                     # sem a pasta do Dealer/Tema: a cópia que já está no userscript.js
        with open(USERSCRIPT, encoding="utf-8") as f:
            texto = f.read()
        i, j = texto.find(INICIO_TEMA), texto.find(FIM_TEMA)
        if i < 0 or j < i:
            raise SystemExit("Marcadores do Dealer/Tema não encontrados em userscript.js")
        codigo = texto[i + len(INICIO_TEMA):j].strip("\n") + "\n"
        versao = re.search(r"const VERSAO = '([^']+)'", codigo)
        return (versao.group(1) if versao else "?") + " (cópia do userscript.js)", codigo
    with open(TEMA, encoding="utf-8") as f:
        codigo = f.read()
    versao = re.search(r"const VERSAO = '([^']+)'", codigo)
    return (versao.group(1) if versao else "?"), codigo


def atualizar_tema_no_userscript(codigo_tema):
    """Coloca o tema atual entre os marcadores do userscript.js (o userscript publicado é um arquivo só)."""
    with open(USERSCRIPT, encoding="utf-8") as f:
        texto = f.read()
    i, j = texto.find(INICIO_TEMA), texto.find(FIM_TEMA)
    if i < 0 or j < i:
        raise SystemExit("Marcadores do Dealer/Tema não encontrados em userscript.js")
    novo = texto[:i] + INICIO_TEMA + "\n" + codigo_tema.rstrip("\n") + "\n" + texto[j:]
    if novo != texto:
        with open(USERSCRIPT, "w", encoding="utf-8") as f:
            f.write(novo)
        print("userscript.js: trecho do Dealer/Tema atualizado")


def ler_userscript():
    with open(USERSCRIPT, encoding="utf-8") as f:
        texto = f.read()
    # Na extensão o tema vai num content script separado (document_start); tira o trecho dele daqui
    i, j = texto.find(INICIO_TEMA), texto.find(FIM_TEMA)
    if i >= 0 and j > i:
        texto = texto[:i] + texto[j + len(FIM_TEMA):]
    cabecalho = re.match(r"\s*// ==UserScript==.*?// ==/UserScript==\s*", texto, re.S)
    if not cabecalho:
        raise SystemExit("Cabeçalho ==UserScript== não encontrado em userscript.js")
    versao = re.search(r"//\s*@version\s+(\S+)", cabecalho.group(0)).group(1)
    no_codigo = re.search(r"const VERSAO_FLUXO = '([^']+)'", texto)
    if not no_codigo or no_codigo.group(1) != versao:
        raise SystemExit(f"VERSAO_FLUXO no userscript.js ({no_codigo and no_codigo.group(1)}) diferente do @version ({versao})")
    return versao, texto[cabecalho.end():]


def manifesto(navegador, versao, teste=False):
    m = {
        "manifest_version": 3,
        "name": "Dealer/Fluxo",
        "short_name": "Dealer/Fluxo",
        "version": versao,
        # A Chrome Web Store aceita no máximo 132 caracteres aqui (conferido abaixo, em gerar())
        "description": "Barra de tarefas, atalhos, aviso de novos fluxos e temas de cores para o DealerNet Workflow. Extensão não oficial.",
        "icons": {str(t): f"icones/icone{t}.png" for t in (16, 32, 48, 128)},
        "content_scripts": [{
            # Tema de cores: antes de tudo, para o portal já abrir com as cores (desligado por padrão).
            # Também na tela de login.
            "matches": PAGINAS_TEMA,
            "js": ["dealer-tema.js"],
            "run_at": "document_start",
            "world": "MAIN",
        }, {
            # Ponte da telemetria entre a página e o fundo da extensão (mundo isolado, só repassa mensagens)
            "matches": PAGINAS,
            "js": ["telemetria-ponte.js"],
            "run_at": "document_start",
        }, {
            "matches": PAGINAS,
            "js": ["vendor/Sortable.min.js", "dealerfluxo.js"],
            "run_at": "document_idle",
            # Roda no contexto da página, para acessar o ExtJS e o oW5Portal do portal
            "world": "MAIN",
        }],
        # Portais em outros endereços: o usuário ativa pelo botão da extensão. "scripting" registra o
        # script para o site, "activeTab" deixa o popup ver se a aba atual é o portal (só quando o
        # usuário clica no botão), e a permissão de cada site é pedida na hora (optional_host_permissions).
        # "alarms": conferir de hora em hora se há estatísticas de uso de dias anteriores para enviar
        "permissions": ["scripting", "storage", "activeTab", "alarms"],
        "optional_host_permissions": ["http://*/*", "https://*/*"],
        "action": {
            "default_title": "Dealer/Fluxo",
            "default_popup": "popup.html",
            "default_icon": {str(t): f"icones/icone{t}.png" for t in (16, 32)},
        },
        "options_ui": {"page": "opcoes.html", "open_in_tab": True},
    }
    if navegador != "firefox":
        # Empresas podem desligar a telemetria por política do navegador (Chrome/Edge: storage gerenciado)
        m["storage"] = {"managed_schema": "managed_schema.json"}
    if teste:
        m["host_permissions"] = ["http://*/*", "https://*/*"]
    if navegador == "firefox":
        m["background"] = {"scripts": ["background.js"]}
        m["browser_specific_settings"] = {
            # Android: as permissões de dados (data_collection_permissions) só existem a partir do 142
            "gecko_android": {"strict_min_version": "142.0"},
            "gecko": {
                "id": ID_FIREFOX,
                # 140: primeira com o consentimento de dados embutido (antes dela a extensão teria de ter o próprio)
                "strict_min_version": "140.0",
                # Estatísticas de uso (opcional, marcado por padrão na instalação) e, só se o usuário ativar,
                # as imagens sem ícone do tema (nome do arquivo, dica e página: conteúdo do site)
                "data_collection_permissions": {"required": ["none"], "optional": ["technicalAndInteraction", "websiteContent"]},
            }
        }
    else:
        m["background"] = {"service_worker": "background.js"}
        m["minimum_chrome_version"] = "111"      # primeira versão com content_scripts "world": "MAIN"
    return m


def gerar(navegador, versao, codigo, codigo_tema, teste=False):
    destino = os.path.join(AQUI, "build", navegador + ("-teste" if teste else ""))
    shutil.rmtree(destino, ignore_errors=True)
    os.makedirs(os.path.join(destino, "vendor"))
    os.makedirs(os.path.join(destino, "icones"))

    if len(manifesto(navegador, versao, teste)["description"]) > 132:
        raise SystemExit("A descrição do manifesto passou de 132 caracteres (limite da Chrome Web Store)")
    with open(os.path.join(destino, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifesto(navegador, versao, teste), f, ensure_ascii=False, indent=2)
    with open(os.path.join(destino, "dealerfluxo.js"), "w", encoding="utf-8") as f:
        f.write(f"// Dealer/Fluxo {versao} - gerado a partir de userscript.js por build.py\n")
        f.write(codigo)
    with open(os.path.join(destino, "dealer-tema.js"), "w", encoding="utf-8") as f:
        f.write(codigo_tema)
    shutil.copy(os.path.join(AQUI, "vendor", "Sortable.min.js"), os.path.join(destino, "vendor"))
    # Licenças: a do Dealer/Fluxo (GPL-3.0) e a do SortableJS (MIT, exige manter o aviso junto)
    shutil.copy(os.path.join(AQUI, "vendor", "Sortable.LICENSE"), os.path.join(destino, "vendor"))
    shutil.copy(os.path.join(AQUI, "..", "LICENSE"), destino)
    for t in (16, 32, 48, 128):
        shutil.copy(os.path.join(AQUI, "icones", f"icone{t}.png"), os.path.join(destino, "icones"))
    for nome in ARQUIVOS_SRC:
        shutil.copy(os.path.join(AQUI, "src", nome), destino)
    fundo = os.path.join(destino, "background.js")
    with open(fundo, encoding="utf-8") as f:
        texto = f.read()
    if f"'{ENDERECO_TELEMETRIA}'" not in texto:
        raise SystemExit("background.js: endereço da telemetria diferente do build.py")
    if teste:
        with open(fundo, "w", encoding="utf-8") as f:
            f.write(texto.replace(f"'{ENDERECO_TELEMETRIA}'", f"'{ENDERECO_TELEMETRIA_TESTE}'"))

    if teste:
        print(f"{navegador} (teste): {os.path.relpath(destino, AQUI)}/")
        return

    os.makedirs(os.path.join(AQUI, "dist"), exist_ok=True)
    pacote = os.path.join(AQUI, "dist", f"dealer-fluxo-{navegador}-{versao}.zip")
    with zipfile.ZipFile(pacote, "w", zipfile.ZIP_DEFLATED) as z:
        for raiz, _, arquivos in os.walk(destino):
            for nome in sorted(arquivos):
                caminho = os.path.join(raiz, nome)
                z.write(caminho, os.path.relpath(caminho, destino))
    print(f"{navegador}: {os.path.relpath(destino, AQUI)}/  e  {os.path.relpath(pacote, AQUI)}")


if __name__ == "__main__":
    versao_tema, codigo_tema = ler_tema()
    print(f"Dealer/Tema {versao_tema}")
    atualizar_tema_no_userscript(codigo_tema)
    versao, codigo = ler_userscript()
    for navegador in ("chrome", "firefox"):
        gerar(navegador, versao, codigo, codigo_tema)
    gerar("chrome", versao, codigo, codigo_tema, teste=True)
    gerar("firefox", versao, codigo, codigo_tema, teste=True)
