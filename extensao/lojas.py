#!/usr/bin/env python3
"""
Envio para as lojas (usado pelo .github/workflows/publicar.yml; também roda à mão).

    python3 extensao/lojas.py chrome-publicar dist/dealer-fluxo-chrome-1.3.0.zip
    python3 extensao/lojas.py chrome-conferir
    python3 extensao/lojas.py firefox-conferir

Chrome Web Store (API v2): conta de serviço do Google cadastrada no painel da loja (Conta > conta de serviço).
    CWS_CONTA_SERVICO   o JSON da chave da conta de serviço (o arquivo inteiro)
    CWS_PUBLISHER_ID    ID do editor (painel da loja: Publisher > Settings)
    CWS_ITEM_ID         ID da extensão (padrão: o da Dealer/Fluxo)
Firefox (addons.mozilla.org), só para conferir (o envio é pelo web-ext sign):
    AMO_JWT_ISSUER, AMO_JWT_SECRET   chave da API (Developer Hub > Tools > Manage API Keys)

Nada de chave ou token é impresso; no GitHub Actions o token ainda é mascarado no log.
Precisa de: pip install "pyjwt[crypto]"
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request, uuid

ITEM_CHROME = "dgnlfhccofihphmfacpjbgmodbcligaf"
ID_FIREFOX = "dealerfluxo@igorslime"
API_CWS = "https://chromewebstore.googleapis.com"
ESCOPO_CWS = "https://www.googleapis.com/auth/chromewebstore"
NO_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"


def falhar(msg):
    print(f"::error::{msg}" if NO_GITHUB else f"ERRO: {msg}", file=sys.stderr)
    sys.exit(1)


def precisa(nome):
    valor = os.environ.get(nome, "").strip()
    if not valor:
        falhar(f"falta a variável {nome} (veja extensao/README.md, seção Publicar)")
    return valor


def pedir(metodo, url, token=None, corpo=None, tipo="application/json", cabecalho="Bearer"):
    dados = None
    if corpo is not None:
        dados = corpo if isinstance(corpo, bytes) else json.dumps(corpo).encode()
    req = urllib.request.Request(url, data=dados, method=metodo)
    if token:
        req.add_header("Authorization", f"{cabecalho} {token}")
    if dados is not None:
        req.add_header("Content-Type", tipo)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            texto = r.read().decode() or "{}"
            return json.loads(texto)
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode(errors="replace")[:1500]
        falhar(f"{metodo} {url.split('?')[0]} respondeu {e.code}: {detalhe}")


# ---------------------------------------------------------------- Chrome Web Store
def token_chrome():
    import jwt
    try:
        conta = json.loads(precisa("CWS_CONTA_SERVICO"))
        email, chave = conta["client_email"], conta["private_key"]
    except (ValueError, KeyError):
        falhar("CWS_CONTA_SERVICO não é o JSON da chave da conta de serviço (precisa de client_email e private_key)")
    agora = int(time.time())
    afirmacao = jwt.encode({"iss": email, "scope": ESCOPO_CWS, "aud": "https://oauth2.googleapis.com/token",
                            "iat": agora, "exp": agora + 3600}, chave, algorithm="RS256",
                           headers={"kid": conta.get("private_key_id", "")})
    req = urllib.request.Request("https://oauth2.googleapis.com/token", method="POST", data=urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": afirmacao}).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            token = json.loads(r.read())["access_token"]
    except urllib.error.HTTPError as e:
        falhar(f"o Google recusou a conta de serviço ({e.code}): {e.read().decode(errors='replace')[:500]}")
    if NO_GITHUB:
        print(f"::add-mask::{token}")
    return token


def caminho_item():
    return f"publishers/{precisa('CWS_PUBLISHER_ID')}/items/{os.environ.get('CWS_ITEM_ID') or ITEM_CHROME}"


def mostrar_status(st):
    def versoes(rev):
        canais = (rev or {}).get("distributionChannels") or []
        return ", ".join(f"{c.get('crxVersion', '?')} ({c.get('deployPercentage', '?')}%)" for c in canais) or "-"
    pub, env = st.get("publishedItemRevisionStatus") or {}, st.get("submittedItemRevisionStatus") or {}
    print(f"  publicada: {versoes(pub)}  [{pub.get('state', '-')}]")
    print(f"  enviada:   {versoes(env)}  [{env.get('state', '-')}]")
    if st.get("takenDown") or st.get("warned"):
        print(f"  ATENÇÃO: takenDown={st.get('takenDown')} warned={st.get('warned')}")


def chrome_conferir():
    token = token_chrome()
    st = pedir("GET", f"{API_CWS}/v2/{caminho_item()}:fetchStatus", token)
    print("Chrome Web Store: credenciais OK")
    mostrar_status(st)


def chrome_publicar(zip_path):
    if not os.path.isfile(zip_path):
        falhar(f"pacote não encontrado: {zip_path}")
    token = token_chrome()
    item = caminho_item()
    with open(zip_path, "rb") as f:
        pacote = f.read()
    print(f"Enviando {os.path.basename(zip_path)} ({len(pacote) // 1024} KB) para a Chrome Web Store...")
    r = pedir("POST", f"{API_CWS}/upload/v2/{item}:upload", token, pacote, tipo="application/zip")
    estado = r.get("uploadState")
    # O envio pode terminar depois (assíncrono): acompanha pelo fetchStatus por até 10 minutos
    limite = time.time() + 600
    while estado in ("IN_PROGRESS", "UPLOAD_IN_PROGRESS") and time.time() < limite:
        time.sleep(10)
        estado = (pedir("GET", f"{API_CWS}/v2/{item}:fetchStatus", token).get("lastAsyncUploadState") or estado)
        print(f"  processando... ({estado})")
    if estado != "SUCCEEDED":
        falhar(f"o envio não terminou bem (uploadState={estado}). Resposta: {json.dumps(r)[:800]}")
    print(f"  pacote aceito: versão {r.get('crxVersion', '?')}")
    p = pedir("POST", f"{API_CWS}/v2/{item}:publish", token, {"publishType": "DEFAULT_PUBLISH"})
    print(f"Enviada para revisão (estado: {p.get('state', '?')}). Ela é publicada sozinha quando a revisão aprovar.")
    if p.get("warningInfo"):
        print(f"  avisos da loja: {json.dumps(p['warningInfo'], ensure_ascii=False)[:800]}")


# ---------------------------------------------------------------- Firefox (só conferir)
def firefox_conferir():
    import jwt
    agora = int(time.time())
    token = jwt.encode({"iss": precisa("AMO_JWT_ISSUER"), "jti": str(uuid.uuid4()), "iat": agora, "exp": agora + 60},
                       precisa("AMO_JWT_SECRET"), algorithm="HS256")
    a = pedir("GET", f"https://addons.mozilla.org/api/v5/addons/addon/{urllib.parse.quote(ID_FIREFOX)}/", token, cabecalho="JWT")
    print("addons.mozilla.org: credenciais OK")
    print(f"  situação: {a.get('status', '?')}  |  versão atual: {(a.get('current_version') or {}).get('version', '-')}")
    print(f"  página: {a.get('url', '-')}")


def main():
    acao = sys.argv[1] if len(sys.argv) > 1 else ""
    if acao == "chrome-publicar" and len(sys.argv) == 3:
        chrome_publicar(sys.argv[2])
    elif acao == "chrome-conferir":
        chrome_conferir()
    elif acao == "firefox-conferir":
        firefox_conferir()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
