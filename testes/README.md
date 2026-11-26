# Testes do Dealer/Fluxo

Testes automáticos que entram no portal DealerNet de verdade e usam o Dealer/Fluxo como um usuário:
abrem telas pelos menus, clicam na barra, usam os atalhos, arrastam janelas com o mouse, etc.
Rode sempre que mudar o `userscript.js`.

## Rodar

```
DN_URL=https://<empresa>.dealernetworkflow.com.br/ DN_USUARIO=seu.usuario DN_SENHA='sua senha' python3 testes/testar.py
```

Sem as variáveis, o usuário e a senha são pedidos no terminal. Nunca grave a senha num arquivo.

Por padrão roda tudo em duas telas: **1280x620** (o que sobra para a página numa tela 720p, descontando as
abas e a barra de endereço) e **1920x960**. Leva uns 6 minutos por tela.

| Opção | Para quê |
|---|---|
| `--tela 1366x650` | Outro tamanho (pode repetir a opção) |
| `--so atalhos,layout_barra` | Só alguns testes (`--lista` mostra os nomes) |
| `--extensao` | Testa a extensão em `extensao/build/chrome-teste` (rode `python3 extensao/build.py` antes). Inclui o teste `outro_dominio` |
| `--navegador firefox` | Roda no Firefox do Playwright (`playwright install firefox`). Com `--extensao`, usa `extensao/build/firefox-teste`, instalada como extensão temporária |
| `--mostrar` | Abre o navegador na tela para acompanhar |

Precisa do Python com Playwright (`pip install playwright`). Usa o Chromium do sistema se existir, senão o do
Playwright (`playwright install chromium`).

Para conferir tudo antes de lançar uma versão:

```
python3 extensao/build.py
python3 testes/testar.py --extensao --tela 1280x620
python3 testes/testar.py --extensao --tela 1280x620 --navegador firefox
python3 testes/testar.py
```

### Firefox

O Playwright não abre extensões no Firefox do jeito que abre no Chromium. Os testes instalam a extensão
como "temporária" pelo protocolo de depuração do Firefox (`testes/firefox_rdp.py`, o mesmo que o `web-ext`
usa). O Playwright também não abre as páginas `moz-extension://`, então no Firefox o teste `outro_dominio`
faz o que o popup e as configurações fazem chamando o fundo da extensão diretamente (a parte visual do popup
é testada no Chromium, o código é o mesmo). O teste `indicador_carregamento` é pulado no Firefox porque só o
Chromium simula rede lenta.

## O que é testado

`python3 testes/testar.py --lista` mostra a lista atualizada. Resumindo:

- carregamento e layout da barra (inclusive se os itens da barra de status continuam visíveis, se o sino fica ao lado de "Minimiza todas janelas" no
  alto e se a engrenagem está compacta);
- aviso de boas-vindas e janelas de configuração **cabendo na tela**, com os botões visíveis;
- alternar, minimizar/restaurar (contador "Minimizadas"), duplicar, fechar com o botão do meio e reabrir;
- atalhos de teclado com o cursor dentro das telas;
- menu de contexto (ícones, alinhamento, fecha ao clicar dentro de uma tela);
- arrastar e redimensionar rápido soltando o mouse sobre outra janela;
- botão "Início" (aparência e função) e indicador de carregamento (com rede lenta simulada), inclusive ao gerar um
  relatório (Financeiro > Relatórios > Contas a Receber > Títulos Emitidos a Receber);
- avisos das telas (mensagens em vermelho do GeneXus): cartão no meio com "Copiar erro(s)" e "Fechar" à direita,
  clicar fecha, mouse em cima pausa, vai para a pílula "Aviso" depois de 3 s, tempo configurável, opção para desligar;
- busca nas listas de opções: lista longa (simulada na tela de Pessoas) abre com campo de busca que tolera erros de
  digitação e acentos; Enter, clique e F4; Esc fecha sem mudar; lista com até 5 opções e opção desligada ficam normais;
- notificação de fluxos: tarefas e troca de filtros não geram aviso, aumento gera; aviso no canto superior direito; clicar no sino marca o fluxo; clique do meio no aviso só fecha; som (opcional) só para fluxos novos; escolha do som e volume até 200% (com aviso de risco acima de 100%);
- tema (alfa): desligado por padrão; a aba fica bloqueada até marcar o aceite de alfa, e só então aparece o menu
  Tema na engrenagem; muda na hora e Cancelar volta; depuração bloqueada até o aceite dela; fonte e tamanho com
  aceite próprio, menu Fonte na engrenagem (fonte do sistema, sem download); ícones dos menus recoloridos e sino sem a seta do tema; mantido ao
  recarregar; desmarcar o aceite volta tudo ao original;
- telemetria (`--extensao`; a build de teste manda para um servidor local na porta 8766, nunca para o real):
  conta trocas de tema pelo menu, envia só os campos da lista (sem usuário, empresa, endereços, páginas),
  não repete o mesmo dia, prévia na aba Privacidade, imagens sem ícone (opt-in) uma vez só (no Firefox, exige a
  permissão do navegador), desligar apaga o pendente e não envia mais nada;
- tela de login (`--extensao`, último teste porque abrir o login pode encerrar a sessão): abre já com o tema
  escolhido, e o Dealer/Fluxo não roda nela;
- extensão (`--extensao`): portal em outro endereço. Um proxy local (`testes/proxy_portal.py`) mostra o portal em
  `http://dealer-teste.localhost:8765`; o teste ativa o Dealer/Fluxo pelo popup, usa a barra, confere a página de
  configurações e remove o site. A versão de teste da extensão já tem permissão para todos os sites, porque os
  testes não conseguem clicar no pedido de permissão do navegador;
- aviso: X, contagem regressiva, pausa com o mouse, clicar ao lado do texto só fecha, clicar no texto abre o fluxo.

## Segurança

- Só abre telas de consulta (Cadastro > Pessoas, CRM > Pesquisas) e o cadastro de uma pessoa sem salvar, e gera
  o relatório de Títulos Emitidos a Receber (só leitura).
- Os fluxos que os testes marcam na Caixa de Entrada são desmarcados no final de cada teste.
- O "aumento" de fluxos é simulado mudando o número só na página deste navegador. Nada vai para o servidor.
- Usa um perfil temporário do navegador, apagado no final. Suas configurações do Dealer/Fluxo não mudam.

## Quando um teste falha

O terminal mostra o motivo, e uma captura da tela no momento da falha fica em
`testes/resultados/<data-hora>/`. Se tudo passar, a pasta é apagada.

O que **não** é testado (precisaria mudar configurações da sua conta no servidor): workspaces, e trocar o
tema do portal. Para testar outro tema, mude o tema na sua conta e rode os testes de novo; eles medem
posições e tamanhos em vez de comparar imagens, então funcionam em qualquer tema.

## No GitHub Actions

O workflow `.github/workflows/testes.yml` roda a cada push na `main` (e pelo botão *Run workflow* na aba Actions):

- **verificar**: build, validação do pacote do Firefox (`web-ext lint`) e sintaxe. Não usa o DealerNet.
- **dealernet**: todos os testes, no Chromium e no Firefox, com a **conta de testes** (usuário com poucas
  permissões, quase tudo só leitura) dos segredos do repositório `DN_URL`, `DN_USUARIO` e `DN_SENHA`
  (*Settings > Secrets and variables > Actions*). Forks e pull requests de fora não recebem os segredos.
  Testes que dependem de algo que a conta não tem (menu Financeiro, aba Definições) usam outra tela ou pulam
  essa parte.

Para nada do portal ir parar no registro dos testes (que é público se o repositório for público), no CI as
mensagens são editadas antes de impressas: endereço do portal, nome da empresa e usuário viram `[portal]`,
`[empresa]` e `[usuario]`, números com 5 ou mais dígitos viram `#####`, o "Call log" do Playwright (que traz
HTML da tela) é cortado e textos dentro de HTML viram `…`. As capturas das falhas (`testes/resultados/`) não
são publicadas. Para ver tudo numa execução, defina `DN_LOG_COMPLETO=1`. A extensão dos testes manda as
estatísticas para um servidor local do próprio teste, nunca para o servidor de verdade.
