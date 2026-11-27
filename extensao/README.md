# Dealer/Fluxo (extensão para Chrome e Firefox)

Barra de tarefas, atalhos de teclado, indicador de carregamento e aviso de novos fluxos para o
DealerNet Workflow. É o mesmo código do userscript (`../userscript.js`), empacotado como extensão.

## Estrutura

| Arquivo | O que é |
|---|---|
| `../userscript.js` | **Código-fonte único.** Edite aqui; a extensão é gerada a partir dele. O trecho entre `// ==== Dealer/Tema` e `// ==== fim do Dealer/Tema ====` é copiado pelo build: não edite. |
| `../../Tema Escuro/dealer-tema.lib.js` | Motor de temas de cores (Dealer/Tema, em alfa, desligado por padrão), mantido naquela pasta (na máquina do autor; sem ela, o build usa a cópia que já está no `userscript.js`). O build copia sem alterar para dentro do `userscript.js` e para a extensão como `dealer-tema.js`. Opções em Configurações > Tema. |
| `src/` | Parte própria da extensão: `background.js` (registra o script nos portais que o usuário ativou), `popup.html` (botão da extensão), `opcoes.html` (configurações), `sites.js`/`sites.css` (usados pelos dois). |
| `loja/` | Material das lojas: `descricao-loja.txt` (descrição longa; nenhuma palavra mais de 5 vezes, para não parecer lista de palavras-chave), capturas 1280x800 (`testes/capturas_loja.py`) e imagens promocionais (`loja/gerar_promocionais.py`). |
| `gerar_pix.py` | Gera o QR code do Pix da aba "Sobre" (doação opcional) e grava no `userscript.js` entre marcadores. Precisa do `segno` (`pip install segno`) só para rodar; para trocar a chave, cole o novo "Pix copia e cola" nele e rode de novo (o CRC é conferido). |
| `build.py` | Gera as pastas `build/chrome`, `build/firefox`, `build/chrome-teste` (só para os testes automáticos; nunca publique) e os zips em `dist/`. |
| `vendor/Sortable.min.js` | SortableJS 1.15.7 oficial (cdnjs), sem alterações. SHA-256 `bf4241bc73fef7f11c59a283a69fe8051cdd31c6d8ff5a2b9ba219e7831fcf76`. Licença MIT em `vendor/Sortable.LICENSE` (vai junto na extensão). |
| `../LICENSE` | Licença do Dealer/Fluxo: GNU GPL versão 3 (`GPL-3.0-only`). Vai junto na extensão. |
| `icones/` | Ícones 16/32/48/128 px, gerados de `icones/original.png` por `gerar_icones.py` (para trocar o ícone, substitua o original e rode os dois scripts). |

## Gerar

```
python3 build.py
```

A versão vem do `@version` do cabeçalho do `userscript.js`. Para lançar uma versão nova, mude o
`@version` lá e rode o build de novo.

## DealerNet em outros endereços

O endereço padrão é `*.dealernetworkflow.com.br/Portal/default.html`. Se o DealerNet da empresa tiver outro endereço:

1. Entre no DealerNet e, na página que abre depois do login, clique no botão do Dealer/Fluxo na barra de ferramentas.
2. Clique em **Ativar Dealer/Fluxo neste site**. O navegador pede permissão só para aquele site.
3. A página recarrega já com a barra. Daí em diante o Dealer/Fluxo carrega sozinho nesse endereço.

Os sites adicionados aparecem no próprio popup e nas configurações da extensão (botão direito no ícone →
*Opções*), onde podem ser removidos. Remover devolve a permissão do site. O script só roda no caminho exato
da página onde foi ativado (ex.: `portal.exemplo.com.br/Portal/default.html`), e se a página não for a que abre depois do login
(sem `oW5Portal`/ExtJS) ele não faz nada.

## Testar sem publicar

- **Chrome/Edge:** `chrome://extensions` → ative o *Modo do desenvolvedor* → *Carregar sem compactação* → escolha `build/chrome`.
- **Firefox (128 ou mais novo):** `about:debugging#/runtime/this-firefox` → *Carregar extensão temporária...* → escolha `build/firefox/manifest.json`. (Some ao fechar o Firefox; extensões permanentes precisam ser assinadas pela Mozilla.)
- Para validar o pacote do Firefox como a loja faz: `npx web-ext lint --source-dir build/firefox`.
- Testes automáticos nos dois navegadores: veja `../testes/README.md`.

**Desinstale os scripts antigos** (DealerBarraDeTarefas, DealerNotificaFluxo e Dealer/Tema), que foram incorporados
à extensão. Se um deles estiver ativo junto com a extensão, só o primeiro a carregar roda e aparece um aviso no console.

## Como funciona (para os revisores das lojas)

- *Content script* nas páginas `*.dealernetworkflow.com.br/Portal/default.html`, rodando no contexto da página
  (`"world": "MAIN"`) porque precisa usar o ExtJS e o objeto `oW5Portal` do próprio portal.
- Um segundo *content script*, `dealer-tema.js` (temas de cores, opcional e desligado por padrão), roda em
  `document_start` na mesma página e na tela de login do DealerNet (`LoginAux.aspx`), para as duas já abrirem
  com as cores escolhidas sem piscar (o Dealer/Fluxo em si não roda no login). Ele também
  aplica as cores nas telas (iframes da mesma origem). A única requisição que ele faz é baixar uma fonte "da
  internet" (Bunny Fonts, ou Google Fonts se falhar), e só quando o usuário escolhe uma; ela fica guardada no
  navegador (Cache Storage) e não é baixada de novo.
- Permissões (justificativas para o formulário das lojas):
  - `scripting`: registrar o mesmo script nos portais DealerNet hospedados em outros endereços, que o
    usuário ativa pelo botão da extensão.
  - `activeTab`: quando o usuário clica no botão, ver o endereço da aba e se a página é o portal DealerNet,
    para oferecer a ativação.
  - `storage`: guardar a lista de endereços ativados e as estatísticas de uso do dia até serem enviadas.
  - `alarms`: conferir de hora em hora se há estatísticas de uso de dias anteriores para enviar.
  - `optional_host_permissions` (`http://*/*`, `https://*/*`): **opcional**, nada é concedido na instalação.
    A permissão de um site só é pedida quando o usuário clica em "Ativar Dealer/Fluxo neste site", e só
    para aquele site.
- Um terceiro *content script*, `telemetria-ponte.js`, roda no mundo isolado da extensão na mesma página e só
  repassa mensagens da telemetria entre a página e o `background.js`.
- **Estatísticas de uso anônimas** (ligadas por padrão, com aviso na primeira vez, desligáveis em
  Configurações > Privacidade): no máximo uma vez por dia, o `background.js` envia para
  `https://dealer-fluxo-ping.igorslime.workers.dev/ping` a versão da extensão, navegador e versão principal,
  sistema operacional, faixa da largura da tela, se o portal está no domínio padrão, altura da barra, tema,
  fonte e tamanho escolhidos e quantas vezes o tema/a fonte foram trocados. Sem identificador, IP (o servidor
  não grava) ou dado do DealerNet. Os campos passam por uma lista fixa no `background.js` (`montarPing`).
  Política: https://dealer-fluxo-ping.igorslime.workers.dev/privacidade
- **Opcional, desligado por padrão** (aba Tema): enviar para `/semicone` as imagens do site que o tema ainda não
  troca (nome do arquivo, dica sem números, nome da página), cada uma uma vez por versão do tema.
- Empresas podem desligar a telemetria para todos por política (`telemetria: false` no storage gerenciado;
  esquema em `managed_schema.json`, só no Chrome/Edge).
- Firefox: `data_collection_permissions` com `required: ["none"]` e `optional: ["technicalAndInteraction",
  "websiteContent"]` (estatísticas de uso e, se o usuário permitir nas opções da extensão, as imagens sem ícone).
  O fundo só envia o que o Firefox permite (`permissions.getAll().data_collection`). Mínimo: Firefox 140.
- Fora isso, nenhum dado sai do navegador (o pedido de uma fonte "da internet" só leva o nome dela). As configurações ficam no `localStorage` do portal.
- Nenhum código é carregado de fora; o único código de terceiros é o SortableJS oficial, sem alterações.
- O código não é minificado (exceto o SortableJS), então a Mozilla não precisa de código-fonte separado.

## Publicar

### Versão nova (automático, por tag)

1. Suba o `@version` (e `VERSAO_FLUXO`) no `userscript.js`, rode `python3 extensao/build.py` e faça o commit.
2. Crie e envie a tag com as novidades na mensagem (ela vira o texto da versão no GitHub):
   ```bash
   git tag -a v1.3.0 -m "Novidades da 1.3.0: ..."
   git push origin v1.3.0
   ```
3. O `.github/workflows/publicar.yml` roda todos os testes, gera os pacotes, confere que a tag é a versão, envia para a
   Chrome Web Store e para a addons.mozilla.org (as duas mandam para revisão e publicam sozinhas quando aprovarem) e
   cria a versão no GitHub com os dois `.zip`. Se o ambiente `lojas` pedir aprovação, aprove na aba Actions.

Capturas de tela, vídeo e textos da página continuam sendo trocados à mão nos painéis das lojas (a API da Chrome
Web Store não mexe neles).

Para conferir as chaves sem publicar nada: aba Actions > Publicar > **Run workflow** (mostra a versão publicada e a
em revisão de cada loja). Localmente: `pip install "pyjwt[crypto]"` e `python3 extensao/lojas.py chrome-conferir` /
`firefox-conferir` com as variáveis abaixo.

### Chaves (uma vez só)

Ficam no ambiente **`lojas`** do repositório (Settings > Environments > lojas). Em *Deployment protection rules*
dá para exigir a sua aprovação antes de cada envio às lojas.

- **Chrome Web Store** (conta de serviço do Google; a API v1 e o fluxo antigo com refresh token não são usados):
  1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative a **Chrome Web Store API**.
  2. Em *IAM e administrador > Contas de serviço*, crie uma conta de serviço (não precisa de papel nenhum) e, nela,
     *Chaves > Adicionar chave > JSON*. Guarde o arquivo baixado.
  3. No [painel da Chrome Web Store](https://chrome.google.com/webstore/devconsole), em **Conta**, adicione o e-mail da
     conta de serviço (só uma por editor).
  4. No mesmo painel, *Publisher > Settings*: copie o **ID do editor**.
  5. No GitHub: segredo `CWS_CONTA_SERVICO` = o conteúdo inteiro do JSON; variável `CWS_PUBLISHER_ID` = o ID do editor.
     ```bash
     gh secret set CWS_CONTA_SERVICO --env lojas < chave-da-conta-de-servico.json
     gh variable set CWS_PUBLISHER_ID --env lojas --body "<ID do editor>"
     ```
     Depois apague o JSON do computador.
- **addons.mozilla.org**: no [Developer Hub](https://addons.mozilla.org/developers/addon/api/key/), gere a chave da
  API (*JWT issuer* e *JWT secret*) e grave:
  ```bash
  gh secret set AMO_JWT_ISSUER --env lojas
  gh secret set AMO_JWT_SECRET --env lojas
  ```
- A API da Chrome Web Store só atualiza itens que já existem e publica com a visibilidade salva no painel: se a
  visibilidade for mudada à mão, a próxima publicação precisa ser feita à mão uma vez.

### Primeira publicação e textos das lojas

- **Chrome Web Store:** conta de desenvolvedor (taxa única), envie `dist/dealer-fluxo-chrome-<versão>.zip`.
  Na descrição, mencione a doação opcional: "Na aba Sobre há a opção de doar por Pix;
  nada depende disso." No formulário: finalidade única = "melhorar a interface do portal DealerNet Workflow". Em *Privacidade*:
  política em https://dealer-fluxo-ping.igorslime.workers.dev/privacidade; declarar a coleta de dados de uso
  anônimos ("Atividade do usuário"/estatísticas de uso, sem identificar o usuário, não vendidos, não usados para
  outra finalidade) e, opcional, "conteúdo do site" (nomes das imagens sem ícone). Justificar `alarms` como acima.
- **Licença** (as duas lojas): GNU General Public License v3.0 only.
- **Firefox (addons.mozilla.org):** envie `dist/dealer-fluxo-firefox-<versão>.zip`. O campo "Contributions URL"
  do AMO só aceita alguns serviços (PayPal, Ko-fi, Buy Me a Coffee...), não Pix: a doação fica só dentro da extensão. Na descrição da página,
  diga o que é enviado (o mesmo texto da política de privacidade) e informe a URL da política. O ID
  `dealerfluxo@igorslime` (`ID_FIREFOX` em `build.py`) liga as atualizações à mesma extensão. Troque antes
  da primeira publicação se quiser, mas **nunca depois**.
- Na Chrome Web Store, `optional_host_permissions` amplo costuma passar por revisão mais detalhada; use as
  justificativas acima.
- O nome "DealerNet" é marca da DealerNet. O nome "Dealer/Fluxo" e a descrição dizem "não oficial", o que
  costuma ser aceito, mas as lojas podem pedir ajustes no nome ou nos ícones.
