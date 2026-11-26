# Servidor de estatísticas (dealer-fluxo-ping)

Recebe as estatísticas de uso anônimas da extensão Dealer/Fluxo (Cloudflare Worker + banco D1, plano gratuito).
Este é o código que está no ar em `https://dealer-fluxo-ping.igorslime.workers.dev`; todo o código está em
`src/index.js`.

- `POST /ping`: `{"versao": "1.2.1", "navegador": "chrome 142", "dia": "AAAA-MM-DD", "dados": { ... }}`, no máximo
  um por instalação por dia.
- `POST /semicone`: imagens que o tema ainda não troca (opcional, desligado por padrão).
- `GET /privacidade`: política de privacidade.
- Respostas: 204 gravado, 400 formato inválido, 413 maior que o limite, 404 outro caminho ou método, 503 limite
  de gravações do minuto atingido (a extensão tenta de novo depois).

O que o servidor garante (e os testes em `test/` conferem):

- **Grava só** dia (horário de Brasília), versão, navegador e, de `dados`, apenas os campos e valores que a
  extensão manda (`dadosLimpos()`); qualquer outra coisa é descartada. Tabelas em `schema.sql`.
- **Não lê o IP nem a localização** (`CF-Connecting-IP`, `request.cf`), e os registros de acesso da Cloudflare
  estão desligados (`observability.enabled: false` no `wrangler.jsonc`).
- **Sem identificador:** não há como ligar dois envios à mesma pessoa; "linhas por dia" = instalações no dia.
- **Nenhum caminho devolve dados gravados.** Os dados só saem com o login do desenvolvedor na Cloudflare.
- Consultas sempre com parâmetros; limite de tamanho do corpo; limite geral de gravações por minuto (sem IP).

## Comandos

```bash
npm ci                             # dependências (uma vez)
npx vitest run                     # testes (banco local, não mexe no de verdade)
npx wrangler deploy                # publicar mudanças no src/index.js
npx wrangler d1 execute dealer-fluxo-pings --remote --file=schema.sql   # criar a tabela (já feito)
```

## Relatório pronto

`python3 relatorio.py` mostra no terminal as instalações por dia, o retrato do último dia (versões, navegadores,
sistema, tela, tema, fonte), o uso dos menus e as imagens sem ícone. Opções: `--dias 7`, `--semicone` (todas as
versões do tema), `--json arquivo.json`. Só lê o banco.

## Consultas (terminal: `npx wrangler d1 execute dealer-fluxo-pings --remote --command "..."`, ou no painel: Storage & Databases → D1 → dealer-fluxo-pings → Console)

```sql
-- usuários por dia
SELECT dia, COUNT(*) AS usuarios FROM pings GROUP BY dia ORDER BY dia DESC LIMIT 30;

-- versões em uso nos últimos 7 dias
SELECT versao, COUNT(*) FROM pings WHERE dia >= date('now', '-7 day') GROUP BY versao ORDER BY 2 DESC;

-- navegadores nos últimos 30 dias
SELECT navegador, COUNT(*) FROM pings WHERE dia >= date('now', '-30 day') GROUP BY navegador;

-- um contador ou configuração dentro do JSON (nomes definidos na extensão)
SELECT dia, SUM(json_extract(dados, '$.atalhos')) FROM pings GROUP BY dia ORDER BY dia DESC;
SELECT json_extract(dados, '$.tema') AS tema, COUNT(*) FROM pings WHERE dia = date('now', '-1 day') GROUP BY tema;
```

## Imagens sem ícone (relatos opt-in da aba Tema)

Tabela `semicone`: uma linha por imagem e versão do tema, com quantas instalações reportaram (`relatos`).
Cada instalação reporta cada imagem uma vez por versão do tema, e só o que aquela versão ainda não troca.
Imagens reportadas numa versão antiga e não na mais nova provavelmente já foram resolvidas.

```sql
-- versões do tema que já mandaram relatos (a mais recente em cima)
SELECT versao_tema, COUNT(*) AS imagens, SUM(relatos) AS relatos, MAX(ultimo_dia) AS ultimo
FROM semicone GROUP BY versao_tema ORDER BY ultimo DESC;

-- o que falta na versão mais recente: "sem regra" primeiro (falta tudo), depois as mais vistas
SELECT arquivo, situacao, relatos, dica, tela, ultimo_dia
FROM semicone
WHERE versao_tema = (SELECT versao_tema FROM semicone ORDER BY ultimo_dia DESC LIMIT 1)
ORDER BY situacao = 'rótulo deduzido', relatos DESC, arquivo;

-- o mesmo para uma versão específica
SELECT arquivo, situacao, relatos, dica, tela FROM semicone WHERE versao_tema = '1.16.3'
ORDER BY situacao = 'rótulo deduzido', relatos DESC;

-- no formato da lista "Imagens sem ícone" da extensão (arquivo | dica | tela | situação), para colar para o tema
SELECT arquivo || ' | ' || dica || ' | ' || tela || ' | ' || situacao FROM semicone
WHERE versao_tema = (SELECT versao_tema FROM semicone ORDER BY ultimo_dia DESC LIMIT 1)
ORDER BY situacao = 'rótulo deduzido', relatos DESC;
```

No terminal, `--json` devolve as linhas em JSON (bom para salvar num arquivo):
`npx wrangler d1 execute dealer-fluxo-pings --remote --json --command "SELECT ..." > semicone.json`

