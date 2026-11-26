#!/usr/bin/env python3
"""
Relatório das estatísticas do Dealer/Fluxo guardadas no D1 (dealer-fluxo-pings), no terminal.

    python3 relatorio.py                 # últimos 30 dias + imagens sem ícone da versão mais nova do tema
    python3 relatorio.py --dias 7
    python3 relatorio.py --semicone      # só as imagens sem ícone (todas as versões do tema)
    python3 relatorio.py --json dados.json   # também grava o que baixou, para abrir em outro lugar

Usa o wrangler desta pasta (npx wrangler, já logado na conta da Cloudflare). Só lê: nada é alterado no banco.
Cada linha de "pings" é uma instalação num dia (sem identificador), então "instalações" num dia = linhas do dia.
"""
import argparse, collections, json, os, re, subprocess, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
BANCO = "dealer-fluxo-pings"


CONTROLE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def limpo(valor):
    """Tira caracteres de controle de tudo o que veio do banco (um envio falso não mexe no terminal)."""
    if isinstance(valor, str):
        return CONTROLE.sub(" ", valor)
    if isinstance(valor, list):
        return [limpo(v) for v in valor]
    if isinstance(valor, dict):
        return {limpo(k): limpo(v) for k, v in valor.items()}
    return valor


def consultar(sql):
    r = subprocess.run(["npx", "wrangler", "d1", "execute", BANCO, "--remote", "--json", "--command", sql],
                       cwd=AQUI, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"wrangler falhou:\n{r.stderr or r.stdout}\n(faça login com: npx wrangler login)")
    return limpo(json.loads(r.stdout)[0]["results"])


def barra(n, maximo, largura=30):
    return "█" * max(1 if n else 0, round(n / maximo * largura)) if maximo else ""


def tabela(titulo, contagem, total=None, limite=15):
    if not contagem:
        return
    total = total or sum(contagem.values())
    maximo = max(contagem.values())
    print(f"\n  {titulo}")
    for chave, n in contagem.most_common(limite):
        print(f"    {str(chave):<22} {n:>5}  {n / total:>4.0%}  {barra(n, maximo, 24)}")
    if len(contagem) > limite:
        print(f"    ... e mais {len(contagem) - limite}")


def secao(texto):
    print(f"\n{'=' * 78}\n{texto}\n{'=' * 78}")


def pings(dias):
    linhas = consultar(f"SELECT dia, versao, navegador, dados FROM pings WHERE dia >= date('now', '-{dias} day') ORDER BY dia")
    for l in linhas:
        try:
            l["dados"] = limpo(json.loads(l["dados"]))
            if not isinstance(l["dados"], dict):
                l["dados"] = {}
        except Exception:
            l["dados"] = {}

    secao(f"INSTALAÇÕES ATIVAS POR DIA (últimos {dias} dias; cada dia só chega depois que termina)")
    por_dia = collections.Counter(l["dia"] for l in linhas)
    if not por_dia:
        print("\n  Nenhum ping no período.")
        return linhas
    maximo = max(por_dia.values())
    for dia in sorted(por_dia):
        print(f"  {dia}  {por_dia[dia]:>5}  {barra(por_dia[dia], maximo)}")

    ultimo = max(por_dia)
    do_dia = [l for l in linhas if l["dia"] == ultimo]
    d = lambda chave: collections.Counter(str(l["dados"].get(chave, "?")) for l in do_dia)
    secao(f"RETRATO DO ÚLTIMO DIA ({ultimo}, {len(do_dia)} instalações)")
    tabela("Versão da extensão", collections.Counter(l["versao"] for l in do_dia))
    tabela("Navegador", collections.Counter(l["navegador"].split(" ")[0] for l in do_dia))
    tabela("Navegador e versão", collections.Counter(l["navegador"] for l in do_dia), limite=8)
    tabela("Sistema", d("sistema"))
    tabela("Largura da tela", d("tela"))
    tabela("Endereço do portal", d("dominio"))
    tabela("Altura da barra (px)", d("alturaBarra"))
    tabela("Tema de cores", d("tema"))
    tabela("Fonte", d("fonte"))
    tabela("Tamanho do texto (%)", d("tamanho"))
    tabela("Trocar imagens por ícones", d("imagens"))
    tabela("Versão do Dealer/Tema", d("versaoTema"))

    secao(f"USO NO PERÍODO (soma dos contadores; instalações-dia que usaram)")
    soma, quem = collections.Counter(), collections.Counter()
    for l in linhas:
        for nome, n in (l["dados"].get("uso") or {}).items():
            soma[nome] += n
            quem[nome] += 1
    nomes = {"temaMenu": "Tema escolhido pelo menu", "fonteMenu": "Fonte escolhida pelo menu",
             "temaConfig": "Tema salvo nas configurações", "fonteConfig": "Fonte salva nas configurações"}
    if not soma:
        print("\n  Ninguém usou os menus de tema/fonte no período.")
    for nome, n in soma.most_common():
        print(f"  {nomes.get(nome, nome):<32} {n:>5} vezes, em {quem[nome]} instalações-dia")
    tema_ligado = sum(1 for l in linhas if l["dados"].get("tema") not in (None, "off"))
    print(f"\n  Instalações-dia com tema de cores ligado: {tema_ligado} de {len(linhas)} ({tema_ligado / len(linhas):.0%})")
    return linhas


def semicone(todas):
    resumo = consultar("SELECT versao_tema, COUNT(*) AS imagens, SUM(relatos) AS relatos, MAX(ultimo_dia) AS ultimo "
                       "FROM semicone GROUP BY versao_tema ORDER BY ultimo DESC")
    secao("IMAGENS SEM ÍCONE (relatos opt-in da aba Tema)")
    if not resumo:
        print("\n  Nenhum relato ainda.")
        return []
    print(f"\n  {'Versão do tema':<16}{'imagens':>8}{'relatos':>9}  último relato")
    for r in resumo:
        print(f"  {r['versao_tema']:<16}{r['imagens']:>8}{r['relatos']:>9}  {r['ultimo']}")
    versoes = [r["versao_tema"] for r in resumo] if todas else [resumo[0]["versao_tema"]]
    versoes = [v for v in versoes if re.fullmatch(r"\d+\.\d+\.\d+", str(v))]   # só formato de versão entra na consulta
    itens = []
    for v in versoes:
        lista = consultar(f"SELECT arquivo, situacao, dica, tela, relatos, primeiro_dia, ultimo_dia FROM semicone "
                          f"WHERE versao_tema = '{v}' ORDER BY relatos DESC, arquivo")
        itens += [{**i, "versao_tema": v} for i in lista]
        print(f"\n  Versão {v}: {len(lista)} imagens (mais relatadas primeiro)")
        print(f"    {'relatos':>7}  {'arquivo':<34}{'tela':<28}{'situação':<17}dica")
        for i in lista:
            print(f"    {i['relatos']:>7}  {i['arquivo'][:33]:<34}{i['tela'][:27]:<28}{i['situacao']:<17}{i['dica']}")
    return itens


def main():
    ap = argparse.ArgumentParser(description="Relatório das estatísticas do Dealer/Fluxo (D1 da Cloudflare)")
    ap.add_argument("--dias", type=int, default=30, help="quantos dias para trás (padrão 30)")
    ap.add_argument("--semicone", action="store_true", help="só as imagens sem ícone, de todas as versões do tema")
    ap.add_argument("--json", metavar="ARQUIVO", help="grava também os dados baixados em JSON")
    a = ap.parse_args()
    saida = {}
    if not a.semicone:
        saida["pings"] = pings(max(1, a.dias))
    saida["semicone"] = semicone(todas=a.semicone)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(saida, f, ensure_ascii=False, indent=1)
        print(f"\nDados gravados em {a.json}")


if __name__ == "__main__":
    main()
