// ==UserScript==
// @name         DealerBarraDeTarefas
// @version      1.3.0
// @description  Dealer/Fluxo: barra de tarefas com as janelas abertas no DealerNet, atalhos de teclado, indicador de carregamento, notificação de novos fluxos e temas de cores (alfa).
// @author       Igor Lima
// @match        *://*/Portal/default.html*
// @match        *://*/LoginAux.aspx*
// @require      https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.7/Sortable.js
// @grant        none
// @run-at       document-start
// @license      GPL-3.0-only
// ==/UserScript==

/*
    Dealer/Fluxo
    Copyright (C) 2026 Igor Lima

    Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo sob os termos da GNU General
    Public License versão 3, publicada pela Free Software Foundation.

    Este programa é distribuído na esperança de que seja útil, mas SEM NENHUMA GARANTIA, nem mesmo a garantia
    implícita de COMERCIALIZAÇÃO ou de ADEQUAÇÃO A UM PROPÓSITO ESPECÍFICO. Veja a GNU General Public License
    para mais detalhes. Você deve ter recebido uma cópia dela junto com este programa (arquivo LICENSE); se não,
    veja <https://www.gnu.org/licenses/>.

    Inclui o SortableJS (licença MIT, em vendor/Sortable.LICENSE) e o Dealer/Tema (do mesmo autor).
*/

/*
    Código-fonte da extensão Dealer/Fluxo (Chrome e Firefox): extensao/build.py gera a extensão a partir
    deste arquivo (o cabeçalho acima só fornece nome, versão e descrição). Não é publicado como userscript.
*/

/*
    Este código foi gerado por um modelo de IA. Embora tenha sido projetado para ser funcional,
    pode ser necessário realizar uma revisão, testes ou modificações para atender às suas necessidades específicas.
    Verifique o código quanto à correção e adequação antes de utilizá-lo em ambientes de produção.
*/

/*
    Dealer/Fluxo (antigos DealerBarraDeTarefas + DealerNotificaFluxo)

    Como funciona:
    O portal do DealerNet (W5Portal.js, ExtJS 3.4) já guarda tudo o que a barra precisa:
      - oW5Portal.windows         -> lista das janelas (Ext.Window) abertas
      - Ext.WindowMgr             -> controla qual janela fica na frente (z-index) e qual está ativa
      - oW5Portal.minimizeWindow  -> minimiza e cria o item no menu "Minimizadas (x)"
      - oW5Portal.createWindow    -> abre uma janela nova (usado para duplicar e reabrir)
    Em vez de mexer em z-index, posição ou clonar o HTML das janelas, o script só chama essas funções
    do próprio portal. Assim as janelas duplicadas são janelas de verdade.

    Cada tela fica num iframe do mesmo domínio do portal. O script "instrumenta" esses iframes
    (e os iframes dentro deles) para:
      - ouvir os atalhos de teclado mesmo quando o foco está dentro da tela;
      - contar as requisições (XMLHttpRequest/fetch) e navegações em andamento, para mostrar
        o indicador de carregamento no botão da janela;
      - fechar os menus abertos quando o usuário clica dentro de uma tela.

    Notificação de fluxos: a tela inicial (WP_Fluxo.aspx, no fundo do portal) lista os fluxos com a
    quantidade pendente, ex.: "Agendamento da Oficina (85)". O script lê só essas linhas (não as
    tarefas dentro delas, como "Confirmar (76)"), identifica cada fluxo pelo código do processo
    (ex.: FLX_AGENDAMENTO), atualiza a tela de tempos em tempos e avisa quando a quantidade aumenta.
*/

/* global Ext, oW5Portal, Sortable */
/* eslint-disable no-multi-spaces */

// Tema de cores (Dealer/Tema, em alfa, desligado por padrão). Biblioteca separada, mantida na pasta
// "Tema Escuro"; o trecho abaixo é copiado de lá por extensao/build.py. Na extensão ele é um content script
// próprio (dealer-tema.js) e este trecho não vai junto. As opções ficam em Configurações > Tema.
// ==== Dealer/Tema (gerado a partir de ../Tema Escuro/dealer-tema.lib.js, não editar aqui) ====
// Dealer/Tema 1.17.9 — biblioteca de temas de cores para o DealerNet Workflow.
// Usada só embutida no Dealer/Fluxo (não é um userscript instalável sozinho). Fonte única: este arquivo,
// copiado sem alterações para dentro do Dealer/Fluxo pelo build dele. Como integrar e a API
// (window.DealerTema): INTEGRACAO-DEALER-FLUXO.md. Precisa rodar em document-start no Portal/default.html, no LoginAux.aspx (tela de login) e no wp_esqueciminhasenha.aspx.

/*
 * Como funciona
 * -------------
 * O DealerNet (portal ExtJS + telas GeneXus em iframes) não usa variáveis CSS, então o tema é feito
 * "traduzindo" as cores do próprio site para a paleta do esquema escolhido:
 *   - cada folha de estilo do site ganha, logo depois dela, uma cópia só com as propriedades de cor
 *     traduzidas (mesmos seletores, mesma ordem: a cascata original é preservada);
 *   - cores em atributos style="" / bgcolor (o GeneXus pinta muita coisa assim) são traduzidas no
 *     próprio elemento, e um MutationObserver acompanha o que o site muda depois;
 *   - imagens de fundo que são só degradês/texturas do tema cinza (barras, botões, cabeçalhos) são
 *     removidas, para a cor de fundo traduzida aparecer.
 * Tradução: cinzas viram a "rampa" do esquema (branco -> fundo, cinza claro -> superfície, ...,
 * preto -> texto), e cores saturadas viram a cor do esquema de matiz mais próximo (vermelho, laranja,
 * amarelo, verde, ciano, azul, magenta), preservando o significado das cores do site (legendas etc.).
 *
 * O script roda em todas as janelas/iframes do site (cada tela é um iframe da mesma origem); a escolha
 * fica no localStorage do site e as outras janelas percebem a mudança pelo evento "storage".
 */
(function () {
// ---- opções fixas ------------------------------------------------------------------------------------
// O site "desativa" muitos botões só escondendo (display:none / visibility:hidden). O botão novo segue o
// original e também fica escondido. true = mostra assim mesmo (tracejado e esmaecido), para depuração:
// cuidado, o clique continua indo para o botão original, que o usuário não deveria usar.
// Também dá para ligar sem mexer aqui, pela config "ocultos" (DealerTema.definir({ ocultos: true })).
const DEALER_TEMA_MOSTRAR_BOTOES_OCULTOS = false;

'use strict';
function dealerTema(window, document) {
    const localStorage = window.localStorage;
    // Já rodando neste documento (userscript + extensão). A marca fica no document, não no window: a
    // janela de um iframe novo (about:blank) é reaproveitada quando ele navega para a tela.
    if (document.__dealerTema || window.location.protocol === 'about:') return;
    document.__dealerTema = true;

    const VERSAO = '1.17.9';
    const CHAVE = 'DealerTema.config';
    const PREFIXO = 'dealer-tema';

    // Palmeiras em silhueta (fundo do esquema 'vice'): duas palmeiras desenhadas aqui, sem imagem externa e sem contorno
    // (só preenchimento, pouco mais clara que o fundo). Cada folha é uma curva com folíolos dos dois lados, caindo com a gravidade.
    function palmeirasSvg(cor, espelhar) {
      const f1 = n => n.toFixed(1);
      const palmeira = (x, base, alt, incl, esc) => {
        const tx = x + incl, ty = base - alt, w0 = 7 * esc, w1 = 3.2 * esc;
        let d = `M${f1(x - w0)} ${base}C${f1(x - w0 + incl * .2)} ${f1(base - alt * .45)} ${f1(tx - w1 - incl * .15)} ${f1(ty + alt * .3)} ${f1(tx - w1)} ${f1(ty)}`
          + `L${f1(tx + w1)} ${f1(ty)}C${f1(tx + w1 - incl * .1)} ${f1(ty + alt * .3)} ${f1(x + w0 + incl * .25)} ${f1(base - alt * .45)} ${f1(x + w0)} ${base}Z`;
        let raque = '';
        // folhas: ângulo de saída, comprimento, caimento da ponta
        const folhas = [[-176, 175, 120], [-158, 165, 70], [-132, 135, 30], [-100, 95, 15], [-70, 115, 25], [-42, 150, 50], [-18, 170, 95], [-2, 160, 135],
          [165, 140, 150], [20, 135, 155], [125, 90, 120], [60, 95, 115]];
        for (const [ang, comp, cai] of folhas) {
          const a = ang * Math.PI / 180, L = comp * esc, C = cai * esc;
          const p0 = [tx, ty], p2 = [tx + Math.cos(a) * L, ty + Math.sin(a) * L + C];
          const p1 = [tx + Math.cos(a) * L * .55, ty + Math.sin(a) * L * .55 - 38 * esc];
          const B = t => [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];
          raque += `M${f1(p0[0])} ${f1(p0[1])}Q${f1(p1[0])} ${f1(p1[1])} ${f1(p2[0])} ${f1(p2[1])}`;
          const n = 22;
          for (let i = 1; i <= n; i++) {
            const t = i / (n + 1), [px, py] = B(t), [qx, qy] = B(Math.min(1, t + .045));
            let dx = qx - px, dy = qy - py; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
            const len = (58 - 40 * t) * esc * (0.85 + 0.15 * Math.sin(i * 2.3));
            for (const lado of [1, -1]) {
              // folíolo: aponta para fora e para trás/baixo (gravidade)
              let ox = -dy * lado, oy = dx * lado;
              let vx = ox * .55 + dx * .5, vy = oy * .55 + dy * .5 + .75; const vm = Math.hypot(vx, vy); vx /= vm; vy /= vm;
              const ex = px + vx * len, ey = py + vy * len;
              d += `M${f1(px - dx * 3 * esc)} ${f1(py - dy * 3 * esc)}Q${f1((px + ex) / 2 + ox * 3 * esc)} ${f1((py + ey) / 2 + oy * 3 * esc)} ${f1(ex)} ${f1(ey)}L${f1(px + dx * 4.5 * esc)} ${f1(py + dy * 4.5 * esc)}Z`;
            }
          }
        }
        const cocos = `<circle cx="${f1(tx - 4 * esc)}" cy="${f1(ty + 6 * esc)}" r="${f1(4 * esc)}"/><circle cx="${f1(tx + 4 * esc)}" cy="${f1(ty + 7 * esc)}" r="${f1(4 * esc)}"/><circle cx="${f1(tx)}" cy="${f1(ty + 10 * esc)}" r="${f1(3.5 * esc)}"/>`;
        return `<path d="${d}"/><path d="${raque}" fill="none" stroke="${cor}" stroke-width="${f1(2.4 * esc)}" stroke-linecap="round"/>${cocos}`;
      };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560"><g fill="${cor}"` + (espelhar ? ' transform="translate(560 0) scale(-1 1)"' : '') + '>'
        + palmeira(120, 560, 440, 60, 1.15) + palmeira(330, 560, 300, -40, .85) + '</g></svg>';
      return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    }

    // ------------------------------------------------------------------------------------------------
    // Esquemas de cores. Rampa: fundo -> superficie -> elevado -> borda -> apagado -> texto.
    // ------------------------------------------------------------------------------------------------
    const ESQUEMAS = {
        // ---- escuros ----
        'dracula': { nome: 'Dracula', escuro: true,
            fundo: '#282a36', superficie: '#2f3141', elevado: '#3b3e51', borda: '#4f5370', apagado: '#7c86b4', texto: '#f8f8f2',
            vermelho: '#ff5555', laranja: '#ffb86c', amarelo: '#f1fa8c', verde: '#50fa7b', ciano: '#8be9fd', azul: '#bd93f9', magenta: '#ff79c6' },
        'nord': { nome: 'Nord', escuro: true,
            fundo: '#2e3440', superficie: '#3b4252', elevado: '#434c5e', borda: '#4c566a', apagado: '#8a96ad', texto: '#eceff4',
            vermelho: '#bf616a', laranja: '#d08770', amarelo: '#ebcb8b', verde: '#a3be8c', ciano: '#88c0d0', azul: '#81a1c1', magenta: '#b48ead' },
        'gruvbox-dark': { nome: 'Gruvbox Dark', escuro: true,
            fundo: '#282828', superficie: '#32302f', elevado: '#3c3836', borda: '#504945', apagado: '#928374', texto: '#ebdbb2',
            vermelho: '#fb4934', laranja: '#fe8019', amarelo: '#fabd2f', verde: '#b8bb26', ciano: '#8ec07c', azul: '#83a598', magenta: '#d3869b' },
        'solarized-dark': { nome: 'Solarized Dark', escuro: true,
            fundo: '#002b36', superficie: '#073642', elevado: '#0e4351', borda: '#24525e', apagado: '#657b83', texto: '#93a1a1',
            vermelho: '#dc322f', laranja: '#cb4b16', amarelo: '#b58900', verde: '#859900', ciano: '#2aa198', azul: '#268bd2', magenta: '#d33682' },
        'catppuccin-mocha': { nome: 'Catppuccin Mocha', escuro: true,
            fundo: '#1e1e2e', superficie: '#28283a', elevado: '#313244', borda: '#45475a', apagado: '#7f849c', texto: '#cdd6f4',
            vermelho: '#f38ba8', laranja: '#fab387', amarelo: '#f9e2af', verde: '#a6e3a1', ciano: '#94e2d5', azul: '#89b4fa', magenta: '#cba6f7' },
        'tokyo-night': { nome: 'Tokyo Night', escuro: true,
            fundo: '#1a1b26', superficie: '#1f2335', elevado: '#292e42', borda: '#3b4261', apagado: '#737aa2', texto: '#c0caf5',
            vermelho: '#f7768e', laranja: '#ff9e64', amarelo: '#e0af68', verde: '#9ece6a', ciano: '#7dcfff', azul: '#7aa2f7', magenta: '#bb9af7' },
        'one-dark': { nome: 'One Dark', escuro: true,
            fundo: '#282c34', superficie: '#2c313a', elevado: '#353b45', borda: '#3e4451', apagado: '#7f848e', texto: '#abb2bf',
            vermelho: '#e06c75', laranja: '#d19a66', amarelo: '#e5c07b', verde: '#98c379', ciano: '#56b6c2', azul: '#61afef', magenta: '#c678dd' },
        'monokai': { nome: 'Monokai', escuro: true,
            fundo: '#272822', superficie: '#2f302a', elevado: '#3e3d32', borda: '#49483e', apagado: '#8f8a72', texto: '#f8f8f2',
            vermelho: '#f92672', laranja: '#fd971f', amarelo: '#e6db74', verde: '#a6e22e', ciano: '#a1efe4', azul: '#66d9ef', magenta: '#ae81ff' },
        'github-dark': { nome: 'GitHub Dark', escuro: true,
            fundo: '#0d1117', superficie: '#161b22', elevado: '#21262d', borda: '#30363d', apagado: '#8b949e', texto: '#e6edf3',
            vermelho: '#ff7b72', laranja: '#ffa657', amarelo: '#d29922', verde: '#3fb950', ciano: '#39c5cf', azul: '#58a6ff', magenta: '#bc8cff' },
        'rose-pine': { nome: 'Rosé Pine', escuro: true,
            fundo: '#191724', superficie: '#1f1d2e', elevado: '#26233a', borda: '#403d52', apagado: '#908caa', texto: '#e0def4',
            vermelho: '#eb6f92', laranja: '#ebbcba', amarelo: '#f6c177', verde: '#3e8fb0', ciano: '#9ccfd8', azul: '#9ccfd8', magenta: '#c4a7e7' },
        'everforest-dark': { nome: 'Everforest Dark', escuro: true,
            fundo: '#2d353b', superficie: '#343f44', elevado: '#3d484d', borda: '#475258', apagado: '#859289', texto: '#d3c6aa',
            vermelho: '#e67e80', laranja: '#e69875', amarelo: '#dbbc7f', verde: '#a7c080', ciano: '#83c092', azul: '#7fbbb3', magenta: '#d699b6' },
        'kanagawa': { nome: 'Kanagawa', escuro: true,
            fundo: '#1f1f28', superficie: '#2a2a37', elevado: '#363646', borda: '#54546d', apagado: '#8a8980', texto: '#dcd7ba',
            vermelho: '#e46876', laranja: '#ffa066', amarelo: '#e6c384', verde: '#98bb6c', ciano: '#7aa89f', azul: '#7e9cd8', magenta: '#957fb8' },
        // ---- especiais ----
        // GTA VI (id 'vice'): pôr do sol neon da Flórida dos anos 80/2020 (inspirado no visual de GTA VI). Escuro, com o rosa-choque como
        // destaque (o papel "azul" é a cor de destaque do motor), laranja de pôr do sol e turquesa de Miami. O `extra`
        // acrescenta CSS que só um esquema assim usa: degradês de pôr do sol nos títulos e brilho neon.
        'vice': { nome: 'GTA VI', escuro: true,
            fundo: '#1a0f2e', superficie: '#22143d', elevado: '#2d1a4f', borda: '#4b2d7a', apagado: '#a48cce', texto: '#fff0fa',
            vermelho: '#ff4d6d', laranja: '#ff8c42', amarelo: '#ffd23f', verde: '#46f2a6', ciano: '#2de2e6', azul: '#ff3ea5', magenta: '#b967ff',
            extra: (P, c, x) => `
html{background-image:${palmeirasSvg('#36195e', false)},${palmeirasSvg('#2c1550', true)},
  radial-gradient(120% 60% at 50% 115%,rgba(255,120,70,.2),transparent 60%),radial-gradient(80% 50% at 100% 0%,rgba(185,103,255,.10),transparent 60%)!important;
  background-repeat:no-repeat!important;background-position:left -40px bottom,right -40px bottom,0 0,0 0!important;
  background-size:auto min(80vh,640px),auto min(62vh,500px),100% 100%,100% 100%!important;background-attachment:fixed!important}
body{background-color:transparent!important}
::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#ff3ea5,#ff8c42)!important;border:2px solid ${c(P.fundo)}}
/* títulos de janela: céu de pôr do sol (roxo -> rosa -> laranja) com letreiro neon */
.x-window-tl{background-image:linear-gradient(90deg,#3a1760 0%,#8a2470 55%,#ff6a3d 100%)!important;border-bottom:0!important;box-shadow:0 2px 0 0 rgba(255,62,165,.55),0 4px 14px -4px rgba(255,62,165,.5)}
.x-window-tl .x-window-header,.x-window-header-text{color:#fff!important;text-shadow:0 0 6px rgba(255,62,165,.9),0 0 1px #fff}
.x-window{box-shadow:0 0 0 1px #ff3ea566,0 10px 40px -8px rgba(255,62,165,.35)!important}
/* barra de cima do portal e barras de ferramentas: faixa neon embaixo */
.x-toolbar{box-shadow:inset 0 -2px 0 0 transparent;border-image:linear-gradient(90deg,#2de2e6,#ff3ea5,#ff8c42) 0 0 1 0!important;border-bottom-width:1px!important;border-bottom-style:solid!important}
/* grades: cabeçalho com sublinhado rosa -> laranja e linha em foco com brilho */
table.WorkWith>*>tr>th,table.Grid>*>tr>th,th.WorkWithTitle,th.GridTitle{box-shadow:inset 0 -2px 0 0 #ff3ea5}
table.WorkWith,table.Grid{box-shadow:0 0 0 1px rgba(255,62,165,.12),0 8px 24px -12px rgba(255,62,165,.35)}
table.WorkWith>*>tr:hover>td,table.Grid>*>tr:hover>td{text-shadow:0 0 8px rgba(255,62,165,.35)}
/* botões (texto do tema, ícone em caixa, redondos do GeneXus, rodapé das janelas Ext): vidro roxo com borda neon
   rosa -> laranja; no hover acende. Só o fundo/borda: os ícones ficam com as cores deles */
.dt-texto,.dt-icone.dt-caixa,span.BaseRBtn input.BtnText,.x-panel-btns table.x-btn{border:1px solid transparent!important;
  background:linear-gradient(180deg,#3b1d63,#26133f) padding-box,linear-gradient(100deg,#ff3ea5,#ff8c42) border-box!important;
  box-shadow:0 0 10px -5px rgba(255,62,165,.7)!important}
.dt-texto:hover,.dt-icone.dt-caixa:hover,span.BaseRBtn input.BtnText:hover:not(:disabled),.x-panel-btns table.x-btn-over{
  background:linear-gradient(180deg,#5b2486,#3a1659) padding-box,linear-gradient(100deg,#ff6cbd,#ffad66) border-box!important;
  box-shadow:0 0 14px -3px rgba(255,62,165,.85),0 0 22px -8px rgba(255,140,66,.7)!important}
.dt-texto:active,.dt-icone.dt-caixa:active{transform:translateY(1px)}
/* botões Bootstrap da tela inicial (WP_Fluxo): o <span class="btn"> é só um invólucro inline, o botão visível é o <a>.
   Abas (btn-default) no mesmo vidro neon; ações (btn-primary: Executar, Delegar, Atualizar) cheias com o pôr do sol */
.btn.btn-default>a{border:1px solid transparent!important;border-radius:6px;background:linear-gradient(180deg,#3b1d63,#26133f) padding-box,linear-gradient(100deg,#ff3ea5,#ff8c42) border-box!important;
  box-shadow:0 0 10px -5px rgba(255,62,165,.7)!important;color:#fff0fa!important}
.btn.btn-default>a:hover{background:linear-gradient(180deg,#5b2486,#3a1659) padding-box,linear-gradient(100deg,#ff6cbd,#ffad66) border-box!important;
  box-shadow:0 0 14px -3px rgba(255,62,165,.85)!important;text-decoration:none}
.btn.btn-primary>a{border:1px solid rgba(255,255,255,.14)!important;border-radius:6px;background:linear-gradient(100deg,#ff3ea5 0%,#ff5f7e 50%,#ff8c42 100%)!important;
  box-shadow:0 4px 16px -4px rgba(255,62,165,.75)!important;color:#fff!important;text-shadow:0 1px 2px rgba(80,0,40,.45)}
.btn.btn-primary>a :is(i,span){color:#fff!important}
.btn.btn-primary>a:hover{filter:brightness(1.1) saturate(1.1);box-shadow:0 6px 22px -4px rgba(255,120,80,.9)!important;text-decoration:none}
/* listas FreeStyle (ex. fluxos da tela inicial): linhas sem fundo próprio, para as palmeiras não virarem faixas */
tr:is(.FreeStyleGridOdd,.FreeStyleGridEven){background-color:transparent!important}
/* títulos e destaques em neon */
legend.ContornoTitle,.Title,.TextBlockHeader,#span_vGRUPOEMPRESA_NOME{color:#ffd1ec!important;text-shadow:0 0 8px rgba(255,62,165,.7)}
a:hover{text-shadow:0 0 6px rgba(45,226,230,.7)}
` },
        // ---- claros ----
        'github-light': { nome: 'GitHub Light', escuro: false,
            fundo: '#ffffff', superficie: '#f6f8fa', elevado: '#eaeef2', borda: '#d0d7de', apagado: '#656d76', texto: '#1f2328',
            vermelho: '#cf222e', laranja: '#bc4c00', amarelo: '#9a6700', verde: '#1a7f37', ciano: '#1b7c83', azul: '#0969da', magenta: '#8250df' },
        'solarized-light': { nome: 'Solarized Light', escuro: false,
            fundo: '#fdf6e3', superficie: '#eee8d5', elevado: '#e4ddc8', borda: '#cfc7b0', apagado: '#839496', texto: '#586e75',
            vermelho: '#dc322f', laranja: '#cb4b16', amarelo: '#b58900', verde: '#859900', ciano: '#2aa198', azul: '#268bd2', magenta: '#d33682' },
        'gruvbox-light': { nome: 'Gruvbox Light', escuro: false,
            fundo: '#fbf1c7', superficie: '#f2e5bc', elevado: '#ebdbb2', borda: '#d5c4a1', apagado: '#7c6f64', texto: '#3c3836',
            vermelho: '#9d0006', laranja: '#af3a03', amarelo: '#b57614', verde: '#79740e', ciano: '#427b58', azul: '#076678', magenta: '#8f3f71' },
        'catppuccin-latte': { nome: 'Catppuccin Latte', escuro: false,
            fundo: '#eff1f5', superficie: '#e6e9ef', elevado: '#dce0e8', borda: '#bcc0cc', apagado: '#7c7f93', texto: '#4c4f69',
            vermelho: '#d20f39', laranja: '#fe640b', amarelo: '#df8e1d', verde: '#40a02b', ciano: '#179299', azul: '#1e66f5', magenta: '#8839ef' },
        'nord-light': { nome: 'Nord Light', escuro: false,
            fundo: '#eceff4', superficie: '#e5e9f0', elevado: '#d8dee9', borda: '#c2c9d6', apagado: '#6c7a96', texto: '#2e3440',
            vermelho: '#bf616a', laranja: '#c0704f', amarelo: '#b08a2e', verde: '#6f8f57', ciano: '#4f8fa3', azul: '#5e81ac', magenta: '#9a6f93' },
        'rose-pine-dawn': { nome: 'Rosé Pine Dawn', escuro: false,
            fundo: '#faf4ed', superficie: '#f2e9e1', elevado: '#ebe2da', borda: '#dfdad9', apagado: '#797593', texto: '#575279',
            vermelho: '#b4637a', laranja: '#d7827e', amarelo: '#ea9d34', verde: '#286983', ciano: '#56949f', azul: '#56949f', magenta: '#907aa9' },
        'tokyo-night-day': { nome: 'Tokyo Night Day', escuro: false,
            fundo: '#e1e2e7', superficie: '#d6d8df', elevado: '#cbcdd6', borda: '#a8aecb', apagado: '#6172b0', texto: '#3760bf',
            vermelho: '#f52a65', laranja: '#b15c00', amarelo: '#8c6c3e', verde: '#587539', ciano: '#007197', azul: '#2e7de9', magenta: '#9854f1' },
        'one-light': { nome: 'One Light', escuro: false,
            fundo: '#fafafa', superficie: '#f0f0f1', elevado: '#e5e5e6', borda: '#d3d3d5', apagado: '#80818a', texto: '#383a42',
            vermelho: '#e45649', laranja: '#c18401', amarelo: '#986801', verde: '#50a14f', ciano: '#0184bc', azul: '#4078f2', magenta: '#a626a4' },
        'everforest-light': { nome: 'Everforest Light', escuro: false,
            fundo: '#fdf6e3', superficie: '#f4f0d9', elevado: '#efebd4', borda: '#e0dcc7', apagado: '#829181', texto: '#5c6a72',
            vermelho: '#f85552', laranja: '#f57d26', amarelo: '#dfa000', verde: '#8da101', ciano: '#35a77c', azul: '#3a94c5', magenta: '#df69ba' },
    };
    const PADRAO = { tema: 'off', claro: 'github-light', escuro: 'dracula', imagens: true, debug: false, ocultos: false, fonte: 'original', tamanho: 100 };

    // ------------------------------------------------------------------------------------------------
    // Fontes. "sistema": instaladas no computador (só aparecem na lista se existirem). "web": baixadas do
    // Bunny Fonts (espelho do Google Fonts sem rastreamento; se falhar, do Google Fonts) e guardadas no
    // Cache Storage do navegador, então só são baixadas de novo quando o provedor muda os arquivos.
    // ------------------------------------------------------------------------------------------------
    const FONTES = {
        'sistema': { nome: 'Padrão do sistema', tipo: 'sistema', pilha: 'system-ui,"Segoe UI",Roboto,"Noto Sans",Ubuntu,Cantarell,sans-serif' },
        'segoe-ui': { nome: 'Segoe UI', tipo: 'sistema', local: 'Segoe UI' },
        'calibri': { nome: 'Calibri', tipo: 'sistema', local: 'Calibri' },
        'arial': { nome: 'Arial', tipo: 'sistema', local: 'Arial' },
        'verdana': { nome: 'Verdana', tipo: 'sistema', local: 'Verdana' },
        'tahoma': { nome: 'Tahoma', tipo: 'sistema', local: 'Tahoma' },
        'trebuchet': { nome: 'Trebuchet MS', tipo: 'sistema', local: 'Trebuchet MS' },
        'roboto': { nome: 'Roboto', tipo: 'sistema', local: 'Roboto' },
        'ubuntu': { nome: 'Ubuntu', tipo: 'sistema', local: 'Ubuntu' },
        'dejavu-sans': { nome: 'DejaVu Sans', tipo: 'sistema', local: 'DejaVu Sans' },
        'atkinson-next': { nome: 'Atkinson Hyperlegible Next', tipo: 'web', bunny: 'atkinson-hyperlegible-next:400,700', google: 'Atkinson+Hyperlegible+Next:wght@400;700' },
        'atkinson': { nome: 'Atkinson Hyperlegible', tipo: 'web', bunny: 'atkinson-hyperlegible:400,400i,700,700i', google: 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700' },
        'lexend': { nome: 'Lexend', tipo: 'web', bunny: 'lexend:400,700', google: 'Lexend:wght@400;700' },
        'inter': { nome: 'Inter', tipo: 'web', bunny: 'inter:400,700', google: 'Inter:wght@400;700' },
        'noto-sans': { nome: 'Noto Sans', tipo: 'web', bunny: 'noto-sans:400,400i,700,700i', google: 'Noto+Sans:ital,wght@0,400;0,700;1,400;1,700' },
        'ibm-plex-sans': { nome: 'IBM Plex Sans', tipo: 'web', bunny: 'ibm-plex-sans:400,400i,700,700i', google: 'IBM+Plex+Sans:ital,wght@0,400;0,700;1,400;1,700' },
        'source-sans-3': { nome: 'Source Sans 3', tipo: 'web', bunny: 'source-sans-3:400,400i,700,700i', google: 'Source+Sans+3:ital,wght@0,400;0,700;1,400;1,700' },
    };
    const TAMANHO_MIN = 80, TAMANHO_MAX = 150;
    // nome com que a fonte baixada é registrada (não colide com uma instalada de mesmo nome)
    const familiaWeb = id => 'DealerTema ' + FONTES[id].nome;
    function pilhaFonte(id) {
        const f = FONTES[id];
        if (!f) return null;
        if (f.pilha) return f.pilha;
        if (f.tipo === 'web') return `"${familiaWeb(id)}","${f.nome}",system-ui,"Segoe UI",Arial,sans-serif`;
        return `"${f.local}",system-ui,"Segoe UI",Arial,sans-serif`;
    }
    const CHAVE_SEM_ICONE = 'DealerTema.semIcone';

    // ------------------------------------------------------------------------------------------------
    // Configuração
    // ------------------------------------------------------------------------------------------------
    function lerConfig() {
        let c = {};
        try { c = JSON.parse(localStorage.getItem(CHAVE) || '{}') || {}; } catch (e) { /* sem storage */ }
        c = Object.assign({}, PADRAO, c);
        if (!ESQUEMAS[c.claro] || ESQUEMAS[c.claro].escuro) c.claro = PADRAO.claro;
        if (!ESQUEMAS[c.escuro] || !ESQUEMAS[c.escuro].escuro) c.escuro = PADRAO.escuro;
        if (c.tema !== 'off' && c.tema !== 'auto' && !ESQUEMAS[c.tema]) c.tema = 'off';
        if (c.fonte !== 'original' && !FONTES[c.fonte]) c.fonte = 'original';
        c.tamanho = Math.round(Math.min(TAMANHO_MAX, Math.max(TAMANHO_MIN, Number(c.tamanho) || 100)));
        return c;
    }
    function salvarConfig(c) {
        try { localStorage.setItem(CHAVE, JSON.stringify(c)); } catch (e) { /* sem storage */ }
    }
    const midiaEscura = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function esquemaAtivo(c) {
        if (c.tema === 'off') return null;
        if (c.tema === 'auto') return (midiaEscura && midiaEscura.matches) ? c.escuro : c.claro;
        return c.tema;
    }

    // ------------------------------------------------------------------------------------------------
    // Cores
    // ------------------------------------------------------------------------------------------------
    function hexParaRgb(h) {
        h = h.slice(1);
        if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
        const n = parseInt(h.slice(0, 6), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
    }
    function hslParaRgb(h, s, l) {
        s /= 100; l /= 100;
        const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
        const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return [f(0) * 255, f(8) * 255, f(4) * 255];
    }
    let ctxCor = null;
    const cacheNomes = new Map();
    // Nome de cor CSS ("white", "gray"...) -> rgb, usando um canvas (evita embutir a lista de nomes)
    function corPorNome(nome) {
        nome = nome.toLowerCase();
        if (cacheNomes.has(nome)) return cacheNomes.get(nome);
        let r = null;
        if (!/^(transparent|currentcolor|inherit|initial|unset|revert|none)$/.test(nome)) {
            if (!ctxCor) ctxCor = document.createElement('canvas').getContext('2d');
            ctxCor.fillStyle = '#010203';
            ctxCor.fillStyle = nome;
            const v = ctxCor.fillStyle;
            if (v !== '#010203' || nome === '#010203') r = v.startsWith('#') ? hexParaRgb(v) : null;
        }
        cacheNomes.set(nome, r);
        return r;
    }
    function lerCor(s) {
        s = s.trim();
        if (s[0] === '#') return hexParaRgb(s);
        let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
        if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4])];
        m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
        if (m) return [...hslParaRgb(+m[1], +m[2], +m[3]), m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4])];
        return corPorNome(s);
    }
    function corCss(c) {
        const r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
        if (c[3] >= 1) return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
        return `rgba(${r}, ${g}, ${b}, ${+c[3].toFixed(3)})`;
    }
    function misturar(a, b, t) {
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];
    }
    // OKLab: luminosidade (L 0..1), croma e matiz perceptuais
    function oklab(c) {
        const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
        const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
        const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
        return { L, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 };
    }

    // ------------------------------------------------------------------------------------------------
    // Tradutor de cores para um esquema
    // ------------------------------------------------------------------------------------------------
    const MATIZES = ['vermelho', 'laranja', 'amarelo', 'verde', 'ciano', 'azul', 'magenta'];
    // Matiz "de referência" de cada nome (no OKLab), para classificar as cores do site
    const MATIZ_REF = { vermelho: 25, laranja: 60, amarelo: 100, verde: 142, ciano: 200, azul: 262, magenta: 330 };

    function criarTradutor(e) {
        const P = {};
        for (const k of ['fundo', 'superficie', 'elevado', 'borda', 'apagado', 'texto', ...MATIZES]) P[k] = hexParaRgb(e[k]);
        P.sobreDestaque = P.fundo;                     // texto em cima de cor forte
        const rampa = [[0, P.fundo], [0.05, P.superficie], [0.11, P.elevado], [0.22, P.borda], [0.45, P.apagado], [0.78, P.texto]];
        const textoMin = misturar(P.apagado, P.texto, e.escuro ? 0.35 : 0.6);
        const tMinTexto = 0.5;
        function naRampa(t) {
            if (t <= 0) return P.fundo;
            for (let i = 1; i < rampa.length; i++) {
                if (t <= rampa[i][0]) {
                    const [t0, c0] = rampa[i - 1], [t1, c1] = rampa[i];
                    return misturar(c0, c1, (t - t0) / (t1 - t0));
                }
            }
            return P.texto;
        }
        function matizMaisProximo(h) {
            let melhor = 'azul', dist = 999;
            for (const k of MATIZES) {
                let d = Math.abs(h - MATIZ_REF[k]); d = Math.min(d, 360 - d);
                if (d < dist) { dist = d; melhor = k; }
            }
            return P[melhor];
        }
        const cache = new Map();
        // papel: 'fundo' | 'texto' | 'borda'
        function traduzir(rgba, papel) {
            const chave = papel + rgba.join(',');
            let r = cache.get(chave);
            if (r) return r;
            const { L, C, H } = oklab(rgba);
            let out;
            if (C < 0.045 || (C < 0.07 && L > 0.9)) {             // neutro (cinzas e quase-brancos)
                const t = Math.min(1, Math.max(0, (1 - L)));
                if (papel === 'texto') {
                    if (L > 0.85) out = P.sobreDestaque;          // texto branco: está sobre fundo escuro/colorido
                    else out = t < tMinTexto ? misturar(textoMin, P.texto, t / tMinTexto * 0.3) : naRampa(t);
                } else {
                    out = naRampa(t);
                }
            } else {                                              // cor saturada
                const base = matizMaisProximo(H);
                if (papel === 'fundo') {
                    if (L > 0.88) out = misturar(P.fundo, base, 0.14);        // fundo pastel (destaque leve)
                    else if (L > 0.72) out = misturar(P.fundo, base, 0.32);   // fundo médio
                    else out = base;                                          // fundo forte (texto branco em cima)
                } else if (papel === 'texto' && L > 0.85) {
                    out = misturar(base, P.texto, 0.3);
                } else {
                    out = base;
                }
            }
            r = corCss([out[0], out[1], out[2], rgba[3]]);
            cache.set(chave, r);
            return r;
        }
        // Troca todas as cores de um valor CSS ("1px solid #ccc", "linear-gradient(...)", ...)
        const RE_COR = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|\b[a-z]{3,20}\b/gi;
        function traduzirValor(valor, papel) {
            if (!valor) return valor;
            let mudou = false;
            const novo = valor.replace(RE_COR, (tok, pos) => {
                if (/^[a-z]/i.test(tok)) {
                    // palavras: só nomes de cor, e não dentro de url(...) nem nomes de função
                    if (valor[pos + tok.length] === '(' || /url\([^)]*$/i.test(valor.slice(0, pos))) return tok;
                } else if (tok[0] === '#' && /url\([^)]*$/i.test(valor.slice(0, pos))) return tok;
                const c = lerCor(tok);
                if (!c || c.some(v => isNaN(v))) return tok;
                if (c[3] === 0) return tok;
                mudou = true;
                return traduzir(c, papel);
            });
            return mudou ? novo : valor;
        }
        return { P, traduzir, traduzirValor, esquema: e };
    }

    // Propriedade CSS -> papel da cor
    // tamanhos de fonte: só unidades absolutas mudam (em/%/rem já acompanham o pai), keywords viram px
    const KEYWORDS_TAMANHO = { 'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16, 'large': 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
    const TAMANHO_FONT_ATTR = [0, 10, 13, 16, 18, 24, 32, 48];   // <font size="1..7">
    function escalarTamanho(valor, comKeywords) {
        if (escala === 1 || !valor) return valor;
        const k = comKeywords && KEYWORDS_TAMANHO[valor.trim().toLowerCase()];
        if (k) return arred(k * escala) + 'px';
        return valor.replace(/(\d*\.?\d+)(px|pt|pc|in|cm|mm|q)\b/gi, (m, n, u) => arred(parseFloat(n) * escala) + u);
    }
    const arred = n => Math.round(n * 100) / 100;
    // lugares desenhados com altura fixa em px onde texto maior é cortado: ficam no tamanho original
    // (barras de agendamento do quadro dhtmlx)
    const SEM_ESCALA = /dhx_cal_event/;
    // o CSS do próprio tema (botões, títulos...) também acompanha o tamanho escolhido
    function escalarCss(css) {
        if (escala === 1) return css;
        return css.replace(/(font-size\s*:\s*)(\d*\.?\d+)px/gi, (m, a, n) => a + arred(parseFloat(n) * escala) + 'px')
            .replace(/(\bfont\s*:\s*(?:[a-z0-9-]+\s+)*?)(\d*\.?\d+)px/gi, (m, a, n) => a + arred(parseFloat(n) * escala) + 'px');
    }
    function papelDe(prop) {
        if (prop === 'font-size' || prop === 'line-height') return 'fonte';
        if (prop === 'color' || prop === 'caret-color' || prop === 'text-decoration-color' || prop === '-webkit-text-fill-color' || prop === 'fill' || prop === 'text-emphasis-color') return 'texto';
        if (prop === 'background-color' || prop === 'background-image') return 'fundo';
        if (/^border(-.*)?-color$|^outline-color$|^column-rule-color$|^stroke$|shadow$/.test(prop)) return 'borda';
        return null;
    }

    // Imagens de fundo que são só textura/degradê do tema cinza (ExtJS e WorkWithPlus). Removê-las
    // deixa aparecer a cor de fundo traduzida. Ícones e setas ficam.
    const RE_TEXTURA = /(top-bottom|left-right|white-top-bottom|left-corners|right-corners|\/corners(-blue|-sprite)?\.(gif|png)|\/[a-z0-9-]*bg[a-z0-9-]*\.(gif|png)|tab-strip|tabs-sprite|tab-btm-|light-hd|hd-sprite|grid3?-hrow|grid3-hd-btn|grid3-rowheader|row-over|item-over|\/btn\.gif|\/menu\.gif|text-bg|group-(tb|lr|cs)\.gif|\/tb\.gif|tb-blue|panel-title-light-bg|progress-bg|grid3-special-col|btn[LCR]\.gif|DataTitleCell|HeaderBackground|header_small|line_header|Tab(Un)?[Ss]elected|WorkWithPlusTheme\/Button\.gif|PrpTitulo|Data(Description|Title|Content)Cell)/i;

    // ------------------------------------------------------------------------------------------------
    // Ícones (SVG de traço, cor = currentColor). Usados dentro dos botões HTML que substituem as
    // imagens do GeneXus e, como máscara CSS, no lugar dos sprites do ExtJS.
    // ------------------------------------------------------------------------------------------------
    const ICONES = {
        busca: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/>',
        atualizar: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
        filtro: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
        fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
        mais: '<path d="M12 5v14M5 12h14"/>',
        menos: '<path d="M5 12h14"/>',
        editar: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
        lixeira: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
        olho: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        primeira: '<path d="M6 5v14M18 6l-7 6 7 6"/>',
        anterior: '<path d="M15 6l-6 6 6 6"/>',
        proxima: '<path d="M9 6l6 6-6 6"/>',
        ultima: '<path d="M18 5v14M6 6l7 6-7 6"/>',
        baixo: '<path d="M6 9l6 6 6-6"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
        // marcado/desmarcado do Grupo de Acesso: traço grosso para o verde e o vermelho se distinguirem (daltonismo)
        checkGrosso: '<path d="M4.5 12.5l5 5L19.5 6.5" stroke-width="4.2"/>',
        caixa: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
        caixaCheck: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l3 3 5-6"/>',
        ponto: '<circle cx="12" cy="12" r="7.5" fill="currentColor"/>',
        calendario: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
        calendarioCheck: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8.5 15.5l2.5 2.5 4.5-4.5"/>',
        usuarioEditar: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2 20c0-4 3-6.5 7-6.5 1.4 0 2.6.3 3.6.8"/><path d="M19.5 12.5l2 2-6 6-2.6.6.6-2.6z"/>',
        carro: '<path d="M4.6 17H2.8a.8.8 0 0 1-.8-.8v-3.1c0-.6.4-1.1 1-1.3L8 10.5l3-3.6c.4-.5 1-.9 1.7-.9h3.6c.7 0 1.3.3 1.7.9l2.4 3.4 1 .4c.4.2.6.6.6 1v4.5a.8.8 0 0 1-.8.8h-1.8M9.4 17h5.2"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
        medidor: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
        telefone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
        prancheta: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
        chave: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
        usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6s7 2 7 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c2.4.6 4 2.6 4 5.8"/>',
        usuarioFerramenta: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2 20c0-4 3-6.5 7-6.5 1.4 0 2.6.3 3.6.8"/><path d="M14 21l4.2-4.2M21.5 14.2a2.6 2.6 0 0 1-3.3 2.6M21.5 14.2l-1.6 1.1-1.5-1.5 1.1-1.6a2.6 2.6 0 0 0-3.1 3.3"/>',
        usuarioMais: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6"/>',
        carrinho: '<path d="M3 4h2l2.5 11h11L21 7H6.4"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>',
        janelaNova: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M12 12v5M9.5 14.5h5"/>',
        cascata: '<rect x="3" y="3" width="12" height="10" rx="1.5"/><rect x="9" y="11" width="12" height="10" rx="1.5"/>',
        fecharTodas: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
        minimizarTodas: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7.5 16h9"/>',
        minimizar: '<path d="M6 17h12"/>',
        maximizar: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
        restaurar: '<rect x="4" y="9" width="11" height="11" rx="1.5"/><path d="M9 9V5.5A1.5 1.5 0 0 1 10.5 4H18.5A1.5 1.5 0 0 1 20 5.5V13.5A1.5 1.5 0 0 1 18.5 15H15"/>',
        globo: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
        salvar: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
        workspace: '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><path d="M17.25 13.5v7.5M13.5 17.25h7.5"/>',
        ajuda: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
        estrela: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
        estrelaCheia: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/>',
        ajustar: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
        alerta: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
        chaveAcesso: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/>',
        etiqueta: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
        escudo: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
        documento: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
        documentoCheck: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 14l2 2 4-4"/>',
        certificado: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M7 8h10M7 11h6"/><circle cx="16" cy="15" r="2.5"/><path d="M14.5 17l-.5 4 2-1 2 1-.5-4"/>',
        relogio: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5M12 7.5V12l3 2"/>',
        cronometro: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2h4M18.5 5.5l1.5-1.5"/>',
        segmento: '<path d="M11 4a8.5 8.5 0 1 0 9 9h-9z"/><path d="M14 2.5A8 8 0 0 1 21.5 10H14z"/>',
        cifrao: '<path d="M12 3v18M16.5 7.5c-.8-1.5-2.4-2.5-4.5-2.5-2.5 0-4.5 1.3-4.5 3.5s2 3 4.5 3.5 4.5 1.3 4.5 3.5-2 3.5-4.5 3.5c-2.2 0-3.9-1-4.7-2.7"/>',
        predio: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
        casa: '<path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5M10 21v-6h4v6"/>',
        dinheiro: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
        camera: '<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13.5" r="3.5"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
        ligacao: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
        alfinete: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
        bolsa: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12h18"/>',
        mensagem: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
        cadeado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2"/>',
        cartao: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
        desfazer: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
        envelope: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
        raio: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
        pacote: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10M7.5 5l9 4"/>',
        aviso: '<path d="M12 3L2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
        bandeira: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
        energia: '<path d="M12 3v9"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>',
        celular: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
        whatsapp: '<path d="M3.5 20.5l1.3-4A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 8.5c0 3 3 6 6 6l1-1.5-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z"/>',
        bloqueado: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
        usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
        usuarioBusca: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6 1.3 0 2.4.2 3.4.6"/><circle cx="17" cy="16" r="3"/><path d="M19.2 18.2L22 21"/>',
        enquadrar: '<path d="M7 3H3v18h4M17 3h4v18h-4"/><circle cx="12" cy="8" r="2.5"/><path d="M8 18c0-2.5 1.8-4 4-4s4 1.5 4 4"/>',
        digitalizar: '<path d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4M4 12h16"/>',
        megafone: '<path d="M3 10v4h4l8 5V5L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
        limparFiltro: '<path d="M3 4h14l-5.5 7V17l-3 2v-8z"/><path d="M16 14l5 5M21 14l-5 5"/>',
        checklist: '<path d="M10 6h10M10 12h10M10 18h10M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
        ferramentas: '<g class="dt-k-texto" opacity=".6"><path d="M4.39 1.69L4.78 4.78L1.69 4.39A3.6 3.6 0 1 0 4.39 1.69zM19.61 22.31L19.22 19.22L22.31 19.61A3.6 3.6 0 1 0 19.61 22.31z"/><path d="M7.8 7.8L16.2 16.2" stroke-width="2.6"/></g><path d="M4.3 19.7L12.6 11.4" stroke-width="1.8"/><path d="M13.2 8.6l2.2 2.2-1.4 1.4-2.2-2.2z" fill="currentColor" stroke-width="1"/><path d="M14.3 7.5l3.7-3.7a1.6 1.6 0 0 1 2.2 0 1.6 1.6 0 0 1 0 2.2l-3.7 3.7z" fill="currentColor" stroke-width="1.6"/>',
        carroBusca: '<path d="M4 11l1.5-4h9l1.5 4"/><rect x="2.5" y="11" width="15" height="5" rx="1.5"/><circle cx="6" cy="16.5" r="1.5"/><circle cx="14" cy="16.5" r="1.5"/><circle cx="18" cy="6" r="3"/><path d="M20.2 8.2L22.5 10.5"/>',
        enviar: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
        trocar: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
        envelopeCheck: '<path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7"/><path d="M3 7l9 6 9-6M15 18l2 2 4-4"/>',
        envelopeX: '<path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7"/><path d="M3 7l9 6 9-6M16 16l4 4M20 16l-4 4"/>',
        codigoBarras: '<path d="M4 5v14M7 5v14M10 5v14M14 5v14M16 5v14M20 5v14"/>',
        engrenagem: '<path d="M10.58 4.84L10.82 2.07A10 10 0 0 1 13.18 2.07L13.42 4.84A7.3 7.3 0 0 1 16.06 5.93L18.19 4.15A10 10 0 0 1 19.85 5.81L18.07 7.94A7.3 7.3 0 0 1 19.16 10.58L21.93 10.82A10 10 0 0 1 21.93 13.18L19.16 13.42A7.3 7.3 0 0 1 18.07 16.06L19.85 18.19A10 10 0 0 1 18.19 19.85L16.06 18.07A7.3 7.3 0 0 1 13.42 19.16L13.18 21.93A10 10 0 0 1 10.82 21.93L10.58 19.16A7.3 7.3 0 0 1 7.94 18.07L5.81 19.85A10 10 0 0 1 4.15 18.19L5.93 16.06A7.3 7.3 0 0 1 4.84 13.42L2.07 13.18A10 10 0 0 1 2.07 10.82L4.84 10.58A7.3 7.3 0 0 1 5.93 7.94L4.15 5.81A10 10 0 0 1 5.81 4.15L7.94 5.93A7.3 7.3 0 0 1 10.58 4.84z"/><circle cx="12" cy="12" r="3"/>',
        calculadora: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01M8 18h.01M12 18h.01M16 18h.01"/>',
        caminhao: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
        planilha: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 11h6v7H9zM9 14.5h6M12 11v7"/>',
        pdf: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 17v-4h1.5a1.5 1.5 0 0 1 0 3H9"/>',
        word: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M8.5 12l1.2 5 1.3-3.5 1.3 3.5 1.2-5"/>',
        calendarioRelogio: '<path d="M11 21H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M3 10h16M8 3v4M14 3v4"/><circle cx="17" cy="17" r="4.5"/><path d="M17 15v2l1.3 1"/>',
        envelopes: '<rect x="2" y="7" width="16" height="12" rx="2"/><path d="M2 9l8 5 8-5M6 4h14a2 2 0 0 1 2 2v9"/>',
        engrenagemParar: '<path d="M8.41 4.01L8.58 1.75A7.8 7.8 0 0 1 10.42 1.75L10.59 4.01A5.6 5.6 0 0 1 12.61 4.84L14.33 3.37A7.8 7.8 0 0 1 15.63 4.67L14.16 6.39A5.6 5.6 0 0 1 14.99 8.41L17.25 8.58A7.8 7.8 0 0 1 17.25 10.42L14.99 10.59A5.6 5.6 0 0 1 14.16 12.61L15.63 14.33A7.8 7.8 0 0 1 14.33 15.63L12.61 14.16A5.6 5.6 0 0 1 10.59 14.99L10.42 17.25A7.8 7.8 0 0 1 8.58 17.25L8.41 14.99A5.6 5.6 0 0 1 6.39 14.16L4.67 15.63A7.8 7.8 0 0 1 3.37 14.33L4.84 12.61A5.6 5.6 0 0 1 4.01 10.59L1.75 10.42A7.8 7.8 0 0 1 1.75 8.58L4.01 8.41A5.6 5.6 0 0 1 4.84 6.39L3.37 4.67A7.8 7.8 0 0 1 4.67 3.37L6.39 4.84A5.6 5.6 0 0 1 8.41 4.01z"/><circle cx="9.5" cy="9.5" r="2.3"/><circle cx="18.5" cy="18.5" r="4.5"/><path d="M16.5 18.5h4"/>',
        sped: '<path d="M3 5.5h7M5 8.5h5" class="dt-k-texto" opacity=".5" stroke-width="1.6"/><circle cx="15" cy="7" r="4.2" class="dt-k-texto" opacity=".5" stroke-width="1.6"/><text x="12" y="22.5" text-anchor="middle" textLength="23" lengthAdjust="spacingAndGlyphs" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="11.5" fill="currentColor" stroke="none">SPED</text>',
        malaDireta: '<path d="M3 2h5.5L11 4.5V12H3z"/><path d="M8.5 2v2.5H11"/><rect x="10" y="14" width="12" height="8" rx="1.5"/><path d="M10 15.5l6 3.5 6-3.5"/><path d="M13.5 5.5H15a3 3 0 0 1 3 3V11M16 9.3l2 2 2-2"/>',
        planilhaDetalhada: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M8 11h8v8H8zM8 13.7h8M8 16.3h8M10.7 11v8M13.3 11v8"/>',
        positivo: '<path d="M7 11v10H3V11zM7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.3 7.5a2.5 2.5 0 0 1-2.5 2.2H7"/>',
        cancelar: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
        exportar: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
        porcentagem: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
        cadeadoAberto: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5M12 15v2"/>',
        play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor"/>',
        parar: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/>',
        duplicar: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
        usuarioX: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6 1.4 0 2.6.2 3.6.7M16 15l5 5M21 15l-5 5"/>',
        organograma: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
        gota: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
        volante: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M3.5 11c3-1 5.5-1.5 8.5-1.5s5.5.5 8.5 1.5M10.5 13.5L8 20.5M13.5 13.5l2.5 7"/>',
        alvo: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
        pasta: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
        pastaAberta: '<path d="M3 18V6a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v2"/><path d="M3 18l2.6-7.3a1 1 0 0 1 .9-.7H21a.8.8 0 0 1 .8 1L19.4 18.3a1 1 0 0 1-.9.7H4a1 1 0 0 1-1-1z"/>',
        aperto: '<path d="M2 12l3-6 3 1 3-2 3 1M22 12l-3-6-3.5 1.2"/><path d="M5 6l-3 6 2 2M19 6l3 6-3.5 3"/><path d="M11 5L7.5 9a1.3 1.3 0 0 0 1.8 1.9L12 8.5l5.5 5.5a1.3 1.3 0 0 1-1.8 1.9l-1.5-1.5 1 1a1.3 1.3 0 0 1-1.8 1.9l-1-1 .5.5a1.3 1.3 0 0 1-1.8 1.9L8 15.5 4 14"/>',
        monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
        setaCima: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-9M8 11l4-4 4 4"/>',
        setaBaixo: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M8 13l4 4 4-4"/>',
        download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
        grafico: '<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/>',
        balanca: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-2.5 6a2.5 2 0 0 0 5 0zM19 7l-2.5 6a2.5 2 0 0 0 5 0z"/>',
        sair: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="M15 8l4 4-4 4M19 12H9"/>',
        imprimir: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M6 14h12v7H6z"/>',
        // documento + impressora: impressão da OS (IcoPrintOS), diferente da impressora sozinha da NF (IcoPrint)
        imprimirDoc: '<path d="M9 20H3V2h8l4 4v4"/><path d="M11 2v4h4M6 8h3M6 12h2"/><path d="M14 13v-2h6v2"/><rect x="11" y="13" width="12" height="6" rx="1.2"/><path d="M14 17h6v5h-6z"/>',
        setaPerspectiva: '<path d="M10.5 2.5h3.5l.8 8.5h5.7L12 21.5 3.5 11h6.2z"/><path d="M14 2.5l.8 8.5"/><path d="M12.2 2.5L12 21.5" stroke-width="1" opacity=".5"/>',
        documentoBusca: '<path d="M13 3H5v17h6"/><path d="M13 3l4 4v3"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="M18 18l3 3M8 8h3M8 11.5h2.5"/>',
        sacoDinheiro: '<path d="M9 6h6l-1.5-3h-3zM9 6c-4 3-5.5 6.5-5.5 9.5C3.5 19 6 21 12 21s8.5-2 8.5-5.5c0-3-1.5-6.5-5.5-9.5"/><path d="M14 11.5c-.4-.8-1.2-1.2-2-1.2-1.3 0-2.2.6-2.2 1.6s1 1.3 2.2 1.6 2.3.7 2.3 1.7-1 1.6-2.3 1.6c-1 0-1.9-.5-2.3-1.3M12 9v1.3M12 16.8v1.2"/><path d="M20 2.5v3M18.5 4h3M3.5 3v2.5M2.3 4.2h2.5" stroke-width="1.5"/>',
        mapa: '<path d="M3 7l5-2 6 2 6-2v13l-6 2-6-2-5 2z"/><path d="M8 5v13M14 7v4"/><path d="M17 20.5s-3.5-3.2-3.5-5.8a3.5 3.5 0 0 1 7 0c0 2.6-3.5 5.8-3.5 5.8z" class="dt-k-vermelho"/><circle cx="17" cy="14.7" r=".9" class="dt-k-vermelho"/>',
        livro: '<path d="M7 3h12l-3 15H4z"/><path d="M4 18l-.3 1.5c-.2 1 .4 1.5 1.3 1.5h11l3-15"/><path d="M9 7.5h6"/>',
        carroEntrega: '<path d="M3 15l1.3-3.5h7.4L13 15" class="dt-k-azul"/><rect x="2" y="15" width="12" height="4" rx="1.2" class="dt-k-azul"/><path d="M4.5 19v1.5M11.5 19v1.5" class="dt-k-azul"/><path d="M10 8a6 6 0 0 1 10.5 1.5M21 5v4.5h-4.5"/>',
        quebraCabeca: '<path d="M4 8h4a2.5 2.5 0 1 1 5 0h4v4a2.5 2.5 0 1 1 0 5v4h-4.5a2.5 2.5 0 1 0-4.5 0H4v-4.5a2.5 2.5 0 1 0 0-4.5z"/>',
        reciclar: '<path d="M8.61 9.48L12 3.6L13.04 5.4M17.09 12.42L20.49 18.3L18.4 18.3M10.3 18.3L3.51 18.3L4.55 16.5"/><path d="M15.54 9.73L10.62 6.8L15.47 4zM13.4 18.3L18.4 15.5L18.4 21.1zM7.05 12.17L6.98 17.9L2.13 15.1z" fill="currentColor" stroke-width="1.2"/>',
        apertoNao: '<path d="M11 5L7.5 9a1.3 1.3 0 0 0 1.8 1.9L12 8.5l5.5 5.5a1.3 1.3 0 0 1-1.8 1.9l-1.5-1.5 1 1a1.3 1.3 0 0 1-1.8 1.9l-1-1 .5.5a1.3 1.3 0 0 1-1.8 1.9L8 15.5 4 14M2 12l3-6 3 1 3-2 3 1M22 12l-3-6-3.5 1.2M5 6l-3 6 2 2M19 6l3 6-3.5 3"/><circle cx="12" cy="12" r="10" class="dt-k-vermelho" stroke-width="1.8"/><path d="M5 5l14 14" class="dt-k-vermelho" stroke-width="1.8"/>',
        rodaCores: '<g stroke-width="4.5" stroke-linecap="butt"><path d="M12 4.5a7.5 7.5 0 0 1 6.5 3.75" class="dt-k-vermelho"/><path d="M18.5 8.25a7.5 7.5 0 0 1 0 7.5" class="dt-k-amarelo"/><path d="M18.5 15.75A7.5 7.5 0 0 1 12 19.5" class="dt-k-verde"/><path d="M12 19.5a7.5 7.5 0 0 1-6.5-3.75" class="dt-k-ciano"/><path d="M5.5 15.75a7.5 7.5 0 0 1 0-7.5" class="dt-k-azul"/><path d="M5.5 8.25A7.5 7.5 0 0 1 12 4.5" class="dt-k-magenta"/></g>',
        nuvemTroca: '<path d="M7 19a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.2A4 4 0 0 1 17.5 19z"/><path d="M8.5 12.5h7l-2-2M15.5 15.5h-7l2 2"/>',
        balde: '<path d="M4.5 8h15l-2 13h-11z"/><path d="M4.5 8a7.5 6 0 0 1 15 0" stroke-width="1.6"/><path d="M6 12.5c2 1 4 1 6 0s4-1 6 0" class="dt-k-ciano"/>',
        pix: '<path d="M12 2.8l3.3 3.3-2 2a1.9 1.9 0 0 1-2.6 0l-2-2zM12 21.2l-3.3-3.3 2-2a1.9 1.9 0 0 1 2.6 0l2 2zM2.8 12l3.3-3.3h1.3l2.6 2.6a1 1 0 0 1 0 1.4l-2.6 2.6H6.1zM21.2 12l-3.3 3.3h-1.3l-2.6-2.6a1 1 0 0 1 0-1.4l2.6-2.6h1.3z" fill="currentColor" stroke-width="1.4"/>',
        globoUpload: '<path d="M15.4 10A6.5 6.5 0 1 0 10 15.4" class="dt-k-azul" stroke-width="1.6"/><path d="M2.5 9h5M9 2.5C7.3 4.3 6.5 6.5 6.5 9" class="dt-k-azul" stroke-width="1.6"/><path d="M10 10h8.5l2.5 2.5V22H10z"/><path d="M15.5 20v-6M13 16.5l2.5-2.5 2.5 2.5"/>',
        documentosSeta: '<path d="M3 4h6l2.5 2.5V17H3z"/><path d="M13.5 6.5H17l2.5 2.5V20H11v-1.5"/><path d="M5.5 11.5h7M10.5 9.5l2 2-2 2" class="dt-k-verde"/>',
        binoculo: '<circle cx="6.5" cy="16" r="4"/><circle cx="17.5" cy="16" r="4"/><path d="M10.5 16h3M3 14.5l2-8h3l1.5 7M21 14.5l-2-8h-3l-1.5 7M10 9h4"/>',
        fsMais: '<text x="1" y="21" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="19" letter-spacing="-1" fill="currentColor" stroke="none" class="dt-k-azul">fs</text><path d="M20 2.5v7M16.5 6h7" class="dt-k-vermelho" stroke-width="2.6" stroke-linecap="butt"/>',
        pacoteEntrega: '<path d="M2.5 11l6-3 6 3v7l-6 3-6-3z"/><path d="M2.5 11l6 3 6-3M8.5 14v7"/><path d="M12 6a6 6 0 0 1 9 2M21.5 4.5V8.5h-4"/>',
        usuarioSeta: '<circle cx="8" cy="7.5" r="3.5"/><path d="M1.5 20c0-4 3-6.5 6.5-6.5 1.6 0 3 .5 4 1.3"/><path d="M14 16h8M19 13l3 3-3 3"/>',
        movimento: '<rect x="3" y="4" width="13" height="16" rx="1.5"/><path d="M6.5 8.5h6M6.5 12h6M6.5 15.5h3"/><path d="M14 14h8M19 11l3 3-3 3"/>',
        chaveMartelo: '<g class="dt-k-texto" opacity=".6"><path d="M22.11 4.59L19.02 4.98L19.41 1.89A3.6 3.6 0 1 0 22.11 4.59z"/><path d="M16 8L5 19" stroke-width="2.6"/></g><path d="M19.6 19.6L10.4 10.4" stroke-width="2.6"/><path d="M4.2 8.4l4.2-4.2 1.4 1.4 1.8-.6 1.8 1.8-5.6 5.6-1.8-1.8.6-1.8z" class="dt-k-texto" opacity=".75" fill="currentColor" stroke-width="1.2"/>',
        chassi: '<path d="M9.5 2.5l-1 4v11l1 4M14.5 2.5l1 4v11l-1 4M8.5 9h7M8.5 14.5h7"/><rect x="3" y="4.5" width="3.5" height="5" rx="1" fill="currentColor"/><rect x="17.5" y="4.5" width="3.5" height="5" rx="1" fill="currentColor"/><rect x="3" y="14.5" width="3.5" height="5" rx="1" fill="currentColor"/><rect x="17.5" y="14.5" width="3.5" height="5" rx="1" fill="currentColor"/><path d="M6.5 7h2M15.5 7h2M6.5 17h2M15.5 17h2"/>',
    };
    const SVG_ATRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    // <svg> do ícone como elemento (sem innerHTML, que gera aviso na validação do AMO). Cada ícone é lido uma
    // vez pelo DOMParser e clonado com importNode, porque cada tela é um iframe com o próprio document.
    const svgModelos = new Map();
    function svgIconeEl(doc, nome) {
        let modelo = svgModelos.get(nome);
        if (!modelo) {
            const xml = `<svg xmlns="http://www.w3.org/2000/svg" class="dt-svg" ${SVG_ATRS} aria-hidden="true" focusable="false">${ICONES[nome] || ''}</svg>`;
            modelo = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
            if (modelo.namespaceURI !== 'http://www.w3.org/2000/svg' || modelo.localName !== 'svg') {
                console.warn('[Dealer/Tema] ícone com XML inválido:', nome);
                modelo = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" class="dt-svg" ${SVG_ATRS} aria-hidden="true" focusable="false"/>`, 'image/svg+xml').documentElement;
            }
            svgModelos.set(nome, modelo);
        }
        if (!svgEnquadrados.has(nome) && enquadrar(doc, modelo)) svgEnquadrados.add(nome);
        return doc.importNode(modelo, true);
    }
    // Desenho que usa pouco da grade 24x24 (setas, chevrons, pontos) fica pequeno perto da imagem original: mede o
    // desenho uma vez (precisa estar num documento renderizado) e, se ocupa menos de ~19 de 24, amplia pelo viewBox
    // (até 1,5x, centrado no desenho), afinando o traço na mesma proporção. Devolve false se não deu para medir
    // (documento sem layout ainda): tenta de novo na próxima vez.
    const svgEnquadrados = new Set();
    function enquadrar(doc, modelo) {
        let t = null;
        try {
            const raiz = doc.body || doc.documentElement;
            if (!raiz) return false;
            t = doc.importNode(modelo, true);
            t.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:24px;height:24px;visibility:hidden');
            raiz.appendChild(t);
            const b = t.getBBox();
            if (!b.width && !b.height) return !modelo.firstChild;   // vazio de verdade: nada a fazer
            const lado = Math.max(b.width, b.height) + 2;
            if (lado < 19) {
                const z = Math.min(1.5, 21 / lado), v = 24 / z, arred = n => Math.round(n * 100) / 100;
                modelo.setAttribute('viewBox', `${arred(b.x + b.width / 2 - v / 2)} ${arred(b.y + b.height / 2 - v / 2)} ${arred(v)} ${arred(v)}`);
                modelo.setAttribute('stroke-width', String(arred(2 / z)));
                modelo.setAttribute('data-dt-zoom', String(arred(z)));
            }
            return true;
        } catch (e) {
            return false;
        } finally {
            if (t && t.parentNode) t.parentNode.removeChild(t);
        }
    }
    // campos de texto (input de texto, textarea, select), menos os do ExtJS e os que o site destaca com cor própria
    const CAMPOS_TEXTO = ['input:not([type]),input:is([type="text" i],[type="password" i],[type="search" i],[type="email" i],[type="number" i],[type="tel" i],[type="url" i],[type="date" i],[type="time" i],[type="datetime-local" i])', 'textarea', 'select'];
    const CAMPOS_FORA = ':not(.x-form-field,.WarningAttribute,.ErrorAttribute,.AttAlterado,.BlobContentAttAlterado)';
    const camposTexto = estado => CAMPOS_TEXTO.map(t => `:is(${t})${CAMPOS_FORA}${estado}`).join(',');
    // máscara CSS: o elemento pinta background-color (currentColor) só onde o ícone tem traço
    const BANDEIRA_BR = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 14"><rect width="20" height="14" rx="1.6" fill="#009c3b"/><path d="M10 1.7 18 7l-8 5.3L2 7z" fill="#ffdf00"/><circle cx="10" cy="7" r="3.3" fill="#002776"/><path d="M6.85 6.2c2.3-.55 4.6-.15 6.35 1.05" fill="none" stroke="#fff" stroke-width=".75"/></svg>');
    function mascaraUrl(nome) {
        return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${SVG_ATRS.replace('stroke-width="2"', 'stroke-width="2.3"')}>${ICONES[nome]}</svg>`)}")`;
    }
    function mascara(nome, tam) {
        const u = mascaraUrl(nome);
        return `-webkit-mask:${u} center/${tam} no-repeat;mask:${u} center/${tam} no-repeat;`;
    }

    // ------------------------------------------------------------------------------------------------
    // Imagens do GeneXus -> HTML. A regra sai do nome do arquivo (sem pasta/extensão, minúsculo). tipo:
    //   manter  - não mexe (logos)
    //   texto   - botão desenhado com texto (btn*.png): vira <button> com ícone + texto
    //   icone   - imagem-ícone clicável ou não: vira botão/ícone SVG (caixa: com cara de botão)
    //   check   - caixinha marcada/desmarcada (IcoMarcado.gif / IcoMarcadoD.gif)
    //   amostra - quadradinho de cor de legenda: vira um <span> com a cor traduzida
    // A imagem original fica no lugar, escondida; o elemento novo repassa o clique para ela, então os
    // eventos do GeneXus (gx.evt.execEvt, linha da grade, seletor de data etc.) continuam os mesmos.
    // ------------------------------------------------------------------------------------------------

    // Botões com texto: nome do arquivo -> [texto (como está desenhado), ícone, cor, {desativado}]
    const BOTOES = {
        btnatualizar: ['Atualizar', 'atualizar', 'azul'],
        btnconsultar: ['Consultar', 'busca', 'azul'],
        btnfiltroselecao: ['Filtro Seleção', 'filtro', 'amarelo'],
        btnlimparfiltro: ['Limpar Filtro', 'limparFiltro', 'verde'],
        btnnovoprospect: ['Novo Prospect', 'usuarioMais', 'verde'],
        btnadicionar: ['Adicionar', 'mais', 'verde'],
        // ActionInsert.gif (#INSERT, ícone pequeno de inserir das grades WWP): vira o botão padrão "+ Adicionar"
        actioninsert: ['Adicionar', 'mais', 'verde'],
        btnfechar: ['Fechar', 'fechar', 'vermelho'],
        btnconfirmar: ['Confirmar', 'check', 'verde'],
        btnmenu: ['Acesso Menu', 'checklist', 'azul'],
        btnbotao: ['Acesso Botão', 'cadeado', 'amarelo'],
        btnusuario: ['Usuário', 'usuarios', 'azul'],
        btneliminar: ['Excluir', 'lixeira', 'vermelho'],
        btnimprimir: ['Imprimir', 'imprimir', 'ciano'],
        btnimprimirservicos_cd: ['Serviços', 'imprimir', 'ciano'],
        btncomprovanterecall: ['Comprovante Recall', 'imprimir', 'ciano'],
        btnhistorico: ['Histórico', 'relogio', 'azul'],
        btnauditoria: ['Auditoria', 'usuarioBusca', 'magenta'],
        // Pessoa
        btnfichacadastral: ['Ficha Cadastral', 'documentoCheck', 'verde'],
        btnempresa: ['Empresa', 'predio', 'azul'],
        btnanalisecredito: ['Análise Crédito', 'documentoBusca', 'azul'],
        btnfaturamento: ['Faturamento', 'dinheiro', 'verde'],
        btndesconto: ['Política de Desconto', 'etiqueta', 'azul'],
        btnsegmercado: ['Segmento Mercado', 'segmento', 'azul'],
        btnenquadramento: ['Enquadramento', 'enquadrar', 'magenta'],
        btnfinanceiro: ['Financeiro', 'cifrao', 'verde'],
        btncredito: ['Crédito', 'cifrao', 'verde'],
        btnemailnovo: ['E-mail', 'envelope', 'amarelo'],
        btnendereco: ['Endereço', 'casa', 'vermelho'],
        btntelefones: ['Telefones', 'telefone', 'azul'],
        btncontato: ['Contatos', 'usuarios', 'azul'],
        btndocumentos: ['Documentos', 'documento', 'ciano'],
        btndigitalizados: ['Doc. Digitalizado', 'digitalizar', 'azul'],
        btnveiculo: ['Veículo', 'carro', 'azul'],
        btnagendarentrega: ['Agendar Entrega', 'carro', 'verde'],
        btnconfirmaagendamento: ['Confirmar Agendamento', 'calendarioCheck', 'verde'],
        btnorcamento: ['Orçamento', 'prancheta', 'amarelo'],
        btnservicosofertados: ['Serviços Ofertados', 'ferramentas', 'azul'],
        btnregrauso: ['Regra de Uso', 'cadeado', 'amarelo'],
        btnocorrencia: ['Ocorrência', 'alfinete', 'amarelo'],
        btnregrafiscal: ['Regra Fiscal', 'documento', 'azul'],
        btnchaveacesso: ['Chave Acesso', 'chaveAcesso', 'amarelo'],
        btnlgpd: ['LGPD', 'escudo', 'laranja'],
        btncotacaoseguro: ['Cotação Seguro', 'escudo', 'verde'],
        btndeclaracaoprivacidade: ['Declaração de Privacidade', 'cadeado', 'azul'],
        // Ordem de Serviço
        btncampanha: ['Campanha', 'megafone', 'laranja'],
        btnseguradora: ['Seguradora', 'escudo', 'verde'],
        btninformacao: ['Informação', 'info', 'azul'],
        btnpertences: ['Pertences', 'bolsa', 'amarelo'],
        btnvistoriacarro: ['Vistoria', 'carroBusca', 'vermelho'],
        btndesfazerentregaveiculo: ['Desfazer Entrega', 'desfazer', 'vermelho'],
        btnmarcacao: ['Marcação', 'cronometro', 'azul'],
        btnfoto: ['Fotos', 'camera', 'ciano'],
        btngarantia: ['Garantia', 'certificado', 'verde'],
        btnservicosadicionais: ['Serviços Adicionais', 'ferramentas', 'laranja'],
        btnmotorista: ['Motorista', 'usuario', 'laranja'],
        btnlocalrealizacao: ['Local Realização', 'casa', 'azul'],
        btnlocalrealizacaod: ['Local Realização', 'casa', 'azul', { desativado: true }],
        btnadiantamento: ['Adiantamento', 'cartao', 'ciano'],
        btnfichadesegmento: ['Ficha Seguimento', 'documento', 'laranja'],
        btnfichaacompanhamento: ['Ficha Acompanhamento', 'documentoCheck', 'verde'],
        btnchecklist: ['CheckList', 'checklist', 'ciano'],
        btnconsultaorma: ['Consulta ORMA', 'busca', 'azul'],
        btnconsultabyd: ['Consulta BYD', 'busca', 'azul'],
        btnconsultaicm: ['Consulta ICM', 'busca', 'azul'],
        btnconsultath2: ['Consulta TH2', 'busca', 'azul'],
        btnconsultavmf: ['Consulta VMF', 'busca', 'azul'],
        btnconsultahsv: ['Consulta HSV', 'busca', 'azul'],
        btndcheck: ['D-Check', 'atualizar', 'verde'],
        btnintegracao: ['Integração', 'ligacao', 'verde'],
        btnpesquisa: ['Pesquisa', 'mensagem', 'azul'],
        btnrecall: ['Recall', 'carro', 'vermelho'],
        btnrecallhonda: ['Recall Honda', 'documentoBusca', 'vermelho'],
        btnelsapro: ['Elsa Pro', 'ligacao', 'verde'],
        btnimagemfastservice: ['Imagens', 'fsMais', 'azul'],
        btninfoveiculo: ['Info Veículo', 'aviso', 'vermelho'],
        btnpacotefechado: ['Pacote Fechado', 'pacote', 'laranja'],
        btnquicklane: ['Quick Lane', 'raio', 'azul'],
        // Relatórios
        btngerar: ['Gerar', 'imprimir', 'ciano'],
        btnexcel: ['Excel', 'planilha', 'verde'],
        // Inventário
        btncancelar: ['Cancelar', 'cancelar', 'vermelho'],
        btncontagem: ['Contagem', 'calculadora', 'azul'],
        btndescancelar: ['Descancelar', 'desfazer', 'verde'],
        btndesfazer: ['Desfazer', 'desfazer', 'azul'],
        btndivergencia: ['Divergência', 'aviso', 'amarelo'],
        btnexportarq: ['Exportar', 'exportar', 'vermelho'],
        btngerarmovnf: ['Gerar Mov / NF', 'engrenagem', 'azul'],
        btninventarionf: ['Notas Fiscais', 'documento', 'azul'],
        btnnotadebito: ['Nota de Débito', 'imprimir', 'ciano'],
        btnprocurar: ['Procurar', 'busca', 'azul'],
        btnprodutosinventario: ['Produtos', 'pacote', 'azul'],
        // Ordem de Serviço > Tipo de OS
        btnautorizar: ['Autorizar', 'positivo', 'verde'],
        btnnaoautorizar: ['Não Autorizar', 'bloqueado', 'vermelho'],
        btngeraros: ['Gerar O.S', 'ferramentas', 'laranja'],
        btnsim: ['Sim', 'check', 'verde'],
        btnnao: ['Não', 'fechar', 'vermelho'],
        // Atendimento / entrega / outros (lista mandada pelo usuário)
        btnatrasados: ['Atrasados', 'relogio', 'vermelho'],
        btnentregaveiculo: ['Entregar Veículo', 'carroEntrega', 'verde'],
        btn_nfempenho: ['Empenho', 'aperto', 'azul'],
        btnaceiteproposta: ['Aceito', 'aperto', 'verde'],
        btnnaoaceiteproposta: ['Não Aceito', 'apertoNao', 'azul'],
        btncontraproposta: ['Contra Proposta', 'aperto', 'laranja'],
        btnaplicardescontos: ['Aplicar Descontos', 'porcentagem', 'verde'],
        btnarquivo: ['Arquivos', 'documento', 'azul'],
        btnassinaturamobile: ['Assinatura', 'editar', 'azul'],
        btnatualizar2: ['Atualizar', 'atualizar', 'verde'],
        btncheckout: ['CheckOut', 'carrinho', 'verde'],
        btncomissao: ['Comissão', 'cifrao', 'verde'],
        btnconsultaprecodaf: ['Consulta Preço DAF', 'etiqueta', 'vermelho'],
        btncontultacreditodaf: ['Consulta Crédito DAF', 'cifrao', 'verde'],
        btncontroleentrega: ['Controle Entrega', 'caminhao', 'amarelo'],
        btncusto: ['Custo', 'calculadora', 'verde'],
        btndespachante: ['Despachante', 'usuario', 'azul'],
        btndesvincular: ['Desvincular', 'trocar', 'laranja'],
        btndocdinammico: ['Documento Dinâmico', 'documento', 'azul'],
        btnfinalizar: ['Finalizar', 'check', 'verde'],
        btnfinanciamento: ['Financiamento', 'calculadora', 'verde'],
        btninformacoesadicionais: ['Informações Adicionais', 'info', 'azul'],
        btnitens: ['Itens', 'pacote', 'azul'],
        btnlistaseparacaodisabled: ['Gerar Lista de Separação', 'checklist', 'laranja', { desativado: true }],
        btnlistaseparacaook: ['Lista Separação', 'checklist', 'verde'],
        btnmarcar: ['Marcar Página', 'caixaCheck', 'azul'],
        btnmodeloveiculo: ['Modelo Veículo', 'carro', 'azul'],
        btnmonitorfandi: ['Monitor F&I', 'monitor', 'azul'],
        btnnfadiantamento: ['NF Adiantamento', 'cartao', 'azul'],
        btnparcelas: ['Parcelas', 'dinheiro', 'verde'],
        btnpedido: ['Pedido', 'prancheta', 'azul'],
        btnpreview: ['Preview', 'busca', 'azul'],
        btnprevisao_cd: ['Previsão', 'calendario', 'vermelho'],
        btnprocessar: ['Processar', 'engrenagem', 'azul'],
        btnprospect: ['Prospect', 'usuario', 'azul'],
        btnrateio: ['Rateio', 'cifrao', 'verde'],
        btnaceite: ['Aceite', 'check', 'verde'],
        btnatendimento: ['Atendimento', 'usuario', 'azul'],
        btnchassi: ['Chassi Veículo', 'chassi', 'azul'],
        btnilhachassi: ['Ilha Chassi', 'chassi', 'azul'],
        btnimpetiqueta: ['Imprimir Etiqueta', 'imprimir', 'ciano'],
        btnmotivo: ['Motivos', 'checklist', 'magenta'],
        btnresumoverificacoesespelho: ['Resumo Verificações', 'imprimir', 'ciano'],
        btntransfsg: ['Repetir Transferência', 'atualizar', 'verde'],
        btnembalar: ['Embalar Produto', 'pacote', 'laranja'],
        btnentregarproduto: ['Entregar', 'pacoteEntrega', 'azul'],
        btnrateiopadrao: ['Rateio Padrão', 'porcentagem', 'azul'],
        btnspedreinf: ['Sped REINF', 'sped', 'laranja'],
        btntransporte: ['Transporte', 'caminhao', 'verde'],
        btnreabrir: ['Reabrir', 'chave', 'amarelo'],
        btnrecibo: ['Recibo', 'documentoCheck', 'azul'],
        btnreserva: ['Reserva', 'alfinete', 'azul'],
        btnretorno: ['Retorno', 'desfazer', 'azul'],
        btnrevisaonamedida: ['Revisão na Medida', 'checklist', 'azul'],
        btnrodape: ['Rodapé', 'mensagem', 'azul'],
        btnsimulavenda: ['Simula Venda', 'calculadora', 'azul'],
        btnsolicitarautorizacao: ['Solicitar Autorização', 'aviso', 'amarelo'],
        btnsolicitarautorizacaofinanceira: ['Autorização Financeira', 'cifrao', 'verde'],
        btntabela: ['Tabela', 'planilha', 'azul'],
        btntenhointeresse: ['Tenho Interesse', 'prancheta', 'verde'],
        btntmo: ['TMO', 'cronometro', 'azul'],
        btntributoedita: ['Diferença ICMS', 'porcentagem', 'magenta'],
        btnvaloragregado: ['Valor Agregado', 'dinheiro', 'amarelo'],
        btnvolume: ['Volume', 'pacote', 'amarelo'],
        btnxml: ['XML', 'globo', 'azul'],
        btnanalisepedidocompra: ['Análise Pedido', 'grafico', 'azul'],
        btncancelarbackorder: ['Cancelar Back Order', 'cancelar', 'vermelho'],
        btnconferido: ['Conferido', 'check', 'verde'],
        btnconsorcio: ['Consórcio', 'grafico', 'amarelo'],
        btnfrota: ['Frota', 'carro', 'vermelho'],
        btnhobby: ['Hobby', 'estrela', 'azul'],
        btnincluiritensderequisicao: ['Incluir Itens de Requisição', 'editar', 'azul'],
        btnintercambiaveis: ['Intercambiáveis', 'trocar', 'verde'],
        btnmensageria: ['Mensageria', 'envelope', 'amarelo'],
        btnpreposto: ['Preposto', 'usuario', 'azul'],
        btnprofissional: ['Profissional', 'usuario', 'azul'],
        btnprorrogar: ['Prorrogar', 'calendario', 'azul'],
        btnrefcomercial: ['Ref Comercial', 'carrinho', 'verde'],
        btnrefpessoal: ['Ref Pessoal', 'mensagem', 'ciano'],
        btnrequisicoesatendidas: ['Requisições Atendidas', 'prancheta', 'azul'],
        btnresponderdepois: ['Responder Depois', 'relogio', 'laranja'],
        btnsociobeneficiario: ['Sócio ou Benef. Final', 'usuarios', 'azul'],
        // mapeados na varredura de todas as telas do menu (v1.10.0)
        btn_agregacao: ['Perc. Agregação', 'porcentagem', 'azul'],
        btn_atualizar: ['Atualizar', 'atualizar', 'verde'],
        btn_reenviar: ['Reenviar', 'enviar', 'laranja'],
        btnacessorio: ['Acessórios', 'ferramentas', 'azul'],
        btnadicional: ['Adicional', 'porcentagem', 'azul'],
        btnadvogado: ['Advogado', 'balanca', 'azul'],
        btnagencia: ['Agência', 'predio', 'verde'],
        btnagendamento: ['Agendamento', 'calendario', 'vermelho'],
        btnagentecobrador: ['Agente Cobrador', 'cifrao', 'azul'],
        btnatualizatotal: ['Atualiza Total', 'atualizar', 'azul'],
        btnautomacao: ['Automação', 'engrenagem', 'azul'],
        btnaviso: ['Aviso', 'aviso', 'amarelo'],
        btnbancario: ['Bancário', 'dinheiro', 'verde'],
        btnbloqueio: ['Bloqueio', 'cadeado', 'amarelo'],
        btnbolsao: ['Bolsão', 'bolsa', 'azul'],
        btnbox: ['Box', 'pacote', 'laranja'],
        btnclasabcajuste: ['Ajuste', 'ajustar', 'azul'],
        btnclasabcalterarusuario: ['Alterar Usuário', 'usuario', 'azul'],
        btnclasabccliente: ['Cliente', 'usuario', 'azul'],
        btnclasabcclientefrequencia: ['Frequência', 'relogio', 'azul'],
        btnclasabcclientemargem: ['Margem', 'porcentagem', 'azul'],
        btnclasabcclientemediacompra: ['Média Compra', 'carrinho', 'azul'],
        btnclasabcclientepagamento: ['Pagamento', 'dinheiro', 'azul'],
        btnclasabcclientevenda: ['Vendas', 'cifrao', 'azul'],
        btnclasabcestoque: ['Estoque', 'pacote', 'azul'],
        btnclasabcpeso: ['Peso', 'grafico', 'azul'],
        btnclasabcpopularidade: ['Popularidade', 'estrela', 'azul'],
        btnclasabcvalidarclassificacao: ['Validar Classificação', 'check', 'azul'],
        btnclasabcvenda: ['Venda', 'cifrao', 'azul'],
        btncobranca: ['Cobrança', 'cifrao', 'verde'],
        btnconciliar: ['Conciliar', 'quebraCabeca', 'azul'],
        btnconfigura: ['Configuração', 'ferramentas', 'azul'],
        btnconfiguraestado: ['Estado', 'ferramentas', 'azul'],
        btnconfigurancm: ['NCM', 'ferramentas', 'azul'],
        btnconsultadebitos: ['Consulta Débito', 'busca', 'azul'],
        btnconsultaragendamentoford: ['Consultar Agendamento Ford', 'busca', 'azul'],
        btnconvenio: ['Convênio', 'usuarios', 'laranja'],
        btncor: ['Cor', 'rodaCores', 'magenta'],
        btncorrigir: ['Corrigir', 'check', 'verde'],
        btncredores: ['Credores', 'usuario', 'azul'],
        btncustodia: ['Custódia', 'dinheiro', 'azul'],
        btndda: ['DDA', 'reciclar', 'verde'],
        btndadosbyd: ['Dados BYD', 'info', 'azul'],
        btndashboard: ['Dashboard', 'grafico', 'amarelo'],
        btndepararange: ['Range', 'busca', 'azul'],
        btndesautorizar: ['Desautorizar', 'cancelar', 'vermelho'],
        btndescontos: ['Descontos', 'porcentagem', 'verde'],
        btndesvincularnotafiscal: ['Desvincular Nota Fiscal', 'trocar', 'laranja'],
        btndetalhes: ['Detalhes', 'planilhaDetalhada', 'azul'],
        btnemailenviar: ['Enviar E-mail', 'envelope', 'amarelo'],
        btnencerrar: ['Encerrar', 'check', 'verde'],
        btnenviarsms: ['Enviar SMS', 'celular', 'azul'],
        btnescriturar: ['Escriturar', 'editar', 'laranja'],
        btnescriturarnfpropria: ['Escriturar', 'editar', 'vermelho'],
        btnespecificacao: ['Especificação', 'ferramentas', 'azul'],
        btnestado: ['Estados', 'ferramentas', 'azul'],
        btnextrato: ['Extrato', 'documento', 'vermelho'],
        btnfamiliaveiculo: ['Família Veículo', 'carro', 'amarelo'],
        btnfaturapendentegerarfatura: ['Gerar Fatura', 'caixaCheck', 'azul'],
        btnfaturaspendentesalteracondicaopagamento: ['Altera Condição Pagamento', 'trocar', 'amarelo'],
        btnfechamentogeral: ['Fechamento Geral', 'ferramentas', 'azul'],
        btnfichaproduto: ['Ficha de Produto', 'checklist', 'verde'],
        btngerargeral: ['Gerar', 'engrenagem', 'azul'],
        btngerarplanilha: ['Gerar Planilha', 'planilha', 'verde'],
        btngerarrevp: ['Gerar REVP', 'engrenagem', 'azul'],
        btngrafico: ['Gráfico', 'grafico', 'laranja'],
        btngravar: ['Gravar', 'check', 'verde'],
        btngrupocampo: ['Grupo Campo', 'livro', 'magenta'],
        btngrupomercadoria: ['Grupo de Mercadoria', 'pacote', 'laranja'],
        btnhistoricoreferencia: ['Histórico Referência', 'relogio', 'ciano'],
        btnimagem: ['Imagem', 'camera', 'azul'],
        btnimprevp: ['Imprimir REVP', 'imprimir', 'ciano'],
        btnimprevpvolume: ['Imprimir Volume', 'imprimir', 'ciano'],
        btnimprimiretiqueta: ['Imprimir Etiqueta', 'imprimir', 'ciano'],
        btnimprimiretiquetaservicos: ['Imprimir Serviços', 'imprimir', 'ciano'],
        btnimprimiretiquetatipoos: ['Imprimir Tipo O.S.', 'imprimir', 'ciano'],
        btnimprimirqualidadeentrega: ['Qualidade Entrega', 'imprimir', 'ciano'],
        btnimprimirtipoos_cd: ['Tipo de OS', 'imprimir', 'ciano'],
        btnincluir: ['Processar', 'engrenagem', 'azul'],
        btnincluirtef: ['Incluir', 'cartao', 'azul'],
        btnitemavulso: ['Item Avulso', 'pacote', 'azul'],
        btnkit: ['Kit', 'pacote', 'laranja'],
        btnliberarlote: ['Liberar Lote', 'check', 'verde'],
        btnlimpar: ['Limpar', 'limparFiltro', 'azul'],
        btnlocalizacao: ['Localização', 'binoculo', 'verde'],
        btnmaladiretaviafluxo: ['Mala Direta via Fluxo', 'planilha', 'verde'],
        btnmapeamentoconta: ['Mapeamento', 'planilhaDetalhada', 'azul'],
        btnmarcardesmarcartodos: ['Marc/Des Todos', 'caixaCheck', 'azul'],
        btnmodalidadeservico: ['Modalidade de Serviço', 'ferramentas', 'azul'],
        btnmunicipio: ['Município', 'mapa', 'verde'],
        btnnaturezaoperacao: ['Natureza Operação', 'documento', 'laranja'],
        btnnegar: ['Negar', 'cancelar', 'vermelho'],
        btnordemservico: ['Ordem Serviço', 'ferramentas', 'laranja'],
        btnpartilha: ['Partilha', 'porcentagem', 'azul'],
        btnpergunta: ['Perguntas', 'mensagem', 'azul'],
        btnpix: ['PIX', 'pix', 'ciano'],
        btnplanos: ['Planos', 'checklist', 'vermelho'],
        btnpreco: ['Preço', 'cifrao', 'verde'],
        btnprecoanofabmod: ['Preço Ano', 'cifrao', 'verde'],
        btnprecoempresa: ['Preço Empresa', 'cifrao', 'verde'],
        btnprecomarca: ['Preço Marca', 'cifrao', 'verde'],
        btnpreordem: ['Pré-Ordem', 'imprimir', 'ciano'],
        btnpromocao: ['Promoção', 'cifrao', 'verde'],
        btnproposta: ['Proposta', 'documento', 'azul'],
        btnrac: ['RAC', 'mensagem', 'laranja'],
        btnraccliente: ['RAC Cliente', 'mensagem', 'laranja'],
        btnreabrirpromocao: ['Reabrir', 'desfazer', 'azul'],
        btnreativarpromocao: ['Reativar', 'atualizar', 'azul'],
        btnreenviartodos: ['Reenviar Todos', 'enviar', 'verde'],
        btnregras: ['Regras', 'checklist', 'azul'],
        btnreimprimir: ['Reimprimir', 'imprimir', 'ciano'],
        btnrelacionamento: ['Relacionamento', 'ligacao', 'azul'],
        btnremessa: ['Remessa', 'enviar', 'azul'],
        btnrestricaodesconto: ['Restrição de Desconto', 'porcentagem', 'azul'],
        btnresultadocontato: ['Resultado Contato', 'telefone', 'azul'],
        btnretdesmarcartodos: ['Desmarcar Todos', 'caixa', 'azul'],
        btnretexportar: ['Exportar', 'download', 'verde'],
        btnretexportardistrib: ['XML Distribuição', 'download', 'verde'],
        btnretgerar: ['Gerar', 'exportar', 'verde'],
        btnretimportar: ['Importar', 'globoUpload', 'verde'],
        btnretmarcartodos: ['Marcar Todos', 'caixaCheck', 'azul'],
        btnsalvar: ['Salvar', 'salvar', 'azul'],
        btnservicos: ['Serviços', 'ferramentas', 'azul'],
        btnsimular: ['Simular', 'busca', 'azul'],
        btnsubstituir: ['Substituir', 'trocar', 'azul'],
        btntaxa: ['Taxa', 'porcentagem', 'laranja'],
        btntextocomercial: ['Texto Comercial', 'mensagem', 'azul'],
        btntipoconta: ['Tipo de Conta', 'sacoDinheiro', 'verde'],
        btntipoproduto: ['Tipo Produto', 'reciclar', 'verde'],
        btntitulomovimento: ['Movimento', 'trocar', 'azul'],
        btntitulopagar: ['Título Pagar', 'cifrao', 'vermelho'],
        btntituloreceber: ['Título Receber', 'cifrao', 'verde'],
        btntmotempo: ['TMO Tempo', 'relogio', 'azul'],
        btntransferelocal: ['Transfere Local', 'setaPerspectiva', 'verde'],
        btntransferir: ['Transferir', 'trocar', 'verde'],
        btntransferirdata: ['Transferir Data', 'calendario', 'vermelho'],
        btntransferirempresa: ['Transf. Empresa', 'documentosSeta', 'verde'],
        btntributo2: ['Tributação', 'porcentagem', 'azul'],
        btntributocofins: ['COFINS', 'porcentagem', 'azul'],
        btntributoicms: ['ICMS', 'porcentagem', 'azul'],
        btntributopis: ['PIS', 'porcentagem', 'azul'],
        btnvistorias_cd: ['Check List', 'checklist', 'azul'],
        btnvisualizar: ['Visualizar', 'busca', 'azul'],
        btnwhatsappenviar: ['Enviar WhatsApp', 'whatsapp', 'verde'],
        transferir: ['Transferir', 'trocar', 'verde'],
        wfbtnexecutar: ['Executar', 'engrenagem', 'verde'],
        cancel: ['Fechar', 'fechar', 'vermelho'],
        btnimprimird: ['Imprimir', 'imprimir', 'ciano', { desativado: true }],
        btnlavagem: ['Lavagem', 'balde', 'azul'],
        btnpdf: ['PDF', 'pdf', 'vermelho'],
        btntestdrive: ['Test Drive', 'volante', 'azul'],
        btnteste: ['Teste', 'carro', 'verde'],
        // Usuário
        btnacesso: ['Acesso', 'cadeado', 'amarelo'],
        btnausencia: ['Ausência', 'calendario', 'laranja'],
        btnduplicar: ['Duplicar', 'duplicar', 'azul'],
        btnempresad: ['Empresa', 'predio', 'azul', { desativado: true }],
        btngateway: ['Gateway', 'nuvemTroca', 'azul'],
        btnhorario: ['Horário', 'relogio', 'azul'],
        btnmfareiniciar: ['Reiniciar MFA', 'atualizar', 'laranja'],
        btnperfil: ['Perfil', 'usuario', 'magenta'],
        btnqualificacao: ['Qualificação', 'documentoCheck', 'verde'],
        btnstarid: ['Stars-ID', 'estrela', 'amarelo'],
        btntrocasenha: ['Troca Senha', 'chaveAcesso', 'amarelo'],
        btnworkspace: ['Work Space', 'workspace', 'azul'],
        // Natureza de Operação
        btnobservacao: ['Observação', 'mensagem', 'amarelo'],
        btnpagamento: ['Pagamento', 'cartao', 'verde'],
        btntipoitem: ['Tipo Item', 'engrenagem', 'laranja'],
        btntributo: ['Tributo', 'porcentagem', 'laranja'],
        // Empresa
        btntabelapreco: ['Tabela Preço', 'cifrao', 'verde'],
        btnprioridades: ['Prioridades', 'cronometro', 'azul'],
        btnestoque: ['Estoque', 'pacote', 'azul'],
        btndepartamento: ['Departamento', 'predio', 'magenta'],
        btnmarca: ['Marca', 'etiqueta', 'laranja'],
        btnparametrogeral: ['Geral', 'engrenagem', 'azul'],
        btnoficina: ['Oficina', 'ferramentas', 'laranja'],
        btnproduto: ['Produto', 'pacote', 'verde'],
        btnnotafiscal: ['Nota Fiscal', 'documento', 'ciano'],
        btnescfiscal: ['Esc. Fiscal', 'editar', 'laranja'],
        btncontabil: ['Contábil', 'calculadora', 'verde'],
        btnclink: ['C-Link', 'ligacao', 'amarelo'],
        btntef: ['TEF', 'cartao', 'azul'],
        btninventario: ['Inventário', 'checklist', 'ciano'],
        btndistribuicao: ['Distribuição', 'caminhao', 'amarelo'],
        btndistribuicaodisable: ['Distribuição', 'caminhao', 'amarelo', { desativado: true }],
        btncontrato: ['Contratos', 'documento', 'azul'],
        btnfastservice: ['Fast Service', 'fsMais', 'azul'],
        btnfastrental: ['Fast Rental', 'carro', 'vermelho'],
        btnfastpartscheck: ['Fast Parts Check', 'check', 'azul'],
    };
    // Ícones: nome do arquivo -> [ícone, cor, {titulo, caixa (cara de botão), clique}]
    const IMG_ICONES = {
        actionupdate: ['editar', 'laranja', { titulo: 'Modifica' }],
        actiondelete: ['lixeira', 'vermelho', { titulo: 'Elimina' }],
        actiondisplay: ['olho', 'azul', { titulo: 'Exibe' }],
        actionconferenciaerror: ['aviso', 'vermelho'],
        close: ['fechar', 'vermelho', { titulo: 'Fechar' }],
        pagefirst: ['primeira', null, { titulo: 'Primeira página' }],
        pageprevious: ['anterior', null, { titulo: 'Página anterior' }],
        pagenext: ['proxima', null, { titulo: 'Próxima página' }],
        pagelast: ['ultima', null, { titulo: 'Última página' }],
        selectrow: ['checkGrosso', 'verde'],
        unselectrow: ['checkGrosso', 'vermelho'],
        checkboxmarcado: ['check', 'verde'],
        icoalerta: ['alerta', 'laranja'],
        icoerro: ['alerta', 'vermelho'],
        ico_advertencia: ['aviso', 'amarelo'],
        ico_bloqueado: ['bloqueado', 'vermelho'],
        icoinformacao: ['info', 'azul'],
        icoagendamento: ['calendario', 'azul'],
        icocalendario: ['calendario', 'azul'],
        calendar: ['calendario', 'azul', { clique: true }],
        prompt: ['busca', 'azul', { clique: true }],
        icoavaliacao: ['medidor', 'ciano'],
        icocontato: ['telefone', 'verde'],
        icoorcamento: ['prancheta', 'amarelo'],
        icoordemservico: ['chave', 'laranja'],
        icovendedor: ['usuarios', 'magenta'],
        icocliente: ['usuario', 'laranja'],
        icoselpessoa: ['usuario', 'azul'],
        icocarrinho25: ['carrinho', 'verde'],
        icocarrored: ['carro', 'vermelho'],
        icoflaggreen: ['bandeira', 'verde'],
        icoflagyellow: ['bandeira', 'amarelo'],
        icopago: ['cifrao', 'verde'],
        icoprintos: ['imprimirDoc', 'laranja', { titulo: 'Imprimir Ordem de Serviço' }],
        icoreserva: ['documentoCheck', 'azul'],
        icoseguradora: ['escudo', 'verde'],
        ico_desanonimizado: ['olho', 'amarelo'],
        chat: ['mensagem', 'azul'],
        headset: ['ajuda', 'azul'],
        whatsapp: ['whatsapp', 'verde'],
        btnemail: ['envelope', 'amarelo', { caixa: true }],
        btnsms: ['celular', 'azul', { caixa: true }],
        btncaredit: ['carro', 'azul', { caixa: true }],
        btnconfirmarp: ['check', 'verde', { caixa: true, titulo: 'Confirmar' }],
        btndesativar: ['energia', 'vermelho', { caixa: true }],
        icotransfere: ['trocar', 'verde', { titulo: 'Trocar Imagem' }],
        // visualizador de relatório
        icoagendar: ['calendarioRelogio', 'azul', { titulo: 'Agendar relatório' }],
        icoexcel: ['planilha', 'verde', { titulo: 'Excel' }],
        icomaladireta: ['malaDireta', 'verde', { titulo: 'Mala direta (Excel detalhado)' }],
        icoword: ['word', 'azul', { titulo: 'Word' }],
        icopdf: ['pdf', 'vermelho', { titulo: 'PDF' }],
        icoprint1: ['imprimir', 'ciano', { titulo: 'Imprimir' }],
        imglogin: ['usuarios', 'azul', { max: 72 }],
        // Atendimento de veículos / contatos (lista mandada pelo usuário)
        btnavaliacao: ['carroBusca', 'azul', { caixa: true, titulo: 'Solicitar Avaliação do Veículo' }],
        btncarrop: ['carro', 'azul', { caixa: true, titulo: 'Veículos de Interesse do Cliente' }],
        btnencerrarp: ['prancheta', 'verde', { caixa: true, titulo: 'Orçamento' }],
        btnvendabalcao: ['pacote', 'laranja', { caixa: true, titulo: 'Pedido Balcão' }],
        btnvendap: ['carrinho', 'verde', { caixa: true, titulo: 'Comercialização de Veículos' }],
        btnvendedorp: ['usuarios', 'magenta', { caixa: true, titulo: 'Transfere Atendimento' }],
        carro4: ['carro', 'ciano', { titulo: 'Comercialização em Lote' }],
        icoalvo: ['alvo', 'vermelho', { titulo: 'Atendimento de Campanha' }],
        icocalculadoranovo: ['calculadora', 'azul', { caixa: true, titulo: 'Simulação Financiamento' }],
        icocontatonovo: ['telefone', 'verde', { caixa: true, titulo: 'Novo Contato' }],
        icocrmcliente: ['usuario', 'laranja', { caixa: true, titulo: 'Altera Dados do Cliente' }],
        icohistorico: ['checklist', 'azul', { caixa: true, titulo: 'Levantamento das Necessidades' }],
        icoindicacao: ['usuarios', 'verde', { titulo: 'Indicação' }],
        icopesquisa: ['mensagem', 'azul', { titulo: 'Pesquisa de Resgate' }],
        icoproposta: ['documentoCheck', 'verde', { titulo: 'Proposta' }],
        actionupdatedisabled: ['editar', 'laranja', { titulo: 'Modifica (indisponível)', desativado: true }],
        actiondeletedisabled: ['lixeira', 'vermelho', { titulo: 'Elimina (indisponível)', desativado: true }],
        btnincluirsmall: ['mais', 'azul', { titulo: 'Novo Pedido', caixa: true }],
        btnlistasmall: ['checklist', 'azul', { titulo: 'Meus Pedidos', caixa: true }],
        enderecoentrega: ['casa', 'laranja', { titulo: 'Endereço de Entrega' }],
        icocalculadora: ['calculadora', 'verde'],
        icocalendariovermelho: ['calendario', 'vermelho'],
        icoflagred: ['bandeira', 'vermelho'],
        iconecessitaautorizacao: ['aviso', 'amarelo'],
        iconhistorico: ['relogio', 'ciano', { titulo: 'Histórico' }],
        icoparcelas: ['cifrao', 'verde'],
        icoprint: ['imprimir', 'ciano'],
        icopromocao: ['porcentagem', 'verde'],
        icopromocao2: ['porcentagem', 'ciano'],
        icoselproduto: ['pacote', 'amarelo'],
        icotef: ['cartao', 'azul'],
        icotransito: ['caminhao', 'amarelo'],
        icotributo: ['documento', 'laranja'],
        icovoltar: ['desfazer', 'azul', { titulo: 'Voltar' }],
        next: ['proxima', null, { titulo: 'Próximo' }],
        previous: ['anterior', null, { titulo: 'Anterior' }],
        alterasenha: ['cadeadoAberto', 'amarelo', { titulo: 'Alterar Senha' }],
        ico_tabela: ['planilha', 'azul'],
        smallicoagendar: ['calendarioRelogio', 'verde', { titulo: 'Agendar' }],
        wf_grid_priority_header: ['alerta', 'amarelo', { titulo: 'Prioridade' }],
        wf_grid_deadline_header: ['relogio', null, { titulo: 'Prazo' }],
        wf_grid_comments_header: ['mensagem', null, { titulo: 'Comentários' }],
        icoitens: ['organograma', 'azul', { titulo: 'Diagrama do Fluxo' }],
        icoprocessos: ['engrenagem', 'amarelo', { titulo: 'Processos' }],
        // mapeados na varredura de todas as telas do menu (v1.10.0)
        actionconferenciasucess: ['check', 'verde', { titulo: 'Conferência' }],
        actiondownload: ['download', 'verde', { titulo: 'Download' }],
        actionexportreport: ['exportar', 'azul'],
        actionmanage: ['engrenagem', null],
        barcode_2: ['codigoBarras', null],
        btn_barcode: ['codigoBarras', null],
        collapse: ['menos', null],
        copiar: ['duplicar', 'azul'],
        first: ['primeira', null],
        last: ['ultima', null],
        gxuitab_dvelop_close: ['fechar', 'vermelho'],
        ico_selmarcaveiculo: ['bandeira', 'verde'],
        icoautorizado: ['ponto', 'verde', { titulo: 'Autorizado' }],
        icoautorizar: ['check', 'verde'],
        icoaviso: ['aviso', 'amarelo'],
        icobloqueado: ['cadeado', 'laranja'],
        icocarrinhosmall: ['carrinho', 'azul'],
        icoconfigura: ['ferramentas', 'azul'],
        icocontas: ['pasta', 'amarelo'],
        icoconteudo: ['pacote', 'laranja'],
        icoemail: ['envelope', null],
        icoempresa: ['predio', 'azul'],
        icoentregarproduto: ['pacote', 'azul'],
        icoferiado: ['calendario', 'vermelho', { titulo: 'Feriado' }],
        icofiltroselecao: ['filtro', 'amarelo'],
        icoinfoa: ['info', 'azul'],
        icojanelafechar: ['menos', null],
        icolupa: ['busca', 'azul'],
        icomensageria: ['mensagem', null],
        iconepergunta: ['mensagem', 'azul'],
        icopasta: ['pasta', 'amarelo'],
        icopgtoelet: ['cartao', 'verde', { titulo: 'Pagamento eletrônico' }],
        icoreagendar: ['calendario', 'verde', { titulo: 'Reagendar' }],
        icoreclamacao: ['megafone', 'vermelho'],
        icoreimprimir: ['imprimir', 'magenta'],
        icorespondida: ['check', 'verde', { titulo: 'Respondida' }],
        icoselestoque: ['pacote', 'laranja'],
        icoselfuncionario: ['usuario', 'azul'],
        icoselnaturezaoperacao: ['documento', 'azul'],
        icoservico: ['chaveMartelo', 'laranja'],
        icosinalvermelho2: ['ponto', 'vermelho'],
        icotipopessoa: ['usuarios', 'azul'],
        icotmotempo: ['relogio', null],
        icotransferedata: ['calendario', 'azul'],
        icotransfereempresa: ['predio', 'verde'],
        icovalor: ['dinheiro', 'amarelo'],
        icovolume: ['pacote', 'amarelo'],
        imgverdesetaacima: ['setaCima', 'verde'],
        imgvermelhasetaabaixo: ['setaBaixo', 'vermelho'],
        save: ['salvar', 'azul', { titulo: 'Confirmar' }],
        select: ['busca', 'azul'],
        workflowuser2: ['usuario', 'azul'],
        btnretimportarbmp: ['globoUpload', 'verde', { titulo: 'Importar' }],
        btntituloliberarpagamento: ['caixaCheck', 'azul'],
        calendario: ['calendario', 'azul', { clique: true }],
        icopropostad: ['documentoCheck', 'verde', { titulo: 'Nenhuma Proposta', desativado: true }],
        icoraio: ['raio', 'amarelo', { titulo: 'Venda Declarada' }],
        icoselgrupocontabil: ['pasta', 'laranja'],
        icoseltipodocumento: ['documento', 'azul'],
        icoseltributos: ['porcentagem', 'laranja'],
        icosemcontato: ['telefone', 'vermelho', { titulo: 'Sem Contato' }],
        icotestdrive: ['volante', 'azul', { titulo: 'Test Drive' }],
        icovendedornovo: ['usuarios', 'magenta', { caixa: true, titulo: 'Transfere o Vendedor' }],
        deleterow: ['lixeira', 'vermelho', { titulo: 'Remover linha' }],
        // Filtro Seleção
        actionalterar: ['atualizar', 'verde', { titulo: 'Atualizar' }],
        icocancelar: ['limparFiltro', 'vermelho', { titulo: 'Limpar Filtro' }],
        whitefirst: ['primeira', null, { titulo: 'Remover todos', caixa: true }],
        whiteprevious: ['anterior', null, { titulo: 'Remover selecionado', caixa: true }],
        whitenext: ['proxima', null, { titulo: 'Adicionar selecionado', caixa: true }],
        whitelast: ['ultima', null, { titulo: 'Adicionar todos', caixa: true }],
        icoselempresa: ['predio', 'azul'],
        icoseltipotitulo: ['documento', 'amarelo'],
        icoselagentecobrador: ['cifrao', 'verde'],
        icoseldepartamento: ['organograma', 'magenta'],
        icoselcontagerencial: ['calculadora', 'laranja'],
        icoselvendedor: ['usuarios', 'ciano'],
        prompt1: ['busca', 'azul', { clique: true }],
        // Inventário
        icoselecionado: ['check', 'verde'],
        icosinalverde: ['ponto', 'verde'],
        icosinalvermelho: ['ponto', 'vermelho'],
        icosinalamarelo: ['ponto', 'amarelo'],
        icosinalazul: ['ponto', 'azul'],
        icosinalpreta: ['ponto', 'texto'],
        imgsinalazul: ['ponto', 'azul'],
        imgsinalpreta: ['ponto', 'texto'],
        // Ordem de Serviço > Tipo de OS (botões pequenos "P"; "D" = desativado)
        btnatualizartempo: ['relogio', 'azul', { caixa: true, titulo: 'Atualizar Tempo de Serviço' }],
        btncancelarp: ['cancelar', 'vermelho', { caixa: true, titulo: 'Cancelar' }],
        btncancelarpd: ['cancelar', 'vermelho', { caixa: true, titulo: 'Cancelar', desativado: true }],
        btncodigobarrasp: ['codigoBarras', 'texto', { caixa: true, titulo: 'Código de barras' }],
        btndefinirusuario: ['usuario', 'azul', { caixa: true, titulo: 'Definir Produtivo' }],
        btnbloqueiaentrada: ['bloqueado', 'vermelho', { caixa: true, titulo: 'Entrada da Oficina Bloqueada' }],
        icoselconsultortecnico: ['usuarioEditar', 'azul', { titulo: 'Troca Responsável do Agendamento' }],
        icoselconsultortecnicosmall: ['usuarioEditar', 'azul', { titulo: 'Alterar Produtivo' }],
        icoselprodutivo: ['usuarioFerramenta', 'azul', { titulo: 'Selecionar Produtivo' }],
        icoseltipoos: ['ferramentas', 'laranja', { titulo: 'Selecionar Tipo de OS' }],
        buscanf: ['documentoBusca', 'azul', { titulo: 'Buscar NF' }],
        icolink: ['ligacao', null],
        btnetiqueta: ['codigoBarras', 'texto', { caixa: true, titulo: 'Imprimir Etiquetas' }],
        btntitulotransferenciacredor: ['usuarioSeta', 'magenta', { titulo: 'Transferência do Credor' }],
        icotitulomovimento: ['movimento', 'azul', { titulo: 'Movimento' }],
        imgpagametodia: ['cronometro', 'laranja', { titulo: 'Tempo Adicional do Serviço' }],
        btndescontogeral: ['porcentagem', 'vermelho', { caixa: true, titulo: 'Aplicar Desconto Geral' }],
        btndescontogerald: ['porcentagem', 'vermelho', { caixa: true, titulo: 'Aplicar Desconto Geral', desativado: true }],
        btndesfazerp: ['desfazer', 'azul', { caixa: true, titulo: 'Desfazer' }],
        btnfichaacompanhamentop: ['documentoCheck', 'verde', { caixa: true, titulo: 'Ficha de Acompanhamento' }],
        btnmarcacaop: ['cronometro', 'azul', { caixa: true, titulo: 'Marcação' }],
        btnnotafiscalp: ['imprimir', 'ciano', { caixa: true, titulo: 'Emitir Nota Fiscal' }],
        btnnotafiscalitemd: ['documento', 'azul', { caixa: true, titulo: 'Gerar NF', desativado: true }],
        btnprenotap: ['documento', 'verde', { caixa: true, titulo: 'Emitir Pré Nota' }],
        btnprdrequisitar: ['carrinho', 'verde', { caixa: true, titulo: 'Requisitar Produtos' }],
        btnprdrequisitarnov1: ['carrinho', 'laranja', { caixa: true, titulo: 'Regerar Requisição' }],
        btnprdcanrequisicao: ['carrinho', 'vermelho', { caixa: true, titulo: 'Cancelar Requisição' }],
        btnreabresrv: ['cadeadoAberto', 'amarelo', { caixa: true, titulo: 'Reabrir Serviço' }],
        btnreenvio: ['enviar', 'verde', { caixa: true, titulo: 'Reenviar' }],
        btnsrvaprovacao: ['enviar', 'azul', { caixa: true, titulo: 'Solicitar Aprovação' }],
        btnsrvautorizar: ['positivo', 'verde', { caixa: true, titulo: 'Autorizar Execução' }],
        btnsrvdesautorizar: ['bloqueado', 'vermelho', { caixa: true, titulo: 'Desautorizar Execução' }],
        btnsrviniciar: ['play', 'verde', { caixa: true, titulo: 'Iniciar Serviço' }],
        btnsrvparar: ['parar', 'vermelho', { caixa: true, titulo: 'Parar Serviço' }],
        btntransferep: ['trocar', 'verde', { caixa: true, titulo: 'Transferir' }],
        btntransferepd: ['trocar', 'verde', { caixa: true, titulo: 'Transferir', desativado: true }],
        icodaftruckpag: ['etiqueta', 'vermelho', { caixa: true, titulo: 'Consultar Preço DAF Truck Pag' }],
        icodaftruckpag2: ['cifrao', 'verde', { caixa: true, titulo: 'Consultar Crédito DAF Truck Pag' }],
        btnmotor: ['engrenagem', 'laranja', { titulo: 'Troca de Motor' }],
        historicopat: ['busca', 'azul', { titulo: 'Histórico do Veículo' }],
        ico_duplicar: ['duplicar', 'azul'],
        icobloquear: ['bloqueado', 'vermelho'],
        icocadeado: ['cadeado', 'amarelo'],
        icocheck: ['caixaCheck', 'texto'],
        icodetalhemargem: ['calculadora', 'azul'],
        icoiniciar: ['play', 'verde'],
        icojanelaabrir: ['mais', null],
        iconaoselecionado: ['cancelar', 'vermelho'],
        icopessoaexcluir: ['usuarioX', 'vermelho'],
        icosrvfinalizado: ['engrenagem', 'verde'],
        icosrvparar: ['engrenagemParar', 'vermelho'],
        // NFe
        actionexecutar: ['enviar', 'verde', { titulo: 'Enviar NFe' }],
        icochange: ['trocar', 'laranja', { titulo: 'Solicitar Contingência' }],
        icoemailp: ['envelope', 'amarelo', { titulo: 'Reenviar E-mail' }],
        icoentregar: ['envelopeCheck', 'verde'],
        icoentregard: ['envelopeX', 'vermelho'],
        iconfeconsultar: ['busca', 'azul', { titulo: 'Consultar Status NFe' }],
        iconfeinutilizar: ['bloqueado', 'vermelho', { titulo: 'Cancelar / Inutilizar NFe' }],
        btntituloimprimir: ['imprimir', 'ciano', { titulo: 'Imprimir' }],
        btntituloimprimird: ['imprimir', 'ciano', { titulo: 'Imprimir' }],
        icoboleto: ['codigoBarras', 'azul', { titulo: 'Boleto' }],
        icoboletodisabled: ['codigoBarras', 'azul', { titulo: 'Boleto', desativado: true }],
        imgsinalverde: ['ponto', 'verde'],
        imgsinalamarelo: ['ponto', 'amarelo'],
        imgsinalvermelho: ['ponto', 'vermelho'],
        imgsinalcinza: ['ponto', null],
        tabgroupnext: ['proxima', null, { titulo: 'Próxima aba' }],
        tabgroupprevious: ['anterior', null, { titulo: 'Aba anterior' }],
    };
    // ícone e cor de um botão de texto que não está em BOTOES, pelo rótulo deduzido do nome do arquivo
    const ICONE_POR_TEXTO = [
        [/atualiz|recarreg/i, 'atualizar', 'azul'],
        [/consult|pesquis|busca|procur|localiz|analise|verific/i, 'busca', 'azul'],
        [/limpar/i, 'limparFiltro', 'verde'],
        [/filtr/i, 'filtro', 'amarelo'],
        [/fechar|sair|cancel|voltar/i, 'fechar', 'vermelho'],
        [/prospect|cliente|pessoa|usu/i, 'usuarioMais', 'verde'],
        [/novo|nova|inclu|inser|adicion/i, 'mais', 'verde'],
        [/salvar|gravar/i, 'salvar', 'verde'],
        [/confirm|ok\b|aplicar|selecion/i, 'check', 'verde'],
        [/exclu|apagar|elimin|remov/i, 'lixeira', 'vermelho'],
        [/desfazer|estorn/i, 'desfazer', 'vermelho'],
        [/edit|alter|modific/i, 'editar', 'laranja'],
        [/imprim|relat|comprovante/i, 'imprimir', 'ciano'],
        [/ficha|document|doc\b|declara/i, 'documento', 'ciano'],
        [/agend|calend|data/i, 'calendario', 'azul'],
        [/veic|carro|recall/i, 'carro', 'azul'],
        [/hist/i, 'relogio', 'azul'],
        [/foto|imagem|imagens/i, 'camera', 'ciano'],
        [/e-?mail/i, 'envelope', 'amarelo'],
        [/telefone|contato/i, 'telefone', 'azul'],
        [/financ|credito|pagamento|cobran/i, 'cifrao', 'verde'],
        [/segur|garantia|lgpd/i, 'escudo', 'verde'],
        [/info/i, 'info', 'azul'],
        [/servi/i, 'ferramentas', 'laranja'],
        [/integra/i, 'ligacao', 'verde'],
        [/envi[oa]/i, 'enviar', 'azul'],
        [/xml/i, 'documento', 'ciano'],
        [/inutiliz/i, 'bloqueado', 'vermelho'],
        [/print/i, 'imprimir', 'ciano'],
        [/compar/i, 'trocar', 'azul'],
        [/fatur/i, 'cifrao', 'verde'],
        [/gerar/i, 'engrenagem', 'azul'],
    ];
    const ACENTOS = { veiculo: 'veículo', veiculos: 'veículos', orcamento: 'orçamento', servico: 'serviço', servicos: 'serviços',
        usuario: 'usuário', relatorio: 'relatório', proximo: 'próximo', historico: 'histórico', codigo: 'código', numero: 'número',
        credito: 'crédito', debito: 'débito', titulo: 'título', titulos: 'títulos', pagina: 'página', analise: 'análise', tecnico: 'técnico',
        informacao: 'informação', ocorrencia: 'ocorrência', endereco: 'endereço', marcacao: 'marcação', realizacao: 'realização' };
    // "btnFiltroSelecao.png" -> "Filtro Seleção" (o "D" final dos botões desativados some)
    function rotuloDoArquivo(src) {
        const m = src.match(/\/btn([^\/.]+)\.[a-z]+(?:[?#].*)?$/i);
        if (!m) return '';
        return m[1].replace(/([a-z])D$/, '$1').replace(/_[A-Z]{1,3}$/, '').replace(/[_-]+/g, ' ')
            .replace(/([a-zà-ú])([A-Z])/g, '$1 $2').trim().split(/\s+/).map(p => {
                let w = p.toLowerCase();
                if (ACENTOS[w]) w = ACENTOS[w];
                else w = w.replace(/coes$/, 'ções').replace(/cao$/, 'ção').replace(/sao$/, 'são');
                return w;
            }).join(' ').replace(/^./, ch => ch.toUpperCase());
    }
    const cacheRegras = new Map();     // nome do arquivo -> regra (o mesmo objeto sempre: serve de identidade)
    function regraDe(src) {
        if (!src || /^data:/i.test(src)) return null;
        const nome = (src.split(/[?#]/)[0].split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
        if (cacheRegras.has(nome)) return cacheRegras.get(nome);
        let r = null, x;
        if (/logo/.test(nome) || /\/logo\//i.test(src)) r = { tipo: 'manter' };
        else if (/^(icomarcadod?|checkbox(des)?marcado)$/.test(nome)) r = { tipo: 'check' };
        else if (/legenda/.test(nome)) r = { tipo: 'amostra' };
        else if (nome === 'portuguese') r = { tipo: 'figura', classe: 'dt-bandeira-br', titulo: 'Português' };   // bandeira do Brasil desenhada
        else if (/^(icobranco|img_transparente|transparencia|hide)$/.test(nome)) r = { tipo: 'vazio' };   // espaços em branco de propósito
        else if (/^(barcode_scanner|multichannelmessage|semfoto|gp_normal_btn|icoradionbuttond?)$/.test(nome)) r = { tipo: 'manter' };   // ilustrações / widgets   // espaço em branco de propósito (ex. peça sem marca)
        else if (/^tab(begin|end)?(un)?selected(un)?(selected|end)?$|^tab(begin|end)(un)?selected$/.test(nome)) r = { tipo: 'vazio' };
        else if ((x = IMG_ICONES[nome])) r = Object.assign({ tipo: 'icone', icone: x[0], cor: x[1] }, x[2]);
        else if ((x = BOTOES[nome])) r = Object.assign({ tipo: 'texto', texto: x[0], icone: x[1], cor: x[2] }, x[3]);
        else if ((x = /^(.+?)(disabled|disable|d)$/.exec(nome)) && (IMG_ICONES[x[1]] || BOTOES[x[1]])) {
            r = Object.assign({}, regraDe(x[1] + '.png'), { desativado: true });   // variante desativada de um botão conhecido
        }
        else if (/^btn/.test(nome)) r = { tipo: 'texto', generico: true };
        if (r) r.arquivo = nome;
        cacheRegras.set(nome, r);
        return r;
    }

    // ------------------------------------------------------------------------------------------------
    // Motor por documento
    // ------------------------------------------------------------------------------------------------
    const doc = document;
    let trad = null;                  // tradutor do esquema ativo (null = tema desligado)
    const copias = new Map();          // nó <link>/<style> original -> <style> traduzido
    const inline = new WeakMap();      // elemento -> { prop: [original, traduzido, prioridade] }
    let observador = null;
    let processandoInline = false;
    let tempoLigar = 0;
    let trocarImagens = true;          // config "imagens": substituir imagens por HTML
    let depurar = false;               // config "debug": passar o mouse mostra a imagem original
    let mostrarOcultos = DEALER_TEMA_MOSTRAR_BOTOES_OCULTOS;   // config "ocultos": botões que o site esconde
    const proxyDe = new WeakMap();     // imagem original -> elemento HTML que a substitui
    const corAmostra = new Map();      // src -> [cor interna, cor da borda] | null (não é amostra)

    // ---- imagens -> HTML ----
    function lerAmostra(el) {
        const src = el.src;
        if (corAmostra.has(src)) return corAmostra.get(src);
        let r = null;
        try {
            const w = el.naturalWidth, h = el.naturalHeight;
            if (w && h && w <= 64 && h <= 48) {
                const cv = doc.createElement('canvas');
                cv.width = w; cv.height = h;
                const cx = cv.getContext('2d');
                cx.drawImage(el, 0, 0);
                const px = (x, y) => Array.from(cx.getImageData(x, y, 1, 1).data);
                const meio = px(w >> 1, h >> 1), borda = px(0, h >> 1);
                // só cor chapada: o interior inteiro igual ao centro
                const dados = cx.getImageData(2, 2, Math.max(1, w - 4), Math.max(1, h - 4)).data;
                let uniforme = meio[3] > 200;
                for (let i = 0; uniforme && i < dados.length; i += 4) {
                    if (Math.abs(dados[i] - meio[0]) + Math.abs(dados[i + 1] - meio[1]) + Math.abs(dados[i + 2] - meio[2]) > 24) uniforme = false;
                }
                if (uniforme) r = [[meio[0], meio[1], meio[2], 1], borda[3] > 200 ? [borda[0], borda[1], borda[2], 1] : null, w, h];
            }
        } catch (e) { r = null; }
        corAmostra.set(src, r);
        return r;
    }

    function criarProxy(el, regra) {
        const src = el.getAttribute('src') || '';
        const tipo = regra.tipo || 'icone';
        const clicavel = el.tagName === 'INPUT' || el.hasAttribute('onclick');
        let px;
        if (tipo === 'amostra') {
            if (el.tagName !== 'IMG') return null;
            if (!el.complete || !el.naturalWidth) { el.addEventListener('load', () => trocarImagem(el), { once: true }); return null; }
            const a = lerAmostra(el);
            if (!a) return null;
            px = doc.createElement('span');
            px.className = 'dt-img dt-amostra';
            px.style.width = (el.width || a[2]) + 'px';
            px.style.height = (el.height || a[3]) + 'px';
            px.style.backgroundColor = trad.traduzir(a[0], 'fundo');
            const difere = a[1] && (Math.abs(a[1][0] - a[0][0]) + Math.abs(a[1][1] - a[0][1]) + Math.abs(a[1][2] - a[0][2]) > 40);
            px.style.borderColor = difere ? trad.traduzir(a[1], 'texto') : corCss(trad.P.borda);
        } else {
            // tamanho original (antes de esconder); 0 quando a imagem está num trecho escondido
            // (guardado no elemento: depois de uma troca de tema ao vivo a medida pode voltar 0)
            const r0 = el.getBoundingClientRect();
            let w0 = Math.round(r0.width) || parseInt(el.getAttribute('width'), 10) || (el.tagName === 'IMG' ? el.naturalWidth : 0) || 0;
            let h0 = Math.round(r0.height) || parseInt(el.getAttribute('height'), 10) || (el.tagName === 'IMG' ? el.naturalHeight : 0) || 0;
            if (w0 > 1 && h0 > 1) el.__dtTam = [w0, h0];
            else if (el.__dtTam) [w0, h0] = el.__dtTam;
            if (tipo === 'figura') {                   // desenho fixo em CSS (ex. bandeira do idioma)
                px = doc.createElement('span');
                px.className = 'dt-img dt-figura ' + regra.classe;
                px.setAttribute('data-dealer-tema', '');
                px.__regra = regra;
                px.__orig = el;
                return px;
            }
            if (tipo === 'vazio') {                    // pedaço decorativo (ex. cantos das abas WWP): só o espaço
                px = doc.createElement('span');
                px.className = 'dt-img dt-vazio';
                px.setAttribute('data-dealer-tema', '');
                px.__regra = regra;
                px.__orig = el;
                return px;
            }
            if (tipo === 'texto' && regra.generico) {
                // "btn" desconhecido pequeno é ícone, não botão de texto: deixa como está
                if (w0 && w0 < 60) return null;
                if (!w0) {
                    if (regra.largura === undefined) {
                        regra.largura = null;
                        const im = new Image();
                        im.onload = () => {
                            regra.largura = im.naturalWidth;
                            if (im.naturalWidth < 60) doc.querySelectorAll('[data-dt-oculto]').forEach(o => { if (regraDe(o.getAttribute('src')) === regra) desfazerProxy(o); });
                        };
                        im.src = el.src;
                    } else if (regra.largura && regra.largura < 60) return null;
                }
            }
            const noLink = el.tagName === 'IMG' && !el.hasAttribute('onclick') && el.closest('a[href], a[onclick]');
            const botao = !noLink && (clicavel || regra.clique || tipo === 'texto' || regra.caixa);
            // <img> dentro de <a>: um <span> dentro do link, o clique sobe sozinho
            px = doc.createElement(botao ? 'button' : 'span');
            if (botao) px.type = 'button';
            px.className = 'dt-img dt-' + tipo + (regra.caixa ? ' dt-caixa' : '') + (regra.desativado ? ' dt-desativado' : '');
            if (tipo === 'texto') {
                const texto = regra.texto || rotuloDoArquivo(src) || el.title || el.alt || '';
                const dica = el.getAttribute('title') || el.getAttribute('alt') || '';
                let ic = regra.icone ? [null, regra.icone, regra.cor] : (ICONE_POR_TEXTO.find(x => x[0].test(texto)) || ICONE_POR_TEXTO.find(x => x[0].test(dica)));
                if (ic) { px.replaceChildren(svgIconeEl(doc, ic[1])); if (ic[2]) px.classList.add('dt-c-' + ic[2]); }
                const sp = doc.createElement('span');
                sp.textContent = texto;
                px.appendChild(sp);
                if (texto.length > 17 || texto.split(/\s+/).some(p => p.length >= 12)) px.classList.add('dt-longo');
                // largura do original; escondido na carga (sem medida) usa o padrão dos botões do GeneXus
                px.style.width = (w0 >= 60 ? w0 : 118) + 'px';
                // com fonte maior, rótulo de duas linhas não cabe na altura da imagem: o botão cresce
                if (escala > 1) { px.style.minHeight = (h0 >= 18 ? h0 : 26) + 'px'; px.style.height = 'auto'; }
                else px.style.height = (h0 >= 18 ? h0 : 26) + 'px';
            } else {
                if (regra.cor) px.classList.add('dt-c-' + regra.cor);
                px.replaceChildren(svgIconeEl(doc, tipo === 'check' ? 'check' : regra.icone));
                if (tipo === 'icone') {
                    if (regra.caixa) {
                        if (w0) { px.style.width = w0 + 'px'; px.style.height = h0 + 'px'; }
                    } else {
                        // o desenho ocupa a caixa inteira da imagem original (o traço já deixa uma margem de ~2px a
                        // cada 24): assim o ícone fica do tamanho visível da original, sem mudar o layout
                        const medir = (w, h) => {
                            const lado = Math.max(12, Math.min(regra.max || 64, Math.max(w, h)));
                            px.style.width = px.style.height = lado + 'px';
                            const sv = px.firstChild;
                            if (sv) {
                                sv.style.width = sv.style.height = lado + 'px';
                                const z = parseFloat(sv.getAttribute('data-dt-zoom')) || 1;
                                sv.setAttribute('stroke-width', String(Math.round((lado > 32 ? 1.6 : 2) / z * 100) / 100));
                            }
                        };
                        if (w0 && h0) medir(w0, h0);
                        // ícone grande (com `max`) trocado antes de a imagem carregar: a medida é a de "carregando"
                        // (0 ou a caixa vazia de 16px). Mede a imagem de verdade quando ela chegar.
                        if (regra.max && Math.max(w0, h0) < 24 && el.src && !el.getAttribute('width') && !(el.tagName === 'IMG' && el.complete && el.naturalWidth)) {
                            const im = new Image();
                            im.onload = () => { if (im.naturalWidth > Math.max(w0, h0)) { el.__dtTam = [im.naturalWidth, im.naturalHeight]; medir(im.naturalWidth, im.naturalHeight); } };
                            im.src = el.src;
                        }
                    }
                }
            }
            if (!noLink) {
                if (!botao) px.style.cursor = 'pointer';
                px.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();          // o clique "de verdade" é o da imagem, que sobe pelo DOM
                    if (el.disabled) return;
                    try { if (typeof el.onfocus === 'function') el.onfocus(); } catch (e) { /* gx */ }
                    el.click();
                });
                if (!botao && !clicavel) px.style.cursor = '';
            }
            const hs = parseInt(el.getAttribute('hspace'), 10), vs = parseInt(el.getAttribute('vspace'), 10);
            if (hs || vs) px.style.margin = `${vs || 0}px ${hs || 0}px`;
        }
        px.__orig = el;
        px.setAttribute('data-dealer-tema', '');
        px.__regra = regra;
        return px;
    }

    function sincronizarProxy(el, px) {
        // a original fica "escondida" sem display:none, então o estilo calculado ainda diz se o site a esconde
        // (com !important: o CSS dos botões novos usa display com !important e passaria por cima)
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        const escondido = cs.display === 'none' || cs.visibility === 'hidden';
        if (mostrarOcultos) {
            px.style.removeProperty('display'); px.style.removeProperty('visibility');
            px.classList.toggle('dt-oculto-site', escondido);
        } else {
            px.classList.remove('dt-oculto-site');
            if (cs.display === 'none') px.style.setProperty('display', 'none', 'important'); else px.style.removeProperty('display');
            if (cs.visibility === 'hidden') px.style.setProperty('visibility', 'hidden', 'important'); else px.style.removeProperty('visibility');
        }
        let t = el.getAttribute('title') || el.getAttribute('alt') || '';
        if (!t || /^GXM_/.test(t)) t = px.__regra.titulo || (t === 'GXM_display' ? 'Exibe' : t);
        if (px.title !== t) px.title = t;
        if (px.tagName === 'BUTTON') px.disabled = !!el.disabled;
        if (px.__regra.tipo === 'check') px.classList.toggle('dt-marcado', !/MarcadoD\.|desmarcado/i.test(el.getAttribute('src') || ''));
    }

    function desfazerProxy(el) {
        const px = proxyDe.get(el);
        if (px) px.remove();
        proxyDe.delete(el);
        el.removeAttribute('data-dt-oculto');
    }

    // Imagens sem regra (ou com rótulo deduzido) vistas ao navegar: ficam guardadas para o usuário
    // copiar a lista pelo menu Tema e mandar de uma vez.
    // Critério único (anotar e podar usam o mesmo): a imagem (src ou só o nome do arquivo) ainda fica na lista?
    // Sai o que a versão atual já resolve (regra própria) e o que nunca é anotado (logos, espaçadores, ExtJS...).
    function aindaSemIcone(src) {
        src = String(src || '');
        if (!src || /^data:/i.test(src) || /indicator\.gif|logo|\/ext\/|s\.gif$|ActionDisabled/i.test(src)) return false;
        const r = regraDe(src);
        return !r || !!r.generico;
    }
    // tira da lista guardada o que não está mais sem ícone; devolve a lista podada
    function podarSemIcone(lista) {
        let mudou = false;
        for (const k in lista) if (!Array.isArray(lista[k]) || !aindaSemIcone(lista[k][0])) { delete lista[k]; mudou = true; }
        return mudou;
    }
    let semIconeNovos = null, semIconeTimer = 0;
    function anotarSemIcone(el, regra) {
        const src = el.getAttribute('src') || '';
        if (!aindaSemIcone(src)) return;
        const clicavel = el.tagName === 'INPUT' || el.hasAttribute('onclick') || !!el.closest('a');
        const nome = (src.split(/[?#]/)[0].split('/').pop() || '');
        if (!regra && !clicavel && !/^(btn|ico)/i.test(nome)) return;
        if (!semIconeNovos) semIconeNovos = {};
        semIconeNovos[nome.toLowerCase()] = [nome, (el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 80), window.location.pathname.split('/').pop(), regra ? 'rótulo deduzido' : 'sem regra'];
        if (!semIconeTimer) semIconeTimer = window.setTimeout(() => {
            semIconeTimer = 0;
            let lista = {};
            try { lista = JSON.parse(localStorage.getItem(CHAVE_SEM_ICONE) || '{}') || {}; } catch (e) { lista = {}; }
            let mudou = podarSemIcone(lista);   // entradas velhas (ex. gravadas por uma cópia antiga em outra aba)
            for (const k in semIconeNovos) if (!lista[k]) { lista[k] = semIconeNovos[k]; mudou = true; }
            semIconeNovos = null;
            const ks = Object.keys(lista);
            if (ks.length > 500) ks.slice(0, ks.length - 500).forEach(k => delete lista[k]);
            if (mudou) try { localStorage.setItem(CHAVE_SEM_ICONE, JSON.stringify(lista)); } catch (e) { /* cheio */ }
        }, 1500);
    }

    function trocarImagem(el) {
        if (!trad || !trocarImagens || el.hasAttribute('data-dealer-tema')) return;
        if (el.tagName === 'INPUT' && el.type !== 'image') return;
        const regra = regraDe(el.getAttribute('src'));
        if (!regra || regra.generico) anotarSemIcone(el, regra);
        let px = proxyDe.get(el);
        if (px && (px.__regra !== regra || px.parentNode !== el.parentNode)) { desfazerProxy(el); px = null; }
        if (!regra || regra.tipo === 'manter') return;
        if (!px) {
            if (!el.parentNode) return;
            px = criarProxy(el, regra);
            if (!px) return;
            el.parentNode.insertBefore(px, el);
            el.setAttribute('data-dt-oculto', '');
            proxyDe.set(el, px);
        }
        sincronizarProxy(el, px);
    }

    function varrerImagens(raiz) {
        if (!trocarImagens || raiz.nodeType !== 1) return;
        if (raiz.tagName === 'IMG' || raiz.tagName === 'INPUT') { trocarImagem(raiz); if (raiz.classList.contains('BtnText')) marcarBotaoRedondo(raiz); return; }
        const lista = raiz.querySelectorAll('img[src], input[type="image" i]');
        for (let i = 0; i < lista.length; i++) trocarImagem(lista[i]);
        const rb = raiz.querySelectorAll('span.BaseRBtn input.BtnText');
        for (let i = 0; i < rb.length; i++) marcarBotaoRedondo(rb[i]);
        const dentro = raiz.closest(SEL_GRADES);
        if (dentro) agendarGrade(dentro);
        const gs = raiz.querySelectorAll(SEL_GRADES);
        for (let i = 0; i < gs.length; i++) agendarGrade(gs[i]);
    }
    // Colunas totalmente vazias nas grades do GeneXus (cabeçalho em branco e nada visível em nenhuma linha, ex. a
    // coluna do ícone de imprimir escondido em todas as linhas) viram uma faixa estreita com divisória no cartão:
    // somem (data-dt-vazia + CSS). Reavaliado quando a grade muda; se algo aparecer na coluna, ela volta.
    const SEL_GRADES = 'table.WorkWith, table.Grid';
    const gradesPendentes = new Set();
    let gradesTimer = 0;
    function agendarGrade(t) {
        gradesPendentes.add(t);
        if (!gradesTimer) gradesTimer = window.setTimeout(() => {
            gradesTimer = 0;
            const l = [...gradesPendentes]; gradesPendentes.clear();
            for (const g of l) if (g.isConnected) colunasVazias(g);
        }, 60);
    }
    const VISIVEL_NA_CELULA = 'input:not([type="hidden" i]),img,select,textarea,button,svg,a,.dt-img';
    function celulaVazia(td) {
        if (td.textContent.trim()) return false;
        const l = td.querySelectorAll(VISIVEL_NA_CELULA);
        for (let i = 0; i < l.length; i++) if (!l[i].hasAttribute('data-dt-oculto') && exibidoNaCelula(l[i], td)) return false;
        return true;
    }
    // pelo display do próprio elemento e dos pais até a célula (não pelo tamanho: com a coluna escondida tudo mede 0)
    function exibidoNaCelula(el, td) {
        for (let e = el; e && e !== td; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        }
        return true;
    }
    function colunasVazias(t) {
        const cab = t.tHead && t.tHead.rows[0];
        const corpo = t.tBodies[0];
        if (!cab || !corpo || !corpo.rows.length) return;
        for (let i = 0; i < cab.cells.length; i++) {
            const th = cab.cells[i];
            // escondida pelo próprio site: não mexe (nem conta)
            if (th.style.display === 'none' && !th.hasAttribute('data-dt-vazia')) continue;
            let vazia = !th.textContent.trim() && !th.querySelector(VISIVEL_NA_CELULA);
            const celulas = [];
            for (const tr of corpo.rows) {
                const td = tr.cells[i];
                if (!td) continue;
                celulas.push(td);
                if (vazia && !celulaVazia(td)) vazia = false;
            }
            if (!celulas.length) vazia = false;
            for (const c of [th, ...celulas]) {
                if (vazia) c.setAttribute('data-dt-vazia', ''); else c.removeAttribute('data-dt-vazia');
            }
        }
    }
    // Botões "redondos" do GeneXus (span.BaseRBtn > ... > span.BtnBackground > input.BtnText): só texto, com as
    // bordas em imagem. O CSS (cssAjustes) os desenha como os botões de texto; aqui ganham o ícone que o rótulo
    // sugere (mesma tabela ICONE_POR_TEXTO), pintado por máscara no ::before do span em volta do input.
    const urlsMascara = new Map();
    function marcarBotaoRedondo(inp) {
        const fundo = inp.parentNode;
        if (!fundo || fundo.nodeType !== 1 || !fundo.closest('span.BaseRBtn')) return;
        const t = inp.value || inp.title || '';
        const ic = ICONE_POR_TEXTO.find(x => x[0].test(t));
        if (!ic) { desmarcarBotaoRedondo(fundo); return; }
        let u = urlsMascara.get(ic[1]);
        if (!u) { u = mascaraUrl(ic[1]); urlsMascara.set(ic[1], u); }
        fundo.setAttribute('data-dt-rbtn', ic[2] || '');
        fundo.style.setProperty('--dt-ic', u);
    }
    function desmarcarBotaoRedondo(fundo) {
        fundo.removeAttribute('data-dt-rbtn');
        fundo.style.removeProperty('--dt-ic');
    }

    // ---- depuração: passar o mouse num elemento substituído mostra a imagem original ----
    let janelaDepuracao = null;
    function esconderOriginal() {
        if (janelaDepuracao) janelaDepuracao.style.display = 'none';
    }
    function mostrarOriginal(px) {
        const el = px.__orig;
        if (!el || !doc.body) return;
        if (!janelaDepuracao) {
            janelaDepuracao = doc.createElement('div');
            janelaDepuracao.id = PREFIXO + '-depuracao';
            janelaDepuracao.setAttribute('data-dealer-tema', '');
            janelaDepuracao.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#fff;color:#222;' +
                'border:1px solid #888;border-radius:4px;padding:6px;box-shadow:0 4px 14px rgba(0,0,0,.35);font:11px/1.35 monospace;max-width:360px';
            doc.body.appendChild(janelaDepuracao);
        } else if (janelaDepuracao.parentNode !== doc.body) doc.body.appendChild(janelaDepuracao);
        janelaDepuracao.textContent = '';
        const im = doc.createElement('img');
        im.setAttribute('data-dealer-tema', '');      // não é para trocar esta
        im.src = el.src;
        im.style.cssText = 'display:block;max-width:340px;max-height:120px;filter:none!important;margin-bottom:4px';
        const r0 = el.getAttribute('src') || '';
        const r = px.__regra || {};
        const linha = doc.createElement('div');
        linha.textContent = r0.split('/').pop() + (r.tipo === 'texto' ? ' → "' + (px.textContent || '').trim() + '"' : r.icone ? ' → ícone ' + r.icone : ' → ' + (r.tipo || ''))
            + (r.generico ? ' (rótulo deduzido do nome)' : '') + (el.id ? '  #' + el.id : '');
        janelaDepuracao.append(im, linha);
        janelaDepuracao.style.display = 'block';
        const b = px.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
        const jw = janelaDepuracao.offsetWidth, jh = janelaDepuracao.offsetHeight;
        let x = Math.min(Math.max(4, b.left), vw - jw - 4), y = b.bottom + 6;
        if (y + jh > vh - 4) y = Math.max(4, b.top - jh - 6);
        janelaDepuracao.style.left = x + 'px';
        janelaDepuracao.style.top = y + 'px';
    }
    doc.addEventListener('mouseover', ev => {
        if (!depurar) return;
        const px = ev.target && ev.target.closest && ev.target.closest('.dt-img');
        if (px && px.__orig) mostrarOriginal(px); else esconderOriginal();
    }, true);

    function removerProxies() {
        doc.querySelectorAll('[data-dt-oculto]').forEach(desfazerProxy);
        doc.querySelectorAll('.dt-img[data-dealer-tema]').forEach(n => n.remove());
        doc.querySelectorAll('[data-dt-rbtn]').forEach(desmarcarBotaoRedondo);
        doc.querySelectorAll('[data-dt-vazia]').forEach(n => n.removeAttribute('data-dt-vazia'));
    }

    function absolutizarUrls(css, base) {
        if (!base) return css;
        return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
            if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
            try { return `url("${new URL(u, base).href}")`; } catch (e) { return m; }
        });
    }

    // ---- degradês em imagem (tira de 1px repetida) -> linear-gradient com as cores do esquema ----
    const gradientes = new Map();      // "url|repeat" -> {dir, stops} | null | 'pendente'
    let reprocessar = 0;
    function amostrarGradiente(im, rep) {
        const w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) return null;
        let vertical;
        if (rep === 'repeat-x' || (w === 1 && h > 1)) vertical = true;
        else if (rep === 'repeat-y' || (h === 1 && w > 1)) vertical = false;
        else return null;
        const n = vertical ? h : w;
        if (n < 2 || n > 600) return null;
        const cv = doc.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.drawImage(im, 0, 0);
        const linha = vertical ? cx.getImageData(Math.floor(w / 2), 0, 1, h).data : cx.getImageData(0, Math.floor(h / 2), w, 1).data;
        const cor = i => [linha[i * 4], linha[i * 4 + 1], linha[i * 4 + 2], linha[i * 4 + 3] / 255];
        const m = Math.min(n, 8), stops = [];
        for (let k = 0; k < m; k++) { const i = Math.round(k * (n - 1) / (m - 1)); stops.push([cor(i), i]); }
        return { vertical, n, stops };
    }
    function agendarReprocesso() {
        if (reprocessar) return;
        reprocessar = window.setTimeout(() => {
            reprocessar = 0;
            if (!motorAtivo()) return;
            processandoInline = true;
            try {
                processarTodasFolhas();
                doc.querySelectorAll('[style*="url(" i]').forEach(processarInline);
            } finally { processandoInline = false; }
        }, 60);
    }
    // url(...) de uma textura -> linear-gradient traduzido, ou null (some: fica a cor de fundo)
    function gradienteDe(valor, rep, pos, base) {
        const m = valor.match(/^\s*url\(\s*(['"]?)([^'")]+)\1\s*\)\s*$/i);
        if (!m) return null;
        let url;
        try { url = new URL(m[2], base || doc.baseURI).href; } catch (e) { return null; }
        const chave = url + '|' + (rep || '');
        let g = gradientes.get(chave);
        if (g === undefined) {
            gradientes.set(chave, 'pendente');
            const im = new Image();
            im.onload = () => {
                let r = null;
                try { r = amostrarGradiente(im, rep); } catch (e) { r = null; }
                gradientes.set(chave, r);
                if (r) agendarReprocesso();
            };
            im.onerror = () => gradientes.set(chave, null);
            im.src = url;
            return null;
        }
        if (!g || g === 'pendente') return null;
        // a tira começa no início ou no fim do elemento; outra posição = sprite, não dá para replicar
        const ts = (pos || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        let tx = ts[0], ty = ts[1];
        if (ts.length === 1 && /^(top|bottom)$/.test(tx)) { ty = tx; tx = undefined; }
        const tok = g.vertical ? ty : tx;
        const ancora = !tok || /^(0(px|%)?|left|top)$/.test(tok) ? 'ini' : /^(100%|right|bottom)$/.test(tok) ? 'fim' : null;
        if (!ancora) return null;
        const fim = ancora === 'fim';
        const dir = g.vertical ? (fim ? 'to top' : 'to bottom') : (fim ? 'to left' : 'to right');
        const stops = fim ? g.stops.slice().reverse().map(([c, i]) => [c, g.n - 1 - i]) : g.stops;
        return `linear-gradient(${dir}, ${stops.map(([c, i]) => (c[3] < 0.05 ? 'transparent' : trad.traduzir(c, 'fundo')) + ' ' + i + 'px').join(', ')})`;
    }
    // imagens de fundo trocadas por CSS desenhado com as cores do esquema
    function fundoEspecial(valor) {
        if (/RequiredTriangle\./i.test(valor)) return `linear-gradient(135deg, ${corCss(trad.P.vermelho)} 0 5px, transparent 5px)`;
        return null;
    }
    function traduzirFundo(valor, rep, pos, base) {
        if (!/url\(/i.test(valor)) return /gradient\(/i.test(valor) ? trad.traduzirValor(valor, 'fundo') : null;
        const esp = fundoEspecial(valor);
        if (esp) return esp;
        if (RE_TEXTURA.test(valor) || /^repeat-[xy]$/.test(rep)) {
            // ExtJS: sprites e bordas em pedaços, melhor cor chapada (os ajustes cuidam do resto)
            if (/\/ext\/|resources\/images\//i.test(valor) || /\/ext\//i.test(base || '')) return 'none';
            return gradienteDe(valor, rep, pos, base) || 'none';
        }
        return null;
    }

    // Véu/sombra: fundo escuro e translúcido (pela cor ou pela opacidade do elemento). Fica como está:
    // traduzido, o preto viraria a cor do texto e o véu ficaria claro nos temas escuros.
    function ehVeu(valor, opacidade) {
        const c = lerCor(valor.trim());
        if (!c || c.some(v => isNaN(v))) return false;
        const translucido = c[3] < 0.8 || (opacidade !== '' && parseFloat(opacidade) < 0.95);
        if (!translucido) return false;
        const { L, C } = oklab(c);
        return L < 0.4 && C < 0.05;
    }

    function traduzirRegras(regras, base, saida) {
        for (const regra of regras) {
            if (regra.type === 1) {                               // CSSStyleRule
                const st = regra.style;
                let decl = '';
                for (let i = 0; i < st.length; i++) {
                    const prop = st[i];
                    const papel = papelDe(prop);
                    if (!papel) continue;
                    if (papel === 'fonte' ? escala === 1 || SEM_ESCALA.test(regra.selectorText) : !trad) continue;
                    const valor = st.getPropertyValue(prop);
                    if (!valor) continue;
                    const prio = st.getPropertyPriority(prop) ? ' !important' : '';
                    let novo;
                    if (papel === 'fonte') novo = escalarTamanho(valor, prop === 'font-size');
                    else if (prop === 'background-image') {
                        // textura: nome conhecido, ou imagem repetida só na horizontal/vertical (degradê de 1px)
                        const rep = st.getPropertyValue('background-repeat');
                        const pos = st.getPropertyValue('background-position');
                        novo = traduzirFundo(valor, rep, pos, base);
                        if (novo === null) continue;
                    } else if (prop === 'background-color' && ehVeu(valor, st.getPropertyValue('opacity'))) continue;
                    else novo = trad.traduzirValor(valor, papel);
                    if (novo !== valor) decl += `${prop}:${absolutizarUrls(novo, base)}${prio};`;
                }
                // borda "afundada" do Windows 98 (campos do GeneXus: .Attribute e companhia) vira borda lisa.
                // Só onde o site pôs inset. Os outros border-style também vão para a cópia, sem mudar, para manter
                // a ordem do site: ex. .ReadonlyAttribute{border-style:none} vem depois do grupo inset e tem de ganhar.
                if (trad) for (const lado of ['top', 'right', 'bottom', 'left']) {
                    const p = `border-${lado}-style`, v = st.getPropertyValue(p);
                    if (v) decl += `${p}:${v === 'inset' ? 'solid' : v}${st.getPropertyPriority(p) ? ' !important' : ''};`;
                }
                if (decl) saida.push(`${regra.selectorText}{${decl}}`);
            } else if (regra.type === 4 || regra.type === 12) {   // @media / @supports
                const dentro = [];
                traduzirRegras(regra.cssRules, base, dentro);
                if (dentro.length) saida.push(`${regra.type === 4 ? '@media ' + (regra.conditionText || regra.media.mediaText) : '@supports ' + regra.conditionText}{${dentro.join('')}}`);
            } else if (regra.type === 3 && regra.styleSheet) {    // @import
                let sub;
                try { sub = regra.styleSheet.cssRules; } catch (e) { continue; }
                traduzirRegras(sub, regra.styleSheet.href || base, saida);
            }
        }
    }

    function processarFolha(no) {
        if (!motorAtivo() || !no.sheet || no.id && no.id.startsWith(PREFIXO)) return;
        if (no.tagName === 'LINK' && !/stylesheet/i.test(no.rel)) return;
        let regras;
        try { regras = no.sheet.cssRules; } catch (e) { return; }  // outra origem
        if (!regras) return;
        const saida = [];
        traduzirRegras(regras, no.sheet.href || doc.baseURI, saida);
        let copia = copias.get(no);
        if (!copia) {
            copia = doc.createElement('style');
            copia.id = PREFIXO + '-copia';
            copia.setAttribute('data-dealer-tema', '');
            copias.set(no, copia);
        }
        copia.textContent = saida.join('\n');
        if (no.nextSibling !== copia) no.parentNode && no.parentNode.insertBefore(copia, no.nextSibling);
    }

    function processarTodasFolhas() {
        doc.querySelectorAll('link[rel~="stylesheet" i], style').forEach(no => {
            if (no.hasAttribute('data-dealer-tema')) return;
            if (no.tagName === 'LINK' && !no.sheet) return;     // ainda carregando: o evento load chama de novo
            processarFolha(no);
        });
    }

    // ---- cores em style="" e atributos bgcolor/color ----
    function processarInline(el) {
        if (!el.style || el.hasAttribute && el.hasAttribute('data-dealer-tema')) return;
        let reg = inline.get(el);
        const st = el.style;
        // atributos antigos de HTML
        const attrFundo = el.getAttribute && el.getAttribute('bgcolor');
        const attrCor = el.tagName === 'FONT' ? el.getAttribute('color') : null;
        const attrTam = el.tagName === 'FONT' ? el.getAttribute('size') : null;
        if (!st.length && !attrFundo && !attrCor && !attrTam && !reg) return;
        if (!reg) { reg = {}; inline.set(el, reg); }
        const vistos = new Set();
        for (let i = 0; i < st.length; i++) {
            const prop = st[i];
            const papel = papelDe(prop);
            if (!papel) continue;
            if (papel === 'fonte' ? escala === 1 : !trad) continue;
            vistos.add(prop);
            const atual = st.getPropertyValue(prop);
            const r = reg[prop];
            if (r && r[1] === atual) continue;                 // já é o valor traduzido
            reg[prop] = [atual, null, st.getPropertyPriority(prop)];
        }
        for (const prop of Object.keys(reg)) {
            if (prop.startsWith('@')) continue;
            if (!vistos.has(prop)) { delete reg[prop]; continue; }
            const r = reg[prop];
            if (r[0] === '' && r[3]) continue;                     // valor posto pelo próprio tema (contraste, <font size>)
            let novo;
            if (papelDe(prop) === 'fonte') novo = escalarTamanho(r[0], prop === 'font-size');
            else if (prop === 'background-image') {
                novo = traduzirFundo(r[0], st.getPropertyValue('background-repeat'), st.getPropertyValue('background-position'), doc.baseURI);
                if (novo === null) novo = r[0];
            } else if (prop === 'background-color' && ehVeu(r[0], st.getPropertyValue('opacity'))) novo = r[0];
            else novo = trad.traduzirValor(r[0], papelDe(prop));
            if (novo !== st.getPropertyValue(prop)) st.setProperty(prop, novo, r[2]);
            r[1] = st.getPropertyValue(prop);
        }
        if (attrTam && escala !== 1 && !vistos.has('font-size')) {      // <font size="2">: vira px já escalado
            const m = /^([+-]?)(\d)$/.exec(attrTam.trim());
            if (m) {
                let n = +m[2]; if (m[1] === '+') n = 3 + n; else if (m[1] === '-') n = 3 - n;
                st.setProperty('font-size', arred(TAMANHO_FONT_ATTR[Math.min(7, Math.max(1, n))] * escala) + 'px');
                reg['font-size'] = ['', st.getPropertyValue('font-size'), '', true];
            }
        }
        if (!trad) return;
        if (attrFundo && !vistos.has('background-color')) {
            const c = lerCor(attrFundo);
            if (c) { st.setProperty('background-color', trad.traduzir(c, 'fundo')); reg['@bgcolor'] = true; reg['background-color'] = [attrFundo, st.getPropertyValue('background-color'), '', true]; }
        }
        garantirContraste(el, reg, vistos);
        corDeCategoria(el, reg);
        if (attrCor && !vistos.has('color')) {
            const c = lerCor(attrCor);
            if (c) { st.setProperty('color', trad.traduzir(c, 'texto')); reg['color'] = [attrCor, st.getPropertyValue('color'), '', true]; }
        }
    }

    // Fundo vindo do próprio elemento (style/bgcolor) + texto herdado ou de classe: a tradução de cada um é
    // feita sem saber do outro (ex. agenda: fundo "Orange" vira um tom escuro, mas o texto branco vira o
    // escuro "sobre destaque"). Se o texto resultante não dá para ler, troca pela cor de texto do esquema
    // que tiver mais contraste com o fundo novo. Separadores e ícones dentro herdam a correção.
    function luminancia(c) {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    function contraste(a, b) { const x = luminancia(a), y = luminancia(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    function garantirContraste(el, reg, vistos) {
        if (vistos.has('color') || reg.color) return;        // o site definiu a cor do texto ali mesmo, ou já corrigido
        if (!reg['background-color']) return;
        const fundo = lerCor(el.style.getPropertyValue('background-color'));
        if (!fundo || fundo[3] < 0.6 || !el.isConnected) return;
        const texto = lerCor(getComputedStyle(el).color);
        if (!texto || contraste(fundo, texto) >= 3) return;
        const opcoes = [trad.P.texto, trad.P.sobreDestaque, trad.P.fundo];
        let melhor = opcoes[0], cm = 0;
        for (const o of opcoes) { const k = contraste(fundo, o); if (k > cm) { cm = k; melhor = o; } }
        el.style.setProperty('color', corCss([melhor[0], melhor[1], melhor[2], 1]));
        reg.color = ['', el.style.getPropertyValue('color'), '', true];
        el.setAttribute('data-dt-contraste', '');           // ícones sem cor própria lá dentro seguem o texto corrigido
        el.style.setProperty('--dt-contraste', reg.color[1]);
    }

    // Quadro de agendamento (dhtmlxScheduler em QuadroAgendamento.shtml) e a legenda dele na tela que o contém:
    // as cores são categorias (tipo de serviço, situação). A tradução genérica inverte a luminosidade (amarelo
    // vira escuro, preto vira claro) e a legenda deixa de bater com os cartões. Aqui cada cor original vira a cor
    // de destaque equivalente do esquema, igual nos cartões, na faixa de situação e na legenda.
    const QUADRO_CATEGORIAS = {
        ffff00: 'amarelo',                    // Acessórios / cliente aguardando
        ff0000: 'vermelho', ee0000: 'vermelho', // Diagnóstico / confirmado
        '808080': 'apagado',                  // Revisão
        '008000': 'verde',                    // Rep. Geral
        ffa500: 'laranja', ff8000: 'laranja', // Alin/Balanc
        '000000': 'texto',                    // Retorno
        a52a2a: 'magenta', '800080': 'magenta', // Teste
        '0000ff': 'azul',                     // Quick Srv.
        add8e6: 'ciano',                      // Tempo Ad.
        d3d3d3: ['apagado', 'fundo', .4],     // Almoço
        c0c0ff: ['azul', 'apagado', .55],     // Ausência
    };
    const SEL_CATEGORIA = '.dhx_cal_event_line, .dhx_cal_event_line > .status, fieldset[id^="GROUPLEGENDA" i] td[bgcolor]';
    function corDeCategoria(el, reg) {
        const r = reg['background-color'];
        if (!r || !el.matches || !el.matches(SEL_CATEGORIA)) return;
        const o = lerCor(r[0]);
        const k = o && o[3] > 0 && QUADRO_CATEGORIAS[corCss([o[0], o[1], o[2], 1]).slice(1)];
        if (!k) { if (el.hasAttribute('data-dt-cat')) limparCategoria(el); return; }
        const P = trad.P, escuro = trad.esquema.escuro;
        const cor = Array.isArray(k) ? misturar(P[k[0]], P[k[1]], k[2]) : P[k];
        el.style.setProperty('--dt-cat', corCss(cor));
        el.style.setProperty('--dt-cat-fundo', corCss(misturar(P.fundo, cor, escuro ? .26 : .2)));
        el.style.setProperty('--dt-cat-sobre', corCss(misturar(P.fundo, cor, escuro ? .4 : .32)));
        el.style.setProperty('--dt-cat-borda', corCss(misturar(P.fundo, cor, escuro ? .55 : .5)));
        el.setAttribute('data-dt-cat', '');
    }
    function limparCategoria(el) {
        el.removeAttribute('data-dt-cat');
        for (const v of ['--dt-cat', '--dt-cat-fundo', '--dt-cat-sobre', '--dt-cat-borda']) el.style.removeProperty(v);
    }

    function restaurarInline(el) {
        const reg = inline.get(el);
        if (!reg) return;
        for (const prop of Object.keys(reg)) {
            if (prop.startsWith('@')) continue;
            const r = reg[prop];
            if (el.style.getPropertyValue(prop) !== r[1]) continue;   // o site mudou depois: deixa
            if (r[3]) el.style.removeProperty(prop);                  // veio de atributo bgcolor/color
            else el.style.setProperty(prop, r[0], r[2]);
        }
        if (el.hasAttribute('data-dt-contraste')) { el.removeAttribute('data-dt-contraste'); el.style.removeProperty('--dt-contraste'); }
        if (el.hasAttribute('data-dt-cat')) limparCategoria(el);
        inline.delete(el);
    }

    function varrerInline(raiz) {
        if (raiz.nodeType !== 1) return;
        processarInline(raiz);
        const lista = raiz.querySelectorAll('[style],[bgcolor],font[color],font[size]');
        for (let i = 0; i < lista.length; i++) processarInline(lista[i]);
    }

    function aoMudarDom(registros) {
        if (processandoInline || !motorAtivo()) return;
        processandoInline = true;
        try {
            for (const r of registros) {
                if (r.type === 'attributes') {
                    const t = r.target;
                    if (t.nodeType !== 1) continue;
                    const at = r.attributeName;
                    if (at === 'style' || at === 'bgcolor' || at === 'color') processarInline(t);
                    if ((at === 'style' || at === 'class' || at === 'hidden') && t.closest) { const g = t.closest(SEL_GRADES); if (g) agendarGrade(g); }
                    if (at === 'class' || at === 'hidden') { if (t.tagName === 'IMG' || t.tagName === 'INPUT') trocarImagem(t); continue; }
                    if ((t.tagName === 'IMG' || t.tagName === 'INPUT') && r.attributeName !== 'bgcolor' && r.attributeName !== 'color') trocarImagem(t);
                } else if (r.type === 'childList') {
                    // qualquer troca de conteúdo dentro de uma grade (inclusive só texto) reavalia as colunas vazias
                    if (r.target.nodeType === 1 && r.target.closest) { const g = r.target.closest(SEL_GRADES); if (g) agendarGrade(g); }
                    for (const n of r.addedNodes) {
                        if (n.nodeType !== 1) {
                            if (n.nodeType === 3 && n.parentNode && n.parentNode.tagName === 'STYLE') processarFolha(n.parentNode);
                            continue;
                        }
                        if (n.tagName === 'STYLE' && !n.hasAttribute('data-dealer-tema')) processarFolha(n);
                        else if (n.tagName === 'LINK') { if (n.sheet) processarFolha(n); }
                        else { varrerInline(n); varrerImagens(n); }
                    }
                    if (r.target.tagName === 'STYLE' && !r.target.hasAttribute('data-dealer-tema')) processarFolha(r.target);
                    for (const n of r.removedNodes) {
                        const c = copias.get(n);
                        if (c) { c.remove(); copias.delete(n); }
                        const px = n.nodeType === 1 && proxyDe.get(n);
                        if (px && !n.isConnected) { px.remove(); proxyDe.delete(n); }
                    }
                }
            }
        } finally {
            processandoInline = false;
        }
    }

    // ---- CSS base do esquema (vai antes das folhas do site: só preenche o que o site não define) ----
    function cssBase(e, P) {
        const c = corCss;
        const destaque = c(P.azul);
        return `
:root{color-scheme:${e.escuro ? 'dark' : 'light'};scrollbar-color:${c(P.borda)} ${c(P.fundo)}}
html{background-color:${c(P.fundo)};color:${c(P.texto)}}
:where(input:not([type="image" i]),textarea,select,button){background-color:${c(P.superficie)};color:${c(P.texto)};border-color:${c(P.borda)}}
::selection{background:${destaque};color:${c(P.sobreDestaque)}}
`;
    }
    // ---- ajustes finos (vão depois de tudo) ----
    function cssAjustes(e, P) {
        const c = corCss;
        const x = (a, b, t) => c(misturar(P[a], P[b], t));
        const ext = !!doc.querySelector('script[src*="W5Portal"], link[href*="ext-all"]');
        let s = `
input:focus,textarea:focus,select:focus{outline-color:${c(P.azul)}}
::-webkit-scrollbar{background-color:${c(P.fundo)}}
::-webkit-scrollbar-thumb{background-color:${c(P.borda)};border:2px solid ${c(P.fundo)};border-radius:6px}
::-webkit-scrollbar-corner{background-color:${c(P.fundo)}}
`;
        if (e.escuro) s += `
img{filter:brightness(.92)}
img[src$="logo.png" i],img[src*="logo_dealer" i]{filter:invert(.8) hue-rotate(180deg) brightness(1.1)}
/* botões do GeneXus são imagens com o texto desenhado (fundo branco): inverte mantendo o matiz */
input[type="image"][src*="/btn" i],img[src*="/btn" i],input[type="image"][src*="Resources/Portuguese/" i],img[src*="Resources/Portuguese/" i]{filter:invert(.88) hue-rotate(180deg) saturate(1.3)}
`;
        if (ext) s += `
.x-window-tl,.x-window-tr,.x-window-tc,.x-window-ml,.x-window-mr,.x-window-mc,.x-window-bl,.x-window-br,.x-window-bc{background-color:${c(P.elevado)}}
.x-window-mc{border-color:${c(P.borda)}}
.x-panel-tl,.x-panel-tr,.x-panel-tc,.x-panel-bl,.x-panel-br,.x-panel-bc,.x-panel-ml,.x-panel-mr{background-color:${c(P.elevado)}}
.x-panel-header,.x-panel-tc .x-panel-header{color:${c(P.texto)}}
.x-panel-header,.x-window-header{background-color:${c(P.elevado)}}
/* títulos das janelas */
.x-window-tl .x-window-header{color:${c(P.texto)}!important;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;font-size:12.5px!important;font-weight:600!important;line-height:14px}
.x-window-header-text{display:inline-flex;align-items:center;letter-spacing:.2px;padding-left:6px}
.x-window{border-radius:7px 7px 0 0;box-shadow:0 0 0 1px ${c(P.borda)}}
.x-window-tl{border-radius:7px 7px 0 0;border-bottom:1px solid ${c(P.borda)};background-color:${c(P.elevado)}!important;
  background-image:linear-gradient(to bottom,${e.escuro ? x('elevado', 'texto', .07) : c(P.fundo)},${c(P.elevado)})!important;box-shadow:inset 0 1px 0 ${e.escuro ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.7)'}}
.x-window-tr,.x-window-tc,.x-window-maximized .x-window-tc,.x-window-tl .x-window-header{background:transparent!important}
/* maximizada ocupa a área toda: cantos retos */
.x-window-maximized,.x-window-maximized .x-window-tl{border-radius:0!important}
.x-toolbar{background-color:${c(P.superficie)};border-color:${c(P.borda)}}
.x-menu{background-color:${c(P.superficie)};border-color:${c(P.borda)}}
/* item de menu em foco: o ExtJS pinta o <li> (quadrado, com borda); o realce fica só no <a> arredondado */
.x-menu-list-item.x-menu-item-active{background:transparent!important;background-image:none!important;border-color:transparent!important}
.x-menu-item-active a.x-menu-item{background-color:${x('fundo', 'azul', .25)}!important;background-image:none!important;border-color:transparent!important;
  box-shadow:inset 0 0 0 1px ${x('fundo', 'azul', .5)}}
.x-menu-sep{background-color:${c(P.borda)};border-color:${c(P.borda)}}
.x-btn-over .x-btn-mc,.x-btn-over .x-btn-tl,.x-btn-over .x-btn-tr,.x-btn-over .x-btn-tc,.x-btn-over .x-btn-ml,.x-btn-over .x-btn-mr,.x-btn-over .x-btn-bl,.x-btn-over .x-btn-br,.x-btn-over .x-btn-bc,
.x-btn-menu-active .x-btn-mc,.x-btn-menu-active .x-btn-tl,.x-btn-menu-active .x-btn-tr,.x-btn-menu-active .x-btn-tc,.x-btn-menu-active .x-btn-ml,.x-btn-menu-active .x-btn-mr,.x-btn-menu-active .x-btn-bl,.x-btn-menu-active .x-btn-br,.x-btn-menu-active .x-btn-bc{background-color:${x('fundo', 'azul', .25)}}
.x-tab-strip-top,.x-tab-panel-header{background-color:${c(P.superficie)}}
.x-tab-strip li.x-tab-strip-active .x-tab-right,.x-tab-strip-active .x-tab-strip-inner{background-color:${c(P.elevado)}}
.x-grid3-header,.x-grid3-hd-row td{background-color:${c(P.superficie)}}
.x-grid3-row-over{background-color:${x('fundo', 'azul', .15)}}
.x-tip,.x-tip .x-tip-body{background-color:${c(P.elevado)};color:${c(P.texto)}}
.x-shadow *{opacity:.5}
/* caixas de mensagem do ExtJS (Ext.Msg: aviso de fim de sessão, confirmações): cartão inteiro arredondado, corpo sem
   faixa própria e botões do rodapé com cara de botão (no tema eles viravam só texto) */
.x-window-dlg{border-radius:8px;box-shadow:0 0 0 1px ${c(P.borda)},0 12px 32px rgba(0,0,0,${e.escuro ? .45 : .18})}
.x-window-dlg .x-window-bl{border-radius:0 0 8px 8px}
.x-window-dlg .x-window-mc{border:0!important;background:${c(P.elevado)}!important}
.x-window-dlg .x-window-body{background:transparent!important;padding:14px 16px 8px!important;box-sizing:border-box}
.x-window-dlg .ext-mb-text{color:${c(P.texto)}!important;font-size:13px;line-height:1.45}
.x-window-dlg .x-window-footer{padding:6px 0 10px}
.x-window-dlg~.x-shadow,.x-window-dlg+.x-shadow{display:none!important}
.x-panel-btns table.x-btn{border-collapse:separate;border-radius:5px;background-color:${c(P.superficie)};box-shadow:inset 0 0 0 1px ${c(P.borda)};transition:background-color .15s,box-shadow .15s}
.x-panel-btns table.x-btn td{background:transparent!important;background-image:none!important}
.x-panel-btns table.x-btn button.x-btn-text{color:${c(P.texto)}!important;font-weight:600;height:24px}
.x-panel-btns table.x-btn-over{background-color:${x('superficie', 'azul', e.escuro ? .18 : .1)};box-shadow:inset 0 0 0 1px ${x('borda', 'azul', .55)}}
.x-panel-btns table.x-btn-focus{box-shadow:inset 0 0 0 1px ${c(P.azul)},0 0 0 2px ${x('fundo', 'azul', .35)}}
.x-panel-btns table.x-btn-click{background-color:${x('superficie', 'azul', .3)}}
${e.escuro && !trocarImagens ? '.x-menu-item-checked .x-menu-item-icon,.x-menu-group-item .x-menu-item-icon,.x-tool,.x-tbar-loading,.x-tbar-page-first,.x-tbar-page-prev,.x-tbar-page-next,.x-tbar-page-last{filter:invert(.85) hue-rotate(180deg)}' : ''}
`;
        s += cssComponentes(e, P);
        if (trocarImagens) s += cssImagens(e, P, ext);
        if (typeof e.extra === 'function') s += e.extra(P, c, x);   // CSS próprio de um esquema (ex. 'vice')
        return s;
    }

    // ---- abas (GXUI/ExtJS e WorkWithPlus) e calendário ----
    function cssComponentes(e, P) {
        const c = corCss;
        const x = (a, b, t) => c(misturar(P[a], P[b], t));
        const linhaArv = x('borda', 'texto', .25);
        const suave = c(misturar(P.apagado, P.texto, e.escuro ? 0.45 : 0.55));
        const sombra = e.escuro ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.18)';
        return `
/* abas GXUI / ExtJS: o sprite some, cada aba vira uma caixa com cantos arredondados */
ul.x-tab-strip,.x-tab-panel-header,.x-tab-strip-spacer{background-image:none!important}
ul.x-tab-strip{background-color:transparent!important}
ul.x-tab-strip-top{border-bottom:1px solid ${c(P.borda)}!important}
.x-tab-strip-top em.x-tab-left,.x-tab-strip-top span.x-tab-strip-inner{background-image:none!important;background-color:transparent!important}
.x-tab-strip-top a.x-tab-right{background-image:none!important;background-color:${c(P.superficie)}!important;border:1px solid ${c(P.borda)};border-bottom:0;border-radius:6px 6px 0 0}
.x-tab-strip-top li{margin-right:2px!important}
.x-tab-strip-top .x-tab-strip-text{color:${suave}!important}
.x-tab-strip-top li.x-tab-strip-over a.x-tab-right,.x-tab-strip-top li:hover a.x-tab-right{background-color:${c(P.elevado)}!important}
.x-tab-strip-top li.x-tab-strip-over .x-tab-strip-text{color:${c(P.texto)}!important}
.x-tab-strip-top li.x-tab-strip-active a.x-tab-right{background-color:${c(P.fundo)}!important;box-shadow:inset 0 2px 0 ${c(P.azul)}}
.x-tab-strip-top li.x-tab-strip-active .x-tab-strip-text{color:${c(P.texto)}!important;font-weight:bold}
/* painel recolhível do GXUI (ex. "Filtro do Atendimento"): cartão com cabeçalho limpo */
div.GXUI-DVelop-Panel{border:1px solid ${c(P.borda)}!important;border-radius:8px;overflow:hidden;background:${c(P.superficie)}!important;margin:2px 0 6px}
div.GXUI-DVelop-Panel>.x-panel-header{background:${c(P.superficie)}!important;background-image:none!important;border:0!important;
  padding:8px 12px!important;cursor:pointer;color:${c(P.texto)}!important;transition:background-color .15s}
div.GXUI-DVelop-Panel>.x-panel-header:hover{background:${x('superficie', 'azul', .12)}!important}
div.GXUI-DVelop-Panel:not(.x-panel-collapsed)>.x-panel-header{border-bottom:1px solid ${c(P.borda)}!important}
div.GXUI-DVelop-Panel>.x-panel-header .x-panel-header-text{font:600 12.5px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;letter-spacing:.2px;color:${c(P.texto)}!important}
div.GXUI-DVelop-Panel>.x-panel-header img.x-panel-inline-icon{display:none}
div.GXUI-DVelop-Panel>.x-panel-header .x-tool{margin-top:0;color:${suave}}
div.GXUI-DVelop-Panel>.x-panel-header .x-tool::before{transition:transform .15s}
div.GXUI-DVelop-Panel.x-panel-collapsed>.x-panel-header .x-tool-toggle::before{transform:rotate(-90deg)}
div.GXUI-DVelop-Panel .x-panel-bwrap,div.GXUI-DVelop-Panel .x-panel-body{background:${c(P.fundo)}!important;border:0!important}
div.GXUI-DVelop-Panel .x-panel-body{padding:6px 8px}
/* abas WorkWithPlus (spans SelectedTab/UnSelectedTab entre imagens de canto) */
span.SelectedTab,span.UnSelectedTab{background-image:none!important;display:inline-block;box-sizing:border-box;min-height:21px;padding:3px 14px;
  border:1px solid ${c(P.borda)};border-bottom:0;border-radius:6px 6px 0 0;vertical-align:bottom;cursor:pointer;white-space:nowrap}
span.UnSelectedTab{background-color:${c(P.superficie)}!important;color:${suave}!important}
span.UnSelectedTab:hover{background-color:${c(P.elevado)}!important;color:${c(P.texto)}!important}
span.SelectedTab{background-color:${c(P.fundo)}!important;color:${c(P.texto)}!important;font-weight:bold;box-shadow:inset 0 2px 0 ${c(P.azul)}}
span.SelectedTab a,span.UnSelectedTab a{color:inherit!important;text-decoration:none!important}
.dt-vazio{display:inline-block;width:3px;height:1px}
/* bandeira do Brasil (idioma): desenho fixo, nas cores da bandeira em qualquer tema */
.dt-bandeira-br,button.x-btn-text[style*="Portuguese.gif"]::before{background:url("${BANDEIRA_BR}") center/contain no-repeat}
.dt-bandeira-br{display:inline-block;width:20px;height:14px;vertical-align:middle}
.x-menu-item .dt-bandeira-br{margin-right:5px}
button.x-btn-text[style*="Portuguese.gif"]{background-image:none!important;position:relative}
button.x-btn-text[style*="Portuguese.gif"]::before{content:'';position:absolute;left:50%;top:50%;width:18px;height:13px;margin:-6.5px 0 0 -9px}
.dt-oculto-site{outline:1px dashed ${c(P.vermelho)};outline-offset:1px;opacity:.5}
/* janela popup do GeneXus (gxp*): cartão com sombra, cabeçalho no tom da janela, botão fechar desenhado */
div.PopupBorder{background:${c(P.superficie)}!important;border:1px solid ${c(P.borda)}!important;border-radius:7px 7px 4px 4px;overflow:hidden;box-shadow:0 18px 50px ${e.escuro ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.28)'}}
div.PopupShadow{background:transparent!important;box-shadow:none!important}
div.PopupHeader{left:0!important;top:0!important;width:100%!important;height:24px!important;box-sizing:border-box;background:${c(P.elevado)}!important;
  background-image:linear-gradient(to bottom,${e.escuro ? x('elevado', 'texto', .07) : c(P.fundo)},${c(P.elevado)})!important;border:0!important;border-bottom:1px solid ${c(P.borda)}!important;color:${c(P.texto)}!important}
span.PopupTitle{display:flex;align-items:center;height:24px;padding:0 12px!important;color:${c(P.texto)}!important;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif;font-size:12.5px;font-weight:600;letter-spacing:.2px}
span.PopupHeaderButton{background-image:none!important;position:relative;width:32px!important;height:23px!important;margin:0!important;color:${suave};cursor:pointer;border-radius:0 6px 0 0}
span.PopupHeaderButton::before{content:'';position:absolute;inset:0;background-color:currentColor;${mascara('fechar', '12px')}}
span.PopupHeaderButton:hover{background-color:${c(P.vermelho)};color:${c(P.sobreDestaque)}}
div.PopupContent{background:${c(P.fundo)}}
div[id^="gxp"][id$="_rs"] img{visibility:hidden}
div[id^="gxp"][id$="_rs"]{background:linear-gradient(135deg,transparent 55%,${c(P.apagado)} 55%,${c(P.apagado)} 65%,transparent 65%,transparent 75%,${c(P.apagado)} 75%,${c(P.apagado)} 85%,transparent 85%)}
/* diálogo do DVelop (ConfirmPanel, ex. "Dados do Cliente" ao abrir a OS): cartão igual ao popup do GeneXus.
   O site põe margin-right:-1px no rodapé (fica 1px para fora embaixo); aqui rodapé e corpo não têm borda própria. */
div.DVelop-Dialog>.DVelop-Panel{border:1px solid ${c(P.borda)}!important;border-radius:8px;overflow:hidden;background:${c(P.superficie)}!important;box-sizing:border-box;
  box-shadow:0 18px 50px ${e.escuro ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.28)'}}
div.DVelop-Dialog.shadow>.underlay,div.DVelop-Container.shadow>.underlay{display:none!important}
div.DVelop-Dialog>.DVelop-Panel>.Header{height:auto!important;margin:0!important;padding:7px 14px!important;border:0!important;border-bottom:1px solid ${c(P.borda)}!important;
  background:${c(P.elevado)}!important;background-image:linear-gradient(to bottom,${e.escuro ? x('elevado', 'texto', .07) : c(P.fundo)},${c(P.elevado)})!important;
  color:${c(P.texto)}!important;font:600 12.5px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;letter-spacing:.2px}
div.DVelop-Dialog>.DVelop-Panel>.Header .TL,div.DVelop-Dialog>.DVelop-Panel>.Header .TR{display:none}
div.DVelop-Dialog>.DVelop-Panel>.Body{display:flex;align-items:flex-start;gap:12px;margin:0!important;border:0!important;background:${c(P.fundo)}!important;background-image:none!important;
  padding:20px 18px 6px!important;color:${c(P.texto)}!important;font-size:12.5px;line-height:1.45;height:auto!important}
div.DVelop-Dialog .Body .DVelop-Icon{flex:none;float:none;width:20px!important;height:20px!important;margin:0!important;background-image:none!important;background-color:${c(P.azul)};${mascara('info', '20px')}}
div.DVelop-Dialog .Body .DVelop-Icon.warnicon{background-color:${c(P.amarelo)};${mascara('aviso', '20px')}}
div.DVelop-Dialog .Body .DVelop-Icon.alrticon,div.DVelop-Dialog .Body .DVelop-Icon.blckicon{background-color:${c(P.vermelho)};${mascara('alerta', '20px')}}
div.DVelop-Dialog .Body .DVelop-Icon.hlpicon{${mascara('ajuda', '20px')}}
div.DVelop-Dialog .Body .DVelop-Icon.tipicon{background-color:${c(P.verde)}}
div.DVelop-Dialog>.DVelop-Panel>.Footer{margin:0!important;border:0!important;background:${c(P.fundo)}!important;padding:10px 14px 14px!important;font-size:100%}
div.DVelop-Dialog .Footer .button-group{display:flex!important;justify-content:flex-end;gap:8px}
div.DVelop-Dialog .Footer button{min-width:84px;width:auto!important;height:28px;margin:0!important;padding:0 16px;border:1px solid ${c(P.borda)};border-radius:6px;cursor:pointer;
  background:linear-gradient(${x('elevado', 'texto', e.escuro ? .06 : .02)}, ${c(P.elevado)});color:${c(P.texto)};font:600 12px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif}
div.DVelop-Dialog .Footer button:hover{background:${x('elevado', 'azul', .18)};border-color:${x('borda', 'azul', .6)}}
div.DVelop-Dialog .Footer button.default{background:${c(P.azul)};border-color:${c(P.azul)};color:${c(P.sobreDestaque)}}
div.DVelop-Dialog .Footer button.default:hover{background:${x('azul', 'texto', e.escuro ? .15 : .12)}}
div.DVelop-Dialog .Footer button:focus-visible{outline:2px solid ${c(P.azul)};outline-offset:2px}
/* dicas (Ext QuickTip): sem a moldura de imagem, cartão com cantos arredondados */
.x-tip .x-tip-tl,.x-tip .x-tip-tr,.x-tip .x-tip-tc,.x-tip .x-tip-ml,.x-tip .x-tip-mr,.x-tip .x-tip-mc,.x-tip .x-tip-bl,.x-tip .x-tip-br,.x-tip .x-tip-bc{background:transparent!important;background-image:none!important;padding:0!important;border:0!important}
.x-tip .x-tip-bwrap,.x-tip .x-tip-body{background:transparent!important}
div.x-tip{background:${c(P.elevado)}!important;border:1px solid ${c(P.borda)}!important;border-radius:6px;box-shadow:0 6px 18px ${sombra};padding:4px 8px!important}
div.x-tip .x-tip-body{color:${c(P.texto)}!important;font-size:11.5px!important;line-height:1.35}
div.x-tip .x-tip-header-text{color:${c(P.texto)}!important;font-weight:600}
div.x-tip + .x-shadow,div.x-tip ~ .x-shadow{display:none!important}
/* barra de ferramentas: realce ao passar o mouse e botão de menu aberto */
.x-toolbar table.x-btn{border-collapse:separate;border-radius:5px;transition:background-color .15s,box-shadow .15s}
.x-toolbar table.x-btn td{background-color:transparent!important;background-image:none!important}
.x-toolbar table.x-btn-over{background-color:${x('superficie', 'azul', e.escuro ? .16 : .1)}!important;box-shadow:inset 0 0 0 1px ${x('borda', 'azul', .45)}}
.x-toolbar table.x-btn-over button{color:${c(P.texto)}!important}
.x-toolbar table.x-btn-menu-active,.x-toolbar table.x-btn-pressed{background-color:${x('superficie', 'azul', e.escuro ? .26 : .16)}!important;box-shadow:inset 0 -2px 0 ${c(P.azul)},inset 0 0 0 1px ${x('borda', 'azul', .55)}}
.x-toolbar table.x-btn-click{background-color:${x('superficie', 'azul', .3)}!important}
.x-menu a.x-menu-item{border-radius:5px}
/* grades do GeneXus (WorkWith/Grid): cartão com borda, cabeçalho discreto, linhas com divisória e realce */
/* fundos de linha/célula não seguem o border-radius da tabela (e a última célula visível nem sempre é :last-child, quando
   há colunas escondidas depois): recorta a tabela inteira no contorno arredondado */
table.WorkWith,table.Grid,table.WorkWithFunil{border-collapse:separate!important;border-spacing:0!important;border:1px solid ${c(P.borda)}!important;border-radius:8px;clip-path:inset(0 round 8px);padding:0!important;background:${c(P.fundo)}}
table.WorkWith>*>tr:first-child>th:first-child,table.Grid>*>tr:first-child>th:first-child,table.WorkWithFunil>*>tr:first-child>th:first-child{border-top-left-radius:7px}
table.WorkWith>*>tr:first-child>th:last-child,table.Grid>*>tr:first-child>th:last-child,table.WorkWithFunil>*>tr:first-child>th:last-child{border-top-right-radius:7px}
td.WorkWithFooter,td.GridFooter{background:${c(P.elevado)}!important;background-image:none!important;border-top:1px solid ${c(P.borda)}!important;padding:5px!important;border-radius:0 0 7px 7px;color:${c(P.texto)}}
table.WorkWith>*>tr>th,table.Grid>*>tr>th,table.WorkWithFunil>*>tr>th,
table.WorkWith>*>tr>.WorkWithTitle,table.Grid>*>tr>.GridTitle,th.WorkWithTitle,th.GridTitle{background:${c(P.elevado)}!important;background-image:none!important;color:${c(P.texto)}!important;
  font-weight:600;padding:7px 8px!important;border:0!important;border-bottom:1px solid ${c(P.borda)}!important}
th.WorkWithTitle span,th.GridTitle span{cursor:pointer}
th.WorkWithTitle span:hover,th.GridTitle span:hover{color:${c(P.azul)}}
table.WorkWith>*>tr>td,table.Grid>*>tr>td,table.WorkWithFunil>*>tr>td{padding:5px 6px!important;word-break:normal!important;border:0!important;border-bottom:1px solid ${x('borda', 'fundo', .45)}!important}
table.WorkWith>*>tr:last-child>td,table.Grid>*>tr:last-child>td{border-bottom:0!important}
table.WorkWith>*>tr>td:not(:last-child),table.Grid>*>tr>td:not(:last-child),table.WorkWithFunil>*>tr>td:not(:last-child){border-right:1px solid ${x('borda', 'fundo', .45)}!important}
table.WorkWith>*>tr>th:not(:last-child),table.Grid>*>tr>th:not(:last-child),table.WorkWithFunil>*>tr>th:not(:last-child){border-right:1px solid ${c(P.borda)}!important}
table.WorkWith>*>tr.WorkWithOdd,table.Grid>*>tr.GridOdd{background-color:${c(P.fundo)}}
table.WorkWith>*>tr.WorkWithEven,table.Grid>*>tr.GridEven{background-color:${x('superficie', 'elevado', e.escuro ? .4 : .5)}}
table.WorkWith>*>tr.WorkWithOdd:hover,table.WorkWith>*>tr.WorkWithEven:hover,table.Grid>*>tr.GridOdd:hover,table.Grid>*>tr.GridEven:hover{background-color:${x('fundo', 'azul', e.escuro ? .14 : .08)}!important;color:${c(P.texto)}!important}
/* volks: .WorkWith tbody tr:hover{#000/white} e .gx-row-selected{black}, ambos !important */
table.WorkWith tbody tr:hover{background-color:${x('fundo', 'azul', e.escuro ? .14 : .08)}!important;color:${c(P.texto)}!important}
.gx-row-selected{background-color:${x('fundo', 'azul', e.escuro ? .28 : .18)}!important;color:${c(P.texto)}!important}
table.WorkWith [data-dt-vazia],table.Grid [data-dt-vazia]{display:none!important}
/* rodapé de paginação feito à mão (célula com bgcolor azul, botões IMGPAGE* e contador vCTLPAGINACAO "1 / 16"):
   vira uma barra no estilo do rodapé das grades */
td[bgcolor]:has(span[id*="CTLPAGINACAO" i], input[id^="IMGPAGE" i]){background:${c(P.elevado)}!important;background-image:none!important;
  border:1px solid ${c(P.borda)};border-radius:8px;color:${c(P.texto)}!important}
td[bgcolor]:has(span[id*="CTLPAGINACAO" i], input[id^="IMGPAGE" i]) :is(span,font){color:${c(P.texto)}!important}
td[bgcolor]:has(span[id*="CTLPAGINACAO" i], input[id^="IMGPAGE" i]) span[id*="CTLPAGINACAO" i]{font-weight:600}
td[bgcolor]:has(span[id*="CTLPAGINACAO" i], input[id^="IMGPAGE" i]) .dt-icone{color:${c(P.texto)}}
table.WorkWith>*>tr[class$="Selection"],table.Grid>*>tr[class$="Selection"]{background-color:${x('fundo', 'azul', e.escuro ? .24 : .14)}}
/* tela de login (LoginAux.aspx): a caixa #TABLELOGIN (border=1, fundo cinza inline) vira um cartão como as grades:
   cabeçalho com o nome da empresa e o logo, corpo com os campos e rodapé com a versão */
#TABLELOGIN{border-collapse:separate!important;border-spacing:0!important;border:1px solid ${c(P.borda)}!important;border-radius:8px;
  clip-path:inset(0 round 8px);background:${c(P.fundo)}!important;min-width:420px}
#TABLELOGIN>*>tr>td{border:0!important;padding:0!important}
#TABLELOGIN>*>tr:first-child>td{background:${c(P.elevado)}!important;border-bottom:1px solid ${c(P.borda)}!important}
#TABLELOGIN>*>tr:last-child>td{background:${c(P.elevado)}!important;border-top:1px solid ${c(P.borda)}!important}
#TABLEEMPRESA2 td{vertical-align:middle!important;padding:2px 6px!important}
/* nome da empresa: maior e na fonte escolhida (herda do td, que recebe a fonte do usuário; o id vence a fonte fixa do site) */
#span_vGRUPOEMPRESA_NOME{color:${c(P.texto)}!important;font-family:inherit!important;font-style:normal!important;font-weight:700!important;font-size:22px!important;line-height:1.2;letter-spacing:.01em}
#TABLEUSUARIO{background:transparent!important;padding:8px 6px 4px}
#TABLEUSUARIO td.DataDescriptionCell,#TABLEUSUARIO td.DataContentCell{vertical-align:middle!important}
#TABLEUSUARIO td.DataDescriptionCell{background:transparent!important;text-align:right;padding:4px 8px 4px 12px!important}
#TABLEUSUARIO td.DataDescriptionCell span{color:${c(P.apagado)}!important;font-family:inherit!important;font-size:12px!important;font-weight:600!important}
#TABLEUSUARIO td.DataContentCell{background:transparent!important;padding:4px 6px!important}
#TABLEUSUARIO input.Attribute{height:26px;box-sizing:border-box;border-radius:5px;padding:0 8px}
#TABLE2{margin-top:6px}
#TBLVERSAO td{padding:3px 4px!important}
#TBLVERSAO span{color:${c(P.apagado)}!important}
/* "Esqueci minha Senha" (wp_esqueciminhasenha.aspx, aberta pelo link da tela de login): #TABLEMAIN vira um cartão como o
   do login, com título/explicação no cabeçalho, usuário e captcha no corpo e Confirmar/Fechar no rodapé */
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN{border-collapse:separate!important;border-spacing:0!important;border:1px solid ${c(P.borda)}!important;
  border-radius:8px;clip-path:inset(0 round 8px);background:${c(P.fundo)}!important;min-width:460px}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr>td{padding:0 14px!important;height:auto!important}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#gxErrorViewer:empty),
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(>td:empty){display:none}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#TEXTBLOCK2,#TEXTBLOCK1,#TEXTBLOCK3)>td{background:${c(P.elevado)}!important}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#TEXTBLOCK2)>td{padding-top:12px!important}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#TEXTBLOCK3)>td{padding-bottom:12px!important;border-bottom:1px solid ${c(P.borda)}!important;text-align:center}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#TABLE2)>td{padding:14px!important}
form[action^="wp_esqueciminhasenha" i] #TABLEMAIN>*>tr:has(#TABLEACTIONS)>td{background:${c(P.elevado)}!important;border-top:1px solid ${c(P.borda)}!important;padding:6px 10px!important}
form[action^="wp_esqueciminhasenha" i] #TEXTBLOCK2{color:${c(P.texto)}!important;font-family:inherit!important;font-style:normal!important;font-weight:700!important;font-size:20px!important}
form[action^="wp_esqueciminhasenha" i] #TEXTBLOCK1{color:${c(P.azul)}!important;font-family:inherit!important;font-size:13px!important;font-weight:600!important}
form[action^="wp_esqueciminhasenha" i] #TEXTBLOCK3{color:${c(P.apagado)}!important;font-family:inherit!important}
form[action^="wp_esqueciminhasenha" i] #TABLE2{background:transparent!important;width:100%;border-collapse:separate!important;border:1px solid ${c(P.borda)}!important;border-radius:6px;clip-path:inset(0 round 6px);padding:4px}
form[action^="wp_esqueciminhasenha" i] #TABLE2 td.DataDescriptionCell:has(+td #captchaImage){vertical-align:bottom!important;padding-bottom:10px!important}
form[action^="wp_esqueciminhasenha" i] #TABLE2 td{background:transparent!important;vertical-align:middle!important;padding:4px 6px!important}
form[action^="wp_esqueciminhasenha" i] #TABLE2 td.DataDescriptionCell{text-align:right;width:1%;white-space:nowrap;padding-right:10px!important}
form[action^="wp_esqueciminhasenha" i] #TABLE2 td.DataDescriptionCell span{color:${c(P.apagado)}!important;font-family:inherit!important;font-size:12px!important;font-weight:600!important}
form[action^="wp_esqueciminhasenha" i] #span_vUSUARIO_IDENTIFICADOR{color:${c(P.texto)}!important;font-family:inherit!important;font-weight:600!important}
form[action^="wp_esqueciminhasenha" i] #captchaImage{display:grid;grid-template-columns:auto auto;justify-content:start;align-items:end;gap:6px 10px}
form[action^="wp_esqueciminhasenha" i] #captchaImage br{display:none}
form[action^="wp_esqueciminhasenha" i] #captchaImage img{border-radius:5px;border:1px solid ${c(P.borda)}}
form[action^="wp_esqueciminhasenha" i] #captchaImage input{grid-column:1;width:140px;height:26px;box-sizing:border-box;border-radius:5px;padding:0 8px}
form[action^="wp_esqueciminhasenha" i] #TABLEACTIONS{float:none!important;margin-left:auto}
/* árvore YUI TreeView (Delegar, Grupo de Acesso > Menu): linhas e caixas +/- eram GIFs pretos; viram traços na cor da
   borda desenhados com degradês, e a caixa +/- fica no div.ygtvspacer da célula */
td:is(.ygtvdepthcell,.ygtvtn,.ygtvln,.ygtvtm,.ygtvtmh,.ygtvtp,.ygtvtph,.ygtvlm,.ygtvlmh,.ygtvlp,.ygtvlph){background:none!important}
td.ygtvdepthcell{background:linear-gradient(${linhaArv},${linhaArv}) 7px 0/1px 100% no-repeat!important}
td:is(.ygtvtn,.ygtvtm,.ygtvtmh,.ygtvtp,.ygtvtph){background:linear-gradient(${linhaArv},${linhaArv}) 7px 0/1px 100% no-repeat,linear-gradient(${linhaArv},${linhaArv}) 8px 50%/8px 1px no-repeat!important}
td:is(.ygtvln,.ygtvlm,.ygtvlmh,.ygtvlp,.ygtvlph){background:linear-gradient(${linhaArv},${linhaArv}) 7px 0/1px 50% no-repeat,linear-gradient(${linhaArv},${linhaArv}) 8px 50%/8px 1px no-repeat!important}
td:is(.ygtvtm,.ygtvtmh,.ygtvtp,.ygtvtph,.ygtvlm,.ygtvlmh,.ygtvlp,.ygtvlph)>.ygtvspacer{box-sizing:border-box;width:11px;height:11px;margin:0 0 0 2px;border:1px solid ${x('borda', 'texto', .3)};border-radius:3px;position:relative;z-index:1}
td:is(.ygtvtm,.ygtvtmh,.ygtvlm,.ygtvlmh)>.ygtvspacer{background:linear-gradient(${c(P.texto)},${c(P.texto)}) center/5px 1px no-repeat,${c(P.superficie)}}
td:is(.ygtvtp,.ygtvtph,.ygtvlp,.ygtvlph)>.ygtvspacer{background:linear-gradient(${c(P.texto)},${c(P.texto)}) center/5px 1px no-repeat,linear-gradient(${c(P.texto)},${c(P.texto)}) center/1px 5px no-repeat,${c(P.superficie)}}
td:is(.ygtvtmh,.ygtvtph,.ygtvlmh,.ygtvlph)>.ygtvspacer{border-color:${c(P.azul)}}
a.BasicNodeTextDecoration{color:${c(P.texto)}!important;text-decoration:none!important}
a.BasicNodeTextDecoration:hover span{color:${c(P.azul)}}
.NodeTextDecorationSelected{background-color:${x('fundo', 'azul', e.escuro ? .28 : .16)}!important;color:${c(P.texto)}!important;border-radius:4px;padding:1px 4px;margin-left:-4px}
/* caixas com título (fieldset.Contorno, usadas em várias telas): borda arredondada na cor do tema e título em destaque */
fieldset.Contorno{border:1px solid ${c(P.borda)}!important;border-radius:8px}
legend.ContornoTitle{color:${c(P.texto)}!important;padding:0 6px!important}
/* Grupo de Acesso > Menu (wp_grupoacessomenu): os dois fieldsets têm width/height 100% + margem e padding, então a árvore
   vazava pela direita e por baixo; aqui viram dois cartões alinhados no topo, cada um com a altura do conteúdo */
form[action^="wp_grupoacessomenu" i] #TABLE>tbody>tr>td{vertical-align:top!important}
form[action^="wp_grupoacessomenu" i] :is(#GROUP,#GROUPSEL){box-sizing:border-box;height:auto!important;margin:0 4px!important;padding:6px 10px 10px!important;background:${c(P.fundo)}}
form[action^="wp_grupoacessomenu" i] #Grid1ContainerTbl td{vertical-align:middle!important}
/* OS (wp_oficinaitem), "Serviços e Produtos": tabela montada à mão (cabeçalho com bgcolor azul, linhas em tabelas
   aninhadas). Vira um cartão como as grades acima: cabeçalho discreto e corpo com divisórias e realce. Larguras não mudam:
   a borda é contorno (outline) e o cabeçalho encosta no corpo com margem negativa (cellspacing/cellpadding de 2px),
   alinhado embaixo porque o botão Adicionar ao lado deixa a linha mais alta. */
#TABLEHEADERGRID{background:${c(P.elevado)};border-radius:8px 8px 0 0;outline:1px solid ${c(P.borda)};outline-offset:-1px;margin-bottom:-6px}
#TABLEGRIDSRV td:has(>#TABLEHEADERGRID){vertical-align:bottom!important}
#TABLEHEADERGRID>tbody>tr,#TABLEGRIDSRV table[id^="TABLECABECALHOGRID" i]>tbody>tr{background:transparent!important}
#TABLEGRIDSRV table[id^="TABLECABECALHOGRID" i]{background:${c(P.elevado)}}
#TABLEHEADERGRID .TextBlock,#TABLEGRIDSRV table[id^="TABLECABECALHOGRID" i] .TextBlock{color:${c(P.texto)}!important;font-weight:600!important}
#GridprincipalContainerTbl{background:${c(P.fundo)};border-radius:0 0 8px 8px;clip-path:inset(0 round 0 0 8px 8px);outline:1px solid ${c(P.borda)};outline-offset:-1px}
#GridprincipalContainerTbl table[id^="TABLESRV" i]>tbody>tr[style*="background" i],#GridprincipalContainerTbl table[id^="TABLEPRD" i]>tbody>tr[style*="background" i]{box-shadow:inset 0 -1px 0 ${x('borda', 'fundo', .45)};transition:background-color .12s}
#GridprincipalContainerTbl table[id^="TABLESRVU_" i]>tbody>tr[style*="background" i]{background-color:${x('superficie', 'elevado', e.escuro ? .4 : .5)}!important}
#GridprincipalContainerTbl table[id^="TABLESRV_" i]>tbody>tr[style*="background" i]{background-color:${c(P.fundo)}!important}
#GridprincipalContainerTbl table[id^="TABLESRV" i]>tbody>tr[style*="background" i]:hover,#GridprincipalContainerTbl table[id^="TABLEPRD" i]>tbody>tr[style*="background" i]:hover{background-color:${x('fundo', 'azul', e.escuro ? .14 : .08)}!important}
/* carregando (AJAX do GeneXus e máscara do ExtJS): o GIF some, fica um anel girando nas cores do esquema */
@keyframes dt-girar{to{transform:rotate(360deg)}}
img#gx_ajax_indicator,img[src$="/indicator.gif" i]{visibility:hidden!important}
#gx_ajax_notification::after{content:'';position:fixed;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;box-sizing:border-box;border-radius:50%;
  border:3px solid ${e.escuro ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.35)'};border-top-color:${c(P.azul)};animation:dt-girar .8s linear infinite;z-index:1000}
.x-mask-loading div{background-image:none!important;position:relative}
.x-mask-loading div::before{content:'';position:absolute;left:6px;top:50%;width:14px;height:14px;margin-top:-7px;box-sizing:border-box;border-radius:50%;
  border:2px solid ${c(P.borda)};border-top-color:${c(P.azul)};animation:dt-girar .8s linear infinite}
/* botões de opção (radio) e caixas de seleção */
input[type="radio" i]{-webkit-appearance:none;appearance:none;box-sizing:border-box;display:inline-grid;place-content:center;width:15px;height:15px;margin:0 4px 0 3px;padding:0;
  vertical-align:0;border:1.5px solid ${c(P.apagado)};border-radius:50%;background:${c(P.fundo)};cursor:pointer;transition:border-color .12s,background-color .12s}
input[type="radio" i]::before{content:'';width:7px;height:7px;border-radius:50%;background:${c(P.sobreDestaque)};transform:scale(0);transition:transform .12s}
input[type="radio" i]:hover{border-color:${c(P.azul)}}
input[type="radio" i]:checked{border-color:${c(P.azul)};background:${c(P.azul)}}
input[type="radio" i]:checked::before{transform:scale(1)}
input[type="radio" i]:focus-visible{outline:2px solid ${x('azul', 'fundo', .4)};outline-offset:1px}
input[type="radio" i]:disabled{opacity:.45;cursor:default}
input[type="checkbox" i]{accent-color:${c(P.azul)}}
/* campos de texto do GeneXus (a borda inset já virou solid na cópia traduzida). Sem mexer em largura, altura,
   espessura nem padding: o layout fica igual. Os campos do ExtJS (.x-form-field) e os destacados pelo site
   (aviso, alterado, erro) ficam de fora */
${camposTexto('')}{border-color:${x('borda', 'texto', e.escuro ? .22 : .16)};border-radius:3px}
${camposTexto(':hover')}{border-color:${x('borda', 'texto', e.escuro ? .4 : .32)}}
${camposTexto(':focus')}{border-color:${c(P.azul)};outline:0;box-shadow:0 0 0 2px ${x('azul', 'fundo', .55)}}
/* Filtro Seleção: menu lateral, listas Disponíveis/Selecionados */
table.tbfiltroselecaonormal,table.tbfiltroselecaosel{border-radius:6px;clip-path:inset(0 round 6px);margin:1px 0;cursor:pointer;background:transparent!important;border-collapse:separate}
table.tbfiltroselecaonormal td,table.tbfiltroselecaosel td{background:transparent!important;padding:3px 4px!important}
table.tbfiltroselecaonormal:hover{background:${c(P.elevado)}!important}
table.tbfiltroselecaosel{background:${x('fundo', 'azul', e.escuro ? .22 : .12)}!important;box-shadow:inset 3px 0 0 ${c(P.azul)}}
table.tbfiltroselecaonormal a,table.tbfiltroselecaosel a{color:${c(P.texto)}!important;text-decoration:none!important}
table.tbfiltroselecaosel a{font-weight:bold}
select.AttListBoxScroll{border:1px solid ${c(P.borda)}!important;border-radius:6px;background:${c(P.fundo)}!important;color:${c(P.texto)}!important;padding:3px;outline:none}
select.AttListBoxScroll:focus{border-color:${c(P.azul)}!important}
select.AttListBoxScroll option{padding:3px 6px;border-radius:4px}
select.AttListBoxScroll option:checked{background:${c(P.azul)} linear-gradient(${c(P.azul)},${c(P.azul)});color:${c(P.sobreDestaque)}}
#TABLEFILTROS>tbody>tr:first-child>td[bgcolor]{background:transparent!important;text-align:left;padding:6px 4px 3px!important}
#TABLEFILTROS>tbody>tr:first-child .TextVecComModelo{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;color:${c(P.apagado)}}
/* calendário (dynarch) */
div.calendar{border:1px solid ${c(P.borda)}!important;border-radius:8px;background:${c(P.superficie)}!important;padding:6px;box-shadow:0 8px 24px ${sombra};font-size:12px!important}
div.calendar table{border:0!important;background:transparent!important;color:${c(P.texto)}!important;border-collapse:separate!important;border-spacing:2px!important;font-size:12px!important}
div.calendar .calendarbutton{border:0!important;background:transparent!important;background-image:none!important;color:${suave}!important;border-radius:5px;padding:4px 5px!important;cursor:pointer}
div.calendar thead .calendartitle{background:transparent!important;border:0!important;color:${c(P.texto)}!important;font-size:13px;padding:4px!important}
div.calendar thead .hilite,div.calendar thead .active{border:0!important;padding:4px 5px!important;background:${c(P.elevado)}!important;color:${c(P.texto)}!important}
div.calendar thead .calendarbutton:last-child.hilite{background:${c(P.vermelho)}!important;color:${c(P.sobreDestaque)}!important}
div.calendar thead .name{background:transparent!important;border:0!important;border-bottom:1px solid ${c(P.borda)}!important;color:${c(P.apagado)}!important;font-size:10px;font-weight:bold;text-transform:uppercase;padding:5px 2px!important;text-align:center}
div.calendar thead .name.weekend,div.calendar tbody td.weekend{color:${c(P.vermelho)}!important}
div.calendar tbody td.day{text-align:center!important;min-width:2.2em;padding:5px 0!important;border:0!important;border-radius:6px;cursor:pointer}
div.calendar tbody .rowhilite td{background:${x('superficie', 'azul', .06)}!important;color:inherit}
div.calendar tbody td.hilite,div.calendar tbody .rowhilite td.hilite{background:${c(P.elevado)}!important;color:${c(P.texto)}!important;padding:5px 0!important;border:0!important}
div.calendar tbody td.today{color:${c(P.azul)}!important;box-shadow:inset 0 0 0 1px ${c(P.azul)};font-weight:bold}
div.calendar tbody td.selected{background:${c(P.azul)}!important;color:${c(P.sobreDestaque)}!important;font-weight:bold;padding:5px 0!important;border:0!important}
div.calendar tbody td.active{background:${x('azul', 'fundo', .3)}!important;padding:5px 0!important;border:0!important}
div.calendar tbody td.disabled{color:${c(P.borda)}!important}
div.calendar tfoot .ttip{background:transparent!important;border:0!important;border-top:1px solid ${c(P.borda)}!important;color:${c(P.apagado)}!important;padding:5px!important;font-size:10px}
div.calendar tfoot .hilite,div.calendar tfoot .active{background:${c(P.elevado)}!important;border:0!important;padding:5px!important}
div.calendar td.time{background:transparent!important;border-top:1px solid ${c(P.borda)}!important}
div.calendar td.time .hour,div.calendar td.time .minute,div.calendar td.time .ampm{background:${c(P.elevado)}!important;border:1px solid ${c(P.borda)}!important;border-radius:4px;color:${c(P.texto)}!important}
div.calendarcombo{background:${c(P.superficie)}!important;border:1px solid ${c(P.borda)}!important;border-radius:6px;padding:3px;box-shadow:0 6px 16px ${sombra}}
div.calendarcombo .label{padding:3px!important;border-radius:4px;color:${c(P.texto)}!important}
div.calendarcombo .hilite{background:${c(P.azul)}!important;color:${c(P.sobreDestaque)}!important}
div.calendarcombo .active{border:0!important;background:${c(P.elevado)}!important;font-weight:bold}
`;
    }

    // ---- botões HTML no lugar das imagens + ícones SVG no lugar dos sprites do ExtJS ----
    function cssImagens(e, P, ext) {
        const c = corCss;
        const x = (a, b, t) => c(misturar(P[a], P[b], t));
        const suave = c(misturar(P.apagado, P.texto, e.escuro ? 0.45 : 0.55));
        let s = `
img[src*="ActionDisabled" i],input[src*="ActionDisabled" i]{visibility:hidden!important}
[data-dt-oculto]{position:absolute!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important;clip-path:inset(50%)!important}
.dt-img{box-sizing:border-box;vertical-align:middle;font-family:inherit;-webkit-appearance:none;appearance:none}
button.dt-img{cursor:pointer;margin:0}
button.dt-img:focus-visible{outline:2px solid ${c(P.azul)};outline-offset:1px}
button.dt-img:disabled{opacity:.45;cursor:default}
.dt-svg{display:block;flex:none;width:16px;height:16px;pointer-events:none}
.dt-texto{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:96px;height:24px;margin:2px;padding:0 8px;
  border:1px solid ${c(P.borda)};border-radius:5px;background:linear-gradient(${x('elevado', 'texto', e.escuro ? .06 : .02)}, ${c(P.elevado)});
  color:${c(P.texto)};font-size:11px;font-weight:bold;line-height:1.05;text-align:center;white-space:normal;overflow:hidden}
.dt-texto[style*="min-height"]{padding-top:2px;padding-bottom:2px}
.dt-texto{display:inline-grid!important;grid-template-columns:16px minmax(0,1fr);column-gap:5px;align-items:center;justify-items:center}
.dt-texto>.dt-svg{grid-column:1}
.dt-texto>span{grid-column:2;min-width:0;text-align:center;text-wrap:balance}
/* botões "redondos" do GeneXus (BaseRBtn): sem as bordas em imagem, no estilo dos botões de texto, largura do rótulo */
span.BaseRBtn,span.BaseRBtn .BtnLeft,span.BaseRBtn .BtnRight,span.BaseRBtn .BtnBackground{display:inline-block;background:none!important;background-image:none!important;
  padding:0!important;margin:0!important;border:0!important;height:auto!important;width:auto!important;vertical-align:middle}
span.BaseRBtn .BtnBackground{position:relative}
span.BaseRBtn input.BtnText{-webkit-appearance:none;appearance:none;box-sizing:border-box;height:24px!important;min-width:64px;margin:2px!important;padding:0 10px!important;
  border:1px solid ${c(P.borda)}!important;border-radius:5px!important;background:linear-gradient(${x('elevado', 'texto', e.escuro ? .06 : .02)}, ${c(P.elevado)})!important;
  color:${c(P.texto)}!important;font:bold 11px/1 inherit!important;font-family:inherit!important;cursor:pointer;text-shadow:none!important;box-shadow:none!important}
span.BaseRBtn input.BtnText:hover:not(:disabled){background:${x('elevado', 'azul', .18)}!important;border-color:${x('borda', 'azul', .6)}!important}
span.BaseRBtn input.BtnText:active:not(:disabled){transform:translateY(1px)}
span.BaseRBtn input.BtnText:focus-visible{outline:2px solid ${c(P.azul)};outline-offset:1px}
span.BaseRBtn input.BtnText:disabled{opacity:.45;cursor:default}
span.BaseRBtn [data-dt-rbtn]>input.BtnText{padding-left:27px!important}
span.BaseRBtn [data-dt-rbtn]::before{content:'';position:absolute;left:10px;top:50%;width:14px;height:14px;margin-top:-7px;pointer-events:none;z-index:1;
  background-color:${c(P.texto)};-webkit-mask:var(--dt-ic) center/14px no-repeat;mask:var(--dt-ic) center/14px no-repeat}
${MATIZES.map(m => `span.BaseRBtn [data-dt-rbtn="${m}"]::before{background-color:${c(P[m])}}`).join('\n')}
.dt-texto.dt-longo{font-size:10px;letter-spacing:-.2px;column-gap:4px;padding:0 5px}
.dt-desativado{opacity:.55}
.dt-icone.dt-caixa{display:inline-flex;align-items:center;justify-content:center;min-width:26px;min-height:22px;padding:0;margin:1px;
  border:1px solid ${c(P.borda)};border-radius:5px;background:${c(P.elevado)};color:${c(P.texto)}}
.dt-icone.dt-caixa:hover:not(:disabled){background:${x('elevado', 'azul', .18)};border-color:${x('borda', 'azul', .6)}}
.dt-texto:hover:not(:disabled){background:${x('elevado', 'azul', .18)};border-color:${x('borda', 'azul', .6)}}
.dt-texto:active:not(:disabled){transform:translateY(1px)}
.dt-icone{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;
  border:1px solid transparent;border-radius:4px;background:transparent;color:${suave}}
[data-dt-contraste] .dt-icone:not([class*="dt-c-"]){color:var(--dt-contraste)}
.dt-icone.dt-grande{width:28px;height:28px}
.dt-icone.dt-grande .dt-svg{width:20px;height:20px}
button.dt-icone:hover{background:${c(P.elevado)};border-color:${c(P.borda)};color:${c(P.texto)}}
a .dt-icone{cursor:pointer}
a:hover .dt-icone{background:${c(P.elevado)};border-color:${c(P.borda)}}
.dt-check{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin:0 2px;padding:0;
  border:1.5px solid ${c(P.apagado)};border-radius:3px;background:${c(P.fundo)};color:${c(P.sobreDestaque)}}
.dt-check .dt-svg{width:11px;height:11px;stroke-width:3.2;visibility:hidden}
.dt-check.dt-marcado{background:${c(P.azul)};border-color:${c(P.azul)}}
.dt-check.dt-marcado .dt-svg{visibility:visible}
.dt-check:hover{border-color:${c(P.azul)}}
.dt-amostra{display:inline-block;border:1px solid;border-radius:3px}
${MATIZES.map(m => `.dt-c-${m} .dt-svg{color:${c(P[m])}}`).join('\n')}
.dt-c-texto .dt-svg{color:${c(P.texto)}}
/* partes de um ícone com cor própria (ex. "+" vermelho do fs+, seta verde junto do carro) */
${MATIZES.map(m => `.dt-svg .dt-k-${m}{color:${c(P[m])}}`).join('\n')}
.dt-svg .dt-k-texto{color:${c(P.texto)}}
`;
        // paginação das grades GeneXus (spans com imagem de fundo)
        const pag = { First: 'primeira', Previous: 'anterior', Next: 'proxima', Last: 'ultima' };
        for (const k in pag) s += `.PagingButtons${k}::before{${mascara(pag[k], '16px')}}\n`;
        s += `
.PagingButtonsFirst,.PagingButtonsPrevious,.PagingButtonsNext,.PagingButtonsLast{background-image:none!important;position:relative;border-radius:4px;opacity:.85}
.PagingButtonsFirst::before,.PagingButtonsPrevious::before,.PagingButtonsNext::before,.PagingButtonsLast::before{content:'';position:absolute;inset:0;background-color:currentColor}
.PagingButtonsFirst:hover,.PagingButtonsPrevious:hover,.PagingButtonsNext:hover,.PagingButtonsLast:hover{opacity:1;box-shadow:inset 0 0 0 1px currentColor}
`;
        // Quadro de agendamento (dhtmlxScheduler timeline, QuadroAgendamento.shtml). Posição e tamanho dos
        // cartões e células vêm do próprio scheduler (inline): aqui só cor, borda, cantos e tipografia.
        if (doc.querySelector('script[src*="dhtmlxscheduler" i], link[href*="dhtmlxscheduler" i]')) s += `
.dhx_cal_container{background:${c(P.fundo)}!important;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif}
.dhx_cal_navline .dhx_cal_date{color:${c(P.texto)}!important;font:600 17px/30px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;letter-spacing:.2px}
.dhx_cal_navline .dhx_cal_today_button,.dhx_cal_navline .dhx_cal_prev_button,.dhx_cal_navline .dhx_cal_next_button{
  background-color:${c(P.superficie)}!important;border:1px solid ${c(P.borda)}!important;color:${c(P.texto)}!important;box-shadow:0 1px 2px rgba(0,0,0,${e.escuro ? .3 : .08});cursor:pointer}
.dhx_cal_navline .dhx_cal_today_button{border-radius:6px!important;font:600 12px/30px "Segoe UI",system-ui,sans-serif!important}
.dhx_cal_navline .dhx_cal_prev_button{border-radius:6px 0 0 6px!important}
.dhx_cal_navline .dhx_cal_next_button{border-radius:0 6px 6px 0!important}
.dhx_cal_navline :is(.dhx_cal_today_button,.dhx_cal_prev_button,.dhx_cal_next_button):hover{background-color:${x('superficie', 'azul', e.escuro ? .16 : .1)}!important;border-color:${x('borda', 'azul', .45)}!important}
.dhx_cal_header{border-color:${c(P.borda)}!important;background:${c(P.superficie)}!important}
.dhx_cal_header .dhx_scale_bar{background:${c(P.superficie)}!important;color:${c(P.apagado)}!important;border-left-color:${x('superficie', 'borda', .55)}!important;border-bottom-color:${c(P.borda)}!important;font-size:9.5px!important}
.dhx_cal_header .dhx_second_scale_bar{color:${c(P.texto)}!important;font:600 12px/16px "Segoe UI",system-ui,sans-serif!important;border-left-color:${c(P.borda)}!important}
.dhx_cal_data{border-top-color:${c(P.borda)}!important}
/* nomes: sem padding (a tabela é table-layout:fixed e qualquer padding alarga a coluna e desalinha do cabeçalho) */
.dhx_matrix_scell{background:${c(P.superficie)}!important;color:${c(P.texto)}!important;border-right:1px solid ${c(P.borda)}!important;border-bottom:1px solid ${c(P.borda)}!important;
  font:600 10.5px/1.3 "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;letter-spacing:.2px}
.dhx_matrix_cell{background:${c(P.fundo)}!important;border-right:1px solid ${x('fundo', 'borda', .4)}!important;border-bottom:1px solid ${c(P.borda)}!important}
.dhx_matrix_cell:nth-child(6n){border-right-color:${c(P.borda)}!important}
.dhx_cal_data tr:hover>.dhx_matrix_scell{background:${x('superficie', 'azul', e.escuro ? .14 : .08)}!important;box-shadow:inset 3px 0 0 ${c(P.azul)}}
.dhx_cal_data tr:hover>td>.dhx_matrix_line .dhx_matrix_cell{background:${x('fundo', 'azul', e.escuro ? .06 : .04)}!important}
.dhx_marked_timespan.gray_section{opacity:1!important;background:repeating-linear-gradient(135deg,${x('fundo', 'borda', e.escuro ? .32 : .28)} 0 1px,${x('fundo', 'superficie', .7)} 1px 7px)!important}
.dhx_marked_timespan.red_section{opacity:1!important;background:${x('fundo', 'vermelho', .18)}!important}
.dhx_marked_timespan.purple_section{opacity:1!important;background-color:${x('fundo', 'azul', .22)}!important}
.dhx_marked_timespan.yellowgreen_section{opacity:1!important;background-color:${x('fundo', 'verde', .22)}!important}
.dhx_matrix_now_time{opacity:1!important;border-left:2px solid ${c(P.vermelho)}!important;box-shadow:0 0 6px ${x('fundo', 'vermelho', .6)};z-index:1}
.dhx_cal_event_line[data-dt-cat]{background:var(--dt-cat-fundo)!important;border:1px solid var(--dt-cat-borda)!important;border-radius:5px!important;
  box-shadow:inset 3px 0 0 var(--dt-cat),0 1px 3px rgba(0,0,0,${e.escuro ? .35 : .12})!important;color:${c(P.texto)}!important;overflow:hidden;
  font:500 11px/17px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;transition:background-color .12s,box-shadow .12s}
.dhx_cal_event_line[data-dt-cat]::first-line{font-weight:700;letter-spacing:.3px}
.dhx_cal_event_line[data-dt-cat]:hover{background:var(--dt-cat-sobre)!important;box-shadow:inset 3px 0 0 var(--dt-cat),0 2px 8px rgba(0,0,0,${e.escuro ? .5 : .2})!important;z-index:5}
.dhx_cal_event_line>.status{border-right:0!important;width:4px!important}
.dhx_cal_event_line>.status[data-dt-cat]{background-color:var(--dt-cat)!important}
.dhx_cal_event_line>.status:not([data-dt-cat]){display:none}
.dhtmlXTooltip.tooltip{background:${c(P.elevado)}!important;color:${c(P.texto)}!important;border:1px solid ${c(P.borda)}!important;border-radius:8px!important;
  box-shadow:0 8px 24px rgba(0,0,0,${e.escuro ? .45 : .18})!important;padding:8px 10px!important;font:12px/1.45 "Segoe UI",system-ui,sans-serif!important}
`;
        // legenda do quadro (wp_agendamentoquadro.aspx): mesma cor de categoria dos cartões
        s += `
fieldset[id^="GROUPLEGENDA" i] td[data-dt-cat]{background:var(--dt-cat)!important;border-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,${e.escuro ? .35 : .12})}
`;
        // árvore YUI (Delegar, Grupo de Acesso > Menu): o ícone do nó é fundo inline do <a> (padding-left 20px)
        const noArvore = (arq, nome, cor) => `a.BasicNodeTextDecoration[style*="${arq}" i]{background-image:none!important;position:relative}
a.BasicNodeTextDecoration[style*="${arq}" i]::before{content:'';position:absolute;left:0;top:50%;width:16px;height:16px;margin-top:-6px;background-color:${c(P[cor])};${mascara(nome, '16px')}}
`;
        s += noArvore('customIcons/folder', 'pasta', 'amarelo') + noArvore('customIcons/folderopen', 'pastaAberta', 'amarelo')
            + noArvore('customIcons/page', 'documento', 'azul')
            + noArvore('selectRow', 'checkGrosso', 'verde') + noArvore('unselectRow', 'checkGrosso', 'vermelho')
            + noArvore('WorkflowOrganizationalModel', 'predio', 'azul') + noArvore('WorkflowRole', 'usuarios', 'magenta')
            + noArvore('WorkflowUser', 'usuario', 'ciano');
        if (!ext) return s;
        // ExtJS: o ícone vira máscara pintada com a cor do texto
        const ico = (sels, nome, tam) => {
            const lista = sels.split(',').map(t => t.trim());
            return `${lista.join(',')}{background-image:none!important;position:relative}
${lista.map(t => t + '::before').join(',')}{content:'';position:absolute;inset:0;background-color:currentColor;${mascara(nome, tam || '15px')}}\n`;
        };
        const btn = cls => `table.${cls} button.x-btn-text,button.x-btn-text.${cls}`;
        s += ico(btn('extNewWindow'), 'janelaNova') + ico(btn('cascade'), 'cascata') + ico(btn('closeAll'), 'fecharTodas')
            + ico(btn('minimizeAll'), 'minimizarTodas') + ico(btn('save'), 'salvar') + ico(btn('delete'), 'lixeira') + ico(btn('new'), 'workspace')
            + ico('button.x-btn-text[style*="SAC.png"]', 'ajuda')
            + ico(btn('x-tbar-page-first'), 'primeira') + ico(btn('x-tbar-page-prev'), 'anterior') + ico(btn('x-tbar-page-next'), 'proxima')
            + ico(btn('x-tbar-page-last'), 'ultima') + ico(btn('x-tbar-loading'), 'atualizar');
        const ferramentas = { 'close': 'fechar', 'minimize': 'minimizar', 'maximize': 'maximizar', 'restore': 'restaurar',
            'W5Portal_SetAsBookmark': 'estrela', 'W5Portal_Icon_AutoAdjust': 'ajustar', 'W5Portal_Icon_Forward': 'proxima',
            'W5Portal_Icon_Back': 'anterior', 'W5Portal_Icon_RefreshWindow': 'atualizar', 'W5Portal_Icon_Print': 'imprimir',
            'toggle': 'baixo', 'refresh': 'atualizar', 'print': 'imprimir', 'search': 'busca', 'help': 'ajuda', 'plus': 'mais', 'minus': 'menos' };
        for (const k in ferramentas) s += ico(`.x-tool.x-tool-${k}`, ferramentas[k], '13px');
        s += ico('.W5Portal_Icon_BookmarkStar', 'estrela', '13px');
        s += `
.x-tool{background-color:transparent!important;color:${suave};border-radius:3px}
.x-tool:hover{color:${c(P.texto)};background-color:${c(P.borda)}!important}
.x-tool.x-tool-close:hover{color:${c(P.sobreDestaque)};background-color:${c(P.vermelho)}!important}
.W5Portal_Icon_BookmarkStar{color:${suave};cursor:pointer}
.W5Portal_Icon_BookmarkStar:hover{color:${c(P.amarelo)}}
.x-btn-arrow{background-image:none!important;position:relative}
.x-btn-arrow::after{content:'';position:absolute;right:0;top:50%;width:9px;height:9px;margin-top:-4px;background-color:currentColor;opacity:.7;${mascara('baixo', '9px')}}
a.x-menu-item-arrow{background-image:none!important;position:relative}
a.x-menu-item-arrow::after{content:'';position:absolute;right:4px;top:50%;width:11px;height:11px;margin-top:-5px;background-color:currentColor;opacity:.75;${mascara('proxima', '11px')}}
.xtb-sep{background-image:none!important;width:0!important;height:16px;margin:0 4px;border-left:1px solid ${c(P.borda)}}
/* tema de conta "volks": texto branco sobre a barra cinza-esverdeada (o branco vira a cor de fundo) e botões
   de ícone sem ícone (x-btn-noicon, só um glifo FontAwesome em ::before), que encolhem para 3px */
.x-toolbar .x-btn button.x-btn-text{color:${c(P.texto)}!important}
.x-toolbar div.xtb-text{color:${suave}!important}
table.x-btn-noicon:is(.extNewWindow,.cascade,.closeAll,.minimizeAll,.save,.delete,.new) button.x-btn-text{width:22px!important;height:20px!important;color:${suave}!important}
table.x-btn-noicon:is(.extNewWindow,.cascade,.closeAll,.minimizeAll,.save,.delete,.new).x-btn-over button.x-btn-text{color:${c(P.texto)}!important}
table.x-btn-noicon.x-item-disabled button.x-btn-text{opacity:.45}
.x-menu-check-item img.x-menu-item-icon{background-image:none!important;background-color:${c(P.apagado)};${mascara('caixa', '13px')}}
.x-menu-group-item img.x-menu-item-icon{background-color:transparent}
.x-menu-item-checked .x-menu-check-item img.x-menu-item-icon{background-color:${c(P.azul)};${mascara('caixaCheck', '13px')}}
.x-menu-item-checked .x-menu-group-item img.x-menu-item-icon{background-color:${c(P.azul)};${mascara('ponto', '14px')}}
/* grades ExtJS do GXflow (página inicial: Caixa Saída, Meus Processos): moldura de sprites vira cartão */
.x-grid-panel{border:1px solid ${c(P.borda)};border-radius:10px;overflow:hidden;background:${c(P.superficie)}}
.x-grid-panel .x-panel-tl,.x-grid-panel .x-panel-tr,.x-grid-panel .x-panel-tc,.x-grid-panel .x-panel-ml,.x-grid-panel .x-panel-mr,.x-grid-panel .x-panel-mc,
.x-grid-panel .x-panel-bl,.x-grid-panel .x-panel-br,.x-grid-panel .x-panel-bc{background:transparent!important;background-image:none!important;padding-left:0!important;padding-right:0!important;border:0!important}
.x-grid-panel .x-panel-bl,.x-grid-panel .x-panel-bc{height:0!important;padding:0!important}
.x-grid-panel .x-panel-mc{padding-top:0!important}
.x-grid-panel .x-panel-header{background:${c(P.superficie)}!important;background-image:none!important;border:0!important;border-bottom:1px solid ${c(P.borda)}!important;padding:9px 14px!important}
.x-grid-panel .x-panel-header-text{font:600 13px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important;color:${c(P.texto)}!important;letter-spacing:.2px}
.x-grid-panel .x-toolbar{background:${c(P.superficie)}!important;background-image:none!important;border:0!important;padding:5px 8px!important}
.x-grid-panel .x-panel-tbar .x-toolbar{border-bottom:1px solid ${c(P.borda)}!important}
.x-grid-panel .x-panel-bbar .x-toolbar{border-top:1px solid ${c(P.borda)}!important}
.x-grid-panel .x-form-text{background:${c(P.fundo)}!important;background-image:none!important;border:1px solid ${c(P.borda)}!important;border-radius:5px;color:${c(P.texto)}!important;padding:2px 6px!important;height:22px!important;box-sizing:border-box}
.x-grid-panel .x-form-field-wrap{overflow:visible!important;height:22px!important}
.x-grid-panel .x-form-twin-triggers img,.x-grid-panel .x-form-field-wrap>img{height:22px!important;top:0!important}
img.x-form-trigger{background-image:none!important;background-color:${suave}!important;border:0!important;cursor:pointer}
img.x-form-search-trigger{${mascara('busca', '14px')}}
img.x-form-clear-trigger{${mascara('fechar', '12px')}}
img.x-form-trigger:hover{background-color:${c(P.texto)}!important}
.x-grid3-header{background:${c(P.elevado)}!important;background-image:none!important;border-bottom:1px solid ${c(P.borda)}}
.x-grid3-hd-row td,.x-grid3-hd-row td.x-grid3-hd{background:transparent!important;background-image:none!important;border-left-color:transparent!important;border-right-color:${c(P.borda)}!important}
.x-grid3-hd-inner:has(.dt-img){padding-left:0!important;padding-right:0!important;text-align:center}
.x-grid3-hd-inner{background:transparent!important;background-image:none!important;padding:7px 10px!important;color:${suave}!important;font:600 11.5px "Segoe UI",system-ui,-apple-system,Roboto,Tahoma,sans-serif!important}
.x-grid3-hd-over .x-grid3-hd-inner{background:${x('elevado', 'azul', .15)}!important;color:${c(P.texto)}!important}
.sort-asc .x-grid3-hd-inner,.sort-desc .x-grid3-hd-inner{color:${c(P.texto)}!important}
.sort-asc img.x-grid3-sort-icon,.sort-desc img.x-grid3-sort-icon{background-image:none!important;background-color:${c(P.azul)}!important;width:10px;height:10px;margin-left:4px;vertical-align:middle;${mascara('baixo', '10px')}}
.sort-asc img.x-grid3-sort-icon{transform:rotate(180deg)}
.x-grid3-hd-btn{background-color:${c(P.borda)}!important;background-image:none!important}
.x-grid3-scroller,.x-grid3-body{background:${c(P.fundo)}}
.x-grid3-row{background:${c(P.fundo)}!important;border:0!important;border-bottom:1px solid ${x('borda', 'fundo', .45)}!important}
.x-grid3-row-alt{background:${x('fundo', 'superficie', .55)}!important}
.x-grid3-row-over{background:${c(P.elevado)}!important;background-image:none!important}
.x-grid3-row-selected{background:${x('fundo', 'azul', .22)}!important;background-image:none!important}
.x-grid3-row td.x-grid3-cell:not(:last-child){box-shadow:inset -1px 0 0 ${x('borda', 'fundo', .45)}}
.x-grid3-cell-inner{padding:6px 10px!important;color:${c(P.texto)};font-size:12px!important}
.x-grid-empty{color:${suave}!important;padding:14px!important}
.ytb-sep{background-image:none!important;width:1px!important;height:16px;background:${c(P.borda)}!important;margin:0 5px!important}
.ytb-text,.x-paging-info{color:${suave}!important}
.x-tbar-page-number{background:${c(P.fundo)}!important;background-image:none!important;border:1px solid ${c(P.borda)}!important;border-radius:4px;color:${c(P.texto)}!important;text-align:center}
.x-grid-panel .x-item-disabled{opacity:.35}
/* menu do usuário (topo direito): Logout e Altera Senha usam a mesma classe no site */
img.x-menu-item-icon.W5Portal_Icon_Logout{background-image:none!important;background-color:${suave}!important;${mascara('sair', '14px')}}
li:has(.W5Portal_Icon_Logout) + li img.x-menu-item-icon.W5Portal_Icon_Logout{${mascara('chaveAcesso', '14px')}}
.x-menu-item-active img.x-menu-item-icon.W5Portal_Icon_Logout{background-color:${c(P.texto)}!important}
.x-grid3-check-col,.x-grid3-check-col-on{background-image:none!important;background-color:${c(P.apagado)};${mascara('caixa', '13px')}}
.x-grid3-check-col-on{background-color:${c(P.azul)};${mascara('caixaCheck', '13px')}}
`;
        return s;
    }

    function garantirEstilo(id, css, inicio) {
        let el = doc.getElementById(id);
        if (!el) {
            el = doc.createElement('style');
            el.id = id;
            el.setAttribute('data-dealer-tema', '');
        }
        el.textContent = css;
        const pai = doc.head || doc.documentElement;
        if (inicio) { if (pai.firstChild !== el) pai.insertBefore(el, pai.firstChild); }
        else if (el.parentNode !== pai || el !== pai.lastElementChild) pai.appendChild(el);
    }

    // ---- carregador das fontes da web: um só, na janela principal, para todas as telas ----
    // Baixa o CSS do provedor (Bunny Fonts; se falhar, Google Fonts), pega só os arquivos dos subconjuntos
    // latin/latin-ext e guarda os .woff2 no Cache Storage. O CSS é conferido de novo a cada 7 dias: se o
    // provedor trocou os arquivos (URL nova), baixa os novos e apaga os velhos; senão usa o que está guardado.
    // Sem internet, usa o que estiver guardado mesmo que velho.
    function criarCarregadorFontes() {
        let w = window;
        try { if (window.top.document) w = window.top; } catch (e) { /* outra origem */ }
        if (w.__dealerTemaFontes) return w.__dealerTemaFontes;
        const NOME_CACHE = 'dealer-tema-fontes', CHAVE_META = 'DealerTema.fontes', REVALIDAR = 7 * 864e5;
        const emCurso = new Map();
        const lerMeta = () => { try { return JSON.parse(w.localStorage.getItem(CHAVE_META) || '{}') || {}; } catch (e) { return {}; } };
        const gravarMeta = m => { try { w.localStorage.setItem(CHAVE_META, JSON.stringify(m)); } catch (e) { /* cheio */ } };
        const abrirCache = async () => { try { return w.caches ? await w.caches.open(NOME_CACHE) : null; } catch (e) { return null; } };
        function lerCssFontes(css) {
            const arquivos = [];
            const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/gi;
            let m;
            while ((m = re.exec(css))) {
                if (m[1] !== 'latin' && m[1] !== 'latin-ext') continue;
                const b = m[2];
                const url = (/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/i.exec(b) || [])[1];
                if (!url) continue;
                arquivos.push({
                    url,
                    estilo: ((/font-style\s*:\s*([^;]+)/i.exec(b) || [])[1] || 'normal').trim(),
                    peso: ((/font-weight\s*:\s*([^;]+)/i.exec(b) || [])[1] || '400').trim(),
                    faixa: ((/unicode-range\s*:\s*([^;]+)/i.exec(b) || [])[1] || '').trim(),
                });
            }
            return arquivos;
        }
        async function listarArquivos(f) {
            const urls = [`https://fonts.bunny.net/css?family=${f.bunny}&display=swap`, `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`];
            let ultimoErro = null;
            for (const u of urls) {
                try {
                    const r = await w.fetch(u, { cache: 'no-cache', credentials: 'omit' });
                    if (!r.ok) throw new Error(u + ' ' + r.status);
                    const lista = lerCssFontes(await r.text());
                    if (lista.length) return lista;
                    throw new Error(u + ': nenhum arquivo');
                } catch (e) { ultimoErro = e; }
            }
            throw ultimoErro;
        }
        async function doCache(cache, lista) {
            if (!cache || !lista) return null;
            const out = [];
            for (const a of lista) {
                const r = await cache.match(a.url);
                if (!r) return null;
                out.push(Object.assign({}, a, { dados: await r.arrayBuffer() }));
            }
            return out;
        }
        async function baixar(id) {
            const f = FONTES[id];
            const cache = await abrirCache();
            const meta = lerMeta();
            const m = meta[id];
            if (m && Date.now() - m.quando < REVALIDAR) {
                const r = await doCache(cache, m.arquivos);
                if (r) return r;
            }
            try {
                const lista = await listarArquivos(f);
                const out = [];
                for (const a of lista) {
                    let resp = cache ? await cache.match(a.url) : null;
                    if (!resp) {
                        const rede = await w.fetch(a.url, { mode: 'cors', credentials: 'omit' });
                        if (!rede.ok) throw new Error(a.url + ' ' + rede.status);
                        if (cache) { try { await cache.put(a.url, rede.clone()); } catch (e) { /* cota */ } }
                        resp = rede;
                    }
                    out.push(Object.assign({}, a, { dados: await resp.arrayBuffer() }));
                }
                const nova = lerMeta();
                nova[id] = { quando: Date.now(), arquivos: lista };
                gravarMeta(nova);
                if (cache) {                                       // apaga arquivos que nenhuma fonte usa mais
                    const usados = new Set();
                    Object.values(nova).forEach(x => (x.arquivos || []).forEach(a => usados.add(a.url)));
                    for (const req of await cache.keys()) if (!usados.has(req.url)) cache.delete(req);
                }
                return out;
            } catch (e) {
                const r = await doCache(cache, m && m.arquivos);      // sem rede: o que estiver guardado
                if (r) return r;
                throw e;
            }
        }
        const api = {
            obter(id) {
                if (!FONTES[id] || FONTES[id].tipo !== 'web') return Promise.reject(new Error('fonte desconhecida: ' + id));
                if (!emCurso.has(id)) emCurso.set(id, baixar(id).catch(e => { emCurso.delete(id); throw e; }));
                return emCurso.get(id);
            },
            // apaga os arquivos guardados (a próxima vez baixa de novo)
            async limpar() { try { if (w.caches) await w.caches.delete(NOME_CACHE); } catch (e) { /* nada */ } try { w.localStorage.removeItem(CHAVE_META); } catch (e) { /* nada */ } emCurso.clear(); },
        };
        w.__dealerTemaFontes = api;
        return api;
    }
    // fonte instalada no computador? compara a largura de um texto com a fonte e sem ela
    function fonteInstalada(nome) {
        try {
            const cx = doc.createElement('canvas').getContext('2d');
            const t = 'mmmmmmmmmmlli1WQ@#ãçÉ';
            return ['monospace', 'serif', 'sans-serif'].some(b => {
                cx.font = `72px ${b}`; const w0 = cx.measureText(t).width;
                cx.font = `72px "${nome}",${b}`; return cx.measureText(t).width !== w0;
            });
        } catch (e) { return true; }
    }

    // ---- fonte escolhida (independe do tema de cores) ----
    let escala = 1;                    // tamanho das fontes: 1 = original
    function motorAtivo() { return !!trad || escala !== 1; }
    const fontesRegistradas = new Set();
    function cssFonte(id) {
        const pilha = pilhaFonte(id);
        let css = '';
        if (escala !== 1) css += `html{font-size:${arred(16 * escala)}px}\n`;   // base do rem e de quem não define tamanho
        if (pilha) {
            // tudo, menos fontes de ícone (Font Awesome etc.) e texto monoespaçado
            const fora = ':not(.fa):not([class^="fa-"]):not([class*=" fa-"]):not([class^="icon-"]):not([class*=" icon-"]):not([class*="glyphicon"])'
                + ':not(code):not(pre):not(kbd):not(samp):not(tt):not(.cke_editable):not(.cke_editable *)';
            css += `html,body,html *${fora}{font-family:${pilha}!important}\n`;
        }
        return css;
    }
    function aplicarFonte(c, esc) {
        const antes = escala; escala = esc;
        const css = cssFonte(c.fonte);
        escala = antes;
        const el = doc.getElementById(PREFIXO + '-fonte');
        if (!css) { if (el) el.remove(); return; }
        garantirEstilo(PREFIXO + '-fonte', css, false);
        const f = FONTES[c.fonte];
        if (f && f.tipo === 'web' && !fontesRegistradas.has(c.fonte)) {
            fontesRegistradas.add(c.fonte);
            let carregador = null;
            try { carregador = window.top.__dealerTemaFontes; } catch (e) { /* outra origem */ }
            if (!carregador) carregador = criarCarregadorFontes();
            carregador.obter(c.fonte).then(arquivos => {
                const FF = doc.defaultView && doc.defaultView.FontFace;
                if (!FF || !doc.fonts) return;
                for (const a of arquivos) {
                    try {
                        const face = new FF(familiaWeb(c.fonte), a.dados, { style: a.estilo, weight: a.peso, unicodeRange: a.faixa || 'U+0-10FFFF', display: 'swap' });
                        doc.fonts.add(face);
                        face.load().catch(() => {});
                    } catch (e) { /* arquivo ruim: fica a próxima fonte da pilha */ }
                }
            }).catch(e => { fontesRegistradas.delete(c.fonte); console.warn('[Dealer/Tema] fonte', c.fonte, e); });
        }
    }

    function aplicar() {
        if (!doc.documentElement) {                    // document-start muito cedo: espera o <html>
            new MutationObserver((m, o) => { if (doc.documentElement) { o.disconnect(); aplicar(); } }).observe(doc, { childList: true });
            return;
        }
        const c = lerConfig();
        const id = esquemaAtivo(c);
        const novo = id ? criarTradutor(ESQUEMAS[id]) : null;
        const novasImagens = c.imagens !== false;
        depurar = !!c.debug;
        if (!depurar) esconderOriginal();
        const novosOcultos = DEALER_TEMA_MOSTRAR_BOTOES_OCULTOS || !!c.ocultos;
        if (novosOcultos !== mostrarOcultos) {          // só ressincroniza os botões já trocados
            mostrarOcultos = novosOcultos;
            doc.querySelectorAll('[data-dt-oculto]').forEach(el => { const px = proxyDe.get(el); if (px) sincronizarProxy(el, px); });
        }
        const novaEscala = (c.tamanho || 100) / 100;
        aplicarFonte(c, novaEscala);
        const mesmasCores = trad ? !!novo && trad.esquema === novo.esquema : !novo;
        if (mesmasCores && trocarImagens === novasImagens && escala === novaEscala) return;
        // desfaz o anterior
        if (motorAtivo()) {
            if (observador) observador.disconnect();
            copias.forEach(cp => cp.remove());
            copias.clear();
            doc.querySelectorAll('[style],[bgcolor],font[color],font[size]').forEach(restaurarInline);
            removerProxies();
        }
        trad = novo;
        trocarImagens = novasImagens;
        escala = novaEscala;
        if (!trad) {
            ['-base', '-ajustes'].forEach(s => { const el = doc.getElementById(PREFIXO + s); if (el) el.remove(); });
            doc.documentElement.removeAttribute('data-dealer-tema-esquema');
        } else {
            doc.documentElement.setAttribute('data-dealer-tema-esquema', id);
            garantirEstilo(PREFIXO + '-base', cssBase(trad.esquema, trad.P), true);
        }
        aplicarFonte(c, escala);
        if (motorAtivo() && doc.readyState !== 'loading') ligar();
    }

    function ligar() {
        if (!motorAtivo()) return;
        processandoInline = true;
        const t0 = performance.now();
        try {
            processarTodasFolhas();
            varrerInline(doc.documentElement);
            varrerImagens(doc.documentElement);
        } finally { processandoInline = false; }
        tempoLigar = performance.now() - t0;
        if (trad) {
            garantirEstilo(PREFIXO + '-base', cssBase(trad.esquema, trad.P), true);
            garantirEstilo(PREFIXO + '-ajustes', escalarCss(cssAjustes(trad.esquema, trad.P)), false);
        }
        aplicarFonte(lerConfig(), escala);
        if (!observador) observador = new MutationObserver(aoMudarDom);
        observador.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'bgcolor', 'color', 'src', 'disabled', 'title', 'class', 'hidden'] });
    }

    // <link> carregou: traduz a folha
    doc.addEventListener('load', ev => {
        const t = ev.target;
        if (motorAtivo() && t && t.tagName === 'LINK') processarFolha(t);
    }, true);
    doc.addEventListener('DOMContentLoaded', () => { ligar(); });
    window.addEventListener('load', () => {
        if (!motorAtivo()) return;
        processarTodasFolhas();
        if (trad) garantirEstilo(PREFIXO + '-ajustes', escalarCss(cssAjustes(trad.esquema, trad.P)), false);
    });
    window.addEventListener('storage', ev => { if (ev.key === CHAVE) aplicar(); });
    if (midiaEscura) {
        const f = () => { if (lerConfig().tema === 'auto') aplicar(); };
        midiaEscura.addEventListener ? midiaEscura.addEventListener('change', f) : midiaEscura.addListener(f);
    }

    aplicar();

    // ------------------------------------------------------------------------------------------------
    // API para quem embute o motor (Dealer/Fluxo): window.DealerTema, só na janela principal.
    // O Dealer/Tema não desenha nenhuma interface própria; o Dealer/Fluxo mostra as opções na
    // engrenagem dele usando esta API. Detalhes em INTEGRACAO-DEALER-FLUXO.md.
    // ------------------------------------------------------------------------------------------------
    function avisarFrames(w) {
        for (let i = 0; i < w.frames.length; i++) {
            try { const f = w.frames[i]; if (f.__dealerTema) f.__dealerTema.aplicar(); avisarFrames(f); } catch (e) { /* outra origem */ }
        }
    }
    // cada documento (top e iframes) registra o seu "aplicar" para ser avisado na hora
    window.__dealerTema = { aplicar, versao: VERSAO, debug: () => ({ trad: !!trad, ms: Math.round(tempoLigar) }) };

    if (window.top === window) {
        const ouvintes = new Set();
        // a lista só tem imagens ainda sem ícone nesta versão: podada ao carregar e filtrada a cada leitura
        const lerSemIcone = () => {
            let l; try { l = JSON.parse(localStorage.getItem(CHAVE_SEM_ICONE) || '{}') || {}; } catch (e) { return {}; }
            if (podarSemIcone(l)) try { localStorage.setItem(CHAVE_SEM_ICONE, JSON.stringify(l)); } catch (e) { /* sem storage */ }
            return l;
        };
        lerSemIcone();
        const avisarOuvintes = () => { const c = lerConfig(); ouvintes.forEach(fn => { try { fn(c); } catch (e) { console.warn('[Dealer/Tema] ouvinte', e); } }); };
        window.addEventListener('storage', ev => { if (ev.key === CHAVE) avisarOuvintes(); });
        window.DealerTema = Object.freeze({
            versao: VERSAO,
            // [{ id, nome, escuro }] na ordem para mostrar (escuros, depois claros)
            esquemas: () => Object.keys(ESQUEMAS).map(id => ({ id, nome: ESQUEMAS[id].nome, escuro: !!ESQUEMAS[id].escuro })),
            // { tema: 'off' | 'auto' | id, claro: id, escuro: id, imagens: bool, debug: bool, ocultos: bool,
            //   fonte: 'original' | id de fontes(), tamanho: % do original (80–150) }
            config: () => Object.assign({}, lerConfig()),
            // fontes para a lista: [{ id, nome, tipo: 'original'|'sistema'|'web' }]. As do sistema só aparecem
            // se estiverem instaladas; as da web são baixadas na primeira vez e ficam guardadas no navegador.
            fontes: () => [{ id: 'original', nome: 'Original do site', tipo: 'original' }].concat(
                Object.keys(FONTES).filter(id => FONTES[id].tipo !== 'sistema' || !FONTES[id].local || fonteInstalada(FONTES[id].local))
                    .map(id => ({ id, nome: FONTES[id].nome, tipo: FONTES[id].tipo }))),
            // tamanho das fontes em % do original (o site usa vários tamanhos; todos mudam na mesma proporção)
            tamanhos: () => ({ min: TAMANHO_MIN, max: TAMANHO_MAX, sugeridos: [90, 100, 110, 120, 130] }),
            // apaga as fontes baixadas guardadas no navegador
            limparFontes: () => criarCarregadorFontes().limpar(),
            // id do esquema em uso agora (resolve 'auto'), ou null se o tema está desligado
            esquemaAtivo: () => esquemaAtivo(lerConfig()),
            // grava e aplica em todas as janelas/iframes. Escolher um esquema em `tema` também o guarda
            // como o claro/escuro preferido do modo automático.
            definir: (parcial) => {
                const c = Object.assign(lerConfig(), parcial || {});
                if (ESQUEMAS[c.tema]) { if (ESQUEMAS[c.tema].escuro) c.escuro = c.tema; else c.claro = c.tema; }
                if (!ESQUEMAS[c.claro] || ESQUEMAS[c.claro].escuro) c.claro = PADRAO.claro;
                if (!ESQUEMAS[c.escuro] || !ESQUEMAS[c.escuro].escuro) c.escuro = PADRAO.escuro;
                if (c.tema !== 'off' && c.tema !== 'auto' && !ESQUEMAS[c.tema]) c.tema = 'off';
                salvarConfig(c);
                const final = lerConfig();                      // fonte/tamanho já corrigidos
                salvarConfig(final);
                aplicar();
                avisarFrames(window);
                avisarOuvintes();
                return Object.assign({}, final);
            },
            // chamado com a config nova sempre que ela muda (aqui ou em outra aba); devolve "desinscrever"
            aoMudar: (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); },
            // imagens vistas sem ícone: [{ arquivo, dica, tela, situacao }] (para o usuário copiar e mandar)
            semIcone: () => { const l = lerSemIcone(); return Object.keys(l).sort().map(k => ({ arquivo: l[k][0], dica: l[k][1], tela: l[k][2], situacao: l[k][3] })); },
            semIconeTexto: () => { const l = lerSemIcone(); return Object.keys(l).sort().map(k => l[k].join(' | ')).join('\n'); },
            // true se a imagem (src ou nome do arquivo, ex. 'btnFoo.png') ainda não tem ícone próprio nesta versão
            aindaSemIcone: nome => aindaSemIcone(nome),
            limparSemIcone: () => { try { localStorage.removeItem(CHAVE_SEM_ICONE); } catch (e) { /* sem storage */ } },
        });
    }

    // ------------------------------------------------------------------------------------------------
    // Iframes: cada tela do portal é um iframe da mesma origem. O gerenciador de userscripts (ou a
    // extensão) normalmente roda o script nelas também, mas nem sempre: a janela de um iframe novo
    // (about:blank) é reaproveitada quando ele navega e alguns ambientes não rodam o script de novo.
    // Por isso cada documento também instala o motor nos iframes filhos que ficaram sem ele, assim
    // que o documento novo aparece (antes do "load", para não piscar branco).
    // ------------------------------------------------------------------------------------------------
    function cuidarDosIframes() {
        const lista = doc.getElementsByTagName('iframe');
        for (let i = 0; i < lista.length; i++) {
            let w, d;
            try { w = lista[i].contentWindow; d = w && w.document; } catch (e) { continue; }   // outra origem
            if (!d || d.__dealerTema || !d.documentElement) continue;
            let proto;
            try { proto = w.location.protocol; } catch (e) { continue; }
            if (proto === 'about:') continue;
            try { dealerTema(w, d); } catch (e) { console.warn('[Dealer/Tema] iframe', e); }
        }
    }
    const vigia = window.setInterval(() => {
        if (!doc.defaultView || doc.defaultView.document !== doc) { window.clearInterval(vigia); return; }
        cuidarDosIframes();
    }, 100);
    doc.addEventListener('load', ev => { if (ev.target && ev.target.tagName === 'IFRAME') cuidarDosIframes(); }, true);
}
dealerTema(window, document);
})();
// ==== fim do Dealer/Tema ====

(function() {
    'use strict';

    // A tela de login só recebe o tema (trecho acima); o Dealer/Fluxo é só do portal
    if (!/\/Portal\/default\.html/i.test(location.pathname)) return;

    // Evita rodar duas vezes (ex.: userscript e extensão instalados ao mesmo tempo)
    if (window.__dealerFluxoCarregado) {
        console.warn('[Dealer/Fluxo] Já está carregado nesta página (duas cópias instaladas?). Desative uma delas.');
        return;
    }
    window.__dealerFluxoCarregado = true;

    const NOME_EXIBICAO = 'Dealer/Fluxo';
    const VERSAO_FLUXO = '1.3.0';                // igual ao @version do cabeçalho (o build confere)
    const CONTATO = 'igor.lima@grupogr7.com.br';
    const NOME_SCRIPT = 'Dealer/Fluxo';
    const CHAVE_CONFIG = 'DealerBarraDeTarefas.config';
    const CHAVE_FLUXOS_VISTOS = 'DealerBarraDeTarefas.fluxosVistos';
    const ID_JANELA = /^W5Window_\d+$/;       // Janelas criadas pelo portal
    const MAX_FECHADAS = 10;                  // Quantas janelas fechadas lembrar para reabrir
    const ATRASO_INDICADOR = 400;             // ms até mostrar o indicador (evita piscar em requisições rápidas)
    const INTERVALO_LEITURA_FLUXOS = 5000;    // ms entre leituras da tela inicial

    // ---------------------------------------------------------------------------------------------
    // Configurações (salvas no localStorage do navegador)
    // ---------------------------------------------------------------------------------------------

    const PADRAO = {
        alturaBarra: 32,
        larguraMaxBotao: 200,
        botaoFormato: 'reto',                  // aparência dos botões da barra (chaves de FORMATOS_BOTAO etc.)
        botaoEstilo: 'solido',
        botaoAtivo: 'cor',
        botaoPassarMouse: 'nenhum',
        botaoAbertura: 'nenhum',
        cliqueAtivaMinimiza: false,
        botaoMeioFecha: true,
        indicadorCarregamento: true,
        avisarConclusao: true,
        avisarAposSegundos: 2,
        botaoInicio: true,
        avisosTela: true,                      // destaca as mensagens em vermelho do GeneXus no topo das telas
        avisosTelaSegundos: 3,                 // ... por quanto tempo no meio da tela antes de virar o botão "Aviso"
        buscaListas: true,                     // nossa lista com busca (barra, botão e Alt+F); false = a do navegador
        buscaListasMinimo: 5,                  // ... só nas listas com mais opções que isso
        buscaMenuPosicao: 'barra',             // onde fica o botão da busca no menu (chaves de POSICOES_BUSCA_MENU); o atalho sempre funciona
        documentosOSJanelas: true,             // impressão da OS: documentos marcados em janelas em vez de baixar
        sufixoCopia: ' (Cópia)',
        tutoriaisOcultos: {},
        temaAlfaAceito: false,                 // aceitou o aviso de versão alfa do tema (libera o menu Tema da engrenagem)
        temaDepuracaoAceita: false,            // aceitou o aviso das opções de depuração do tema
        temaFonteAceita: false,                // aceitou o aviso de fonte/tamanho (libera o menu Fonte da engrenagem)
        telemetria: true,                      // estatísticas de uso anônimas (uma vez por dia; aba Privacidade)
        telemetriaSemIcone: false,             // opt-in: enviar as imagens sem ícone do tema (aba Tema)
        atalhos: {
            proxima: 'Alt+KeyE',
            anterior: 'Alt+KeyQ',
            numero: 'Alt+Shift',              // + 1..9
            minimizar: 'Alt+KeyS',
            inicio: 'Alt+KeyH',
            reabrir: 'Alt+Shift+KeyT',
            duplicar: 'Alt+Shift+KeyD',
            fechar: 'Alt+Shift+KeyW',
            configuracoes: 'Alt+Shift+KeyC',
            buscaLista: 'Alt+KeyF',           // só com uma lista de opções selecionada
            buscaMenu: 'Alt+KeyM'
        },
        fluxos: {
            ativo: false,                      // desligado nas instalações novas (as antigas ficam como estavam: carregarConfig)
            intervaloAtualizacao: 60,          // segundos entre atualizações da tela inicial
            tempoNotificacao: 8,               // segundos que o aviso fica na tela
            pausarAoPassarMouse: true,
            linksAviso: true,                  // clicar num fluxo do aviso abre o fluxo (desligado: clicar em qualquer lugar só fecha)
            notificarAoAbrir: true,            // avisa os fluxos pendentes ao abrir o portal
            notificacaoSistema: false,         // notificação do Windows/sistema com o navegador em segundo plano
            som: false,                        // toca um som quando chegam fluxos novos
            somTipo: 'duplo',                  // chave de SONS_FLUXO
            volume: 100,                       // % (0 a 200)
            notificarDesconhecidos: true,      // fluxos que não estão na lista (ex.: novos no DealerNet)
            desativados: [],                   // códigos (em minúsculas) dos fluxos desmarcados
            personalizados: []                 // códigos ou nomes adicionados pelo usuário
        }
    };

    // Onde fica o botão (lupa) da busca no menu. O atalho (Alt+M) funciona em todas, inclusive "escondido".
    const POSICOES_BUSCA_MENU = {
        barra: 'Na barra de status; com janelas abertas, no começo da barra de tarefas (botão Iniciar)',
        status: 'Sempre na barra de status',
        alto: 'No alto, à esquerda (no lugar do logotipo)',
        oculto: 'Escondido (só o atalho)'
    };

    const DESCRICAO_ATALHOS = {
        proxima: 'Ir para a janela da direita',
        anterior: 'Ir para a janela da esquerda',
        numero: 'Ir para a janela 1 a 9 (+ número)',
        minimizar: 'Minimizar a janela ativa',
        inicio: 'Voltar a janela ativa para a página inicial',
        reabrir: 'Reabrir a última janela fechada',
        duplicar: 'Duplicar a janela ativa',
        fechar: 'Fechar a janela ativa',
        configuracoes: 'Abrir as configurações',
        buscaLista: 'Buscar na lista de opções selecionada',
        buscaMenu: 'Buscar uma tela no menu'
    };

    let config = carregarConfig();

    // Cria um elemento sem innerHTML (o texto entra sempre como texto, nunca como HTML):
    // elemento(document, 'span', { className: 'x', title: '...', dataset: { chave: 'y' } }, 'texto', outroElemento)
    function elemento(doc, tag, props = {}, ...filhos) {
        const el = doc.createElement(tag);
        for (const [chave, valor] of Object.entries(props)) {
            if (chave === 'dataset') Object.assign(el.dataset, valor);
            else if (chave in el) el[chave] = valor;
            else el.setAttribute(chave, valor);
        }
        filhos.flat().forEach(f => { if (f !== null && f !== undefined && f !== false) el.append(f); });
        return el;
    }

    function copiar(objeto) {
        return JSON.parse(JSON.stringify(objeto));
    }

    function carregarConfig() {
        let salvo = {};
        try {
            salvo = JSON.parse(localStorage.getItem(CHAVE_CONFIG)) || {};
        } catch (e) {
            salvo = {};
        }
        const padrao = copiar(PADRAO);
        // Até a 1.1.0 a notificação de fluxos vinha ligada. Quem já usava (tem configuração salva) e nunca mexeu
        // nela continua com ela ligada; só as instalações novas começam com ela desligada.
        if (Object.keys(salvo).length && !(salvo.fluxos && 'ativo' in salvo.fluxos)) {
            salvo.fluxos = { ...(salvo.fluxos || {}), ativo: true };
        }
        return {
            ...padrao,
            ...salvo,
            atalhos: { ...padrao.atalhos, ...(salvo.atalhos || {}) },
            fluxos: { ...padrao.fluxos, ...(salvo.fluxos || {}) },
            tutoriaisOcultos: { ...(salvo.tutoriaisOcultos || {}) }
        };
    }

    function salvarConfig(novo) {
        config = novo;
        try {
            localStorage.setItem(CHAVE_CONFIG, JSON.stringify(novo));
        } catch (e) {
            console.error(`[${NOME_SCRIPT}] Não foi possível salvar as configurações`, e);
        }
        aplicarConfig();
    }

    // ---------------------------------------------------------------------------------------------
    // Estado
    // ---------------------------------------------------------------------------------------------

    // id da janela -> { janela, botao, inicioCarga, timerIndicador, timerVerificacao }
    const registro = new Map();
    const fechadas = [];                      // Pilha das últimas janelas fechadas (para reabrir)

    let containerBotoes = null;
    let alturaOriginalStatusbar = null;
    let barraVisivel = false;
    let menuContexto = null;
    let elementoEstilo = null;
    let janelaConfig = null;
    let temaAtual = null;

    // ---------------------------------------------------------------------------------------------
    // Tema, ícones e estilos
    // ---------------------------------------------------------------------------------------------

    const TEMAS = {
        /*Variações de cores de acordo com o tema que a concessionária usa*/
        'blue':   { corPadrao: '#E1E9F2', corTexto: '#15428B', corAtivo: '#7DA2CE', corTextoAtivo: '#FFFFFF' },
        'gray':   { corPadrao: '#F0F0F0', corTexto: '#333333', corAtivo: '#707070', corTextoAtivo: '#FFFFFF' },
        'green':  { corPadrao: '#E4F3E1', corTexto: '#275C1E', corAtivo: '#7AB269', corTextoAtivo: '#FFFFFF' },
        'orange': { corPadrao: '#FFF1E8', corTexto: '#873202', corAtivo: '#F1A161', corTextoAtivo: '#FFFFFF' },
        'purple': { corPadrao: '#F0E8F4', corTexto: '#4A1B6B', corAtivo: '#9B6DB6', corTextoAtivo: '#FFFFFF' },
        'volks':  { corPadrao: '#E8EEF7', corTexto: '#00195C', corAtivo: '#001E85', corTextoAtivo: '#FFFFFF' }
    };

    // Aparência dos botões da barra: cada escolha vira uma classe no #barraDeTarefas (dbtf-<formato>,
    // dbte-<estilo>, dbta-<ativo>, dbth-<passar o mouse>, dbtn-<abertura>), e o CSS de todas as combinações fica
    // em estilosBotoesBarra(). A prévia da aba Barra usa as mesmas classes e regras.
    const FORMATOS_BOTAO = {
        reto: 'Reto', arredondado: 'Cantos arredondados', pilula: 'Pílula', folha: 'Folha', aba: 'Aba pendurada',
        chanfrado: 'Cantos chanfrados', seta: 'Seta', divisa: 'Setas encaixadas', pontas: 'Pontas dos dois lados',
        etiqueta: 'Etiqueta', inclinado: 'Inclinado', circulo: 'Círculo (só as iniciais)'
    };
    const ESTILOS_BOTAO = {
        solido: 'Sólido', gradiente: 'Gradiente', brilhante: 'Brilhante', relevo: 'Relevo (3D)', vidro: 'Vidro fosco',
        sombra: 'Com sombra', contorno: 'Só o contorno', plano: 'Plano (sem borda)'
    };
    const ATIVOS_BOTAO = {
        cor: 'Cor de destaque', linha: 'Cor e linha embaixo', sublinhado: 'Só uma linha embaixo', invertido: 'Cores invertidas',
        aceso: 'Aceso (neon)', pulsar: 'Pulsando', levantado: 'Levantado'
    };
    const PASSAR_MOUSE_BOTAO = {
        nenhum: 'Nenhum', clarear: 'Clarear', escurecer: 'Escurecer', levantar: 'Levantar', crescer: 'Crescer',
        reflexo: 'Reflexo passando', sublinhar: 'Sublinhar', balancar: 'Balançar'
    };
    const ABERTURAS_BOTAO = {
        nenhum: 'Nenhum', aparecer: 'Aparecer aos poucos', subir: 'Subir', saltar: 'Saltar', deslizar: 'Deslizar da esquerda'
    };
    // Combinações prontas: [nome, formato, estilo, ativo, passar o mouse, abertura]
    const PREDEFINICOES_BOTAO = {
        classico:    ['Clássico (o original)', 'reto', 'solido', 'cor', 'nenhum', 'nenhum'],
        moderno:     ['Moderno', 'arredondado', 'gradiente', 'cor', 'levantar', 'subir'],
        abas:        ['Abas', 'aba', 'relevo', 'linha', 'clarear', 'deslizar'],
        setas:       ['Setas', 'divisa', 'brilhante', 'cor', 'reflexo', 'deslizar'],
        neon:        ['Neon', 'pilula', 'contorno', 'aceso', 'crescer', 'aparecer'],
        vidro:       ['Vidro', 'arredondado', 'vidro', 'levantado', 'levantar', 'aparecer'],
        etiquetas:   ['Etiquetas', 'etiqueta', 'sombra', 'invertido', 'balancar', 'saltar'],
        minimalista: ['Minimalista', 'reto', 'plano', 'sublinhado', 'sublinhar', 'aparecer'],
        folhas:      ['Folhas', 'folha', 'gradiente', 'pulsar', 'reflexo', 'saltar'],
        bolinhas:    ['Bolinhas', 'circulo', 'brilhante', 'aceso', 'crescer', 'saltar'],
        retro:       ['Retrô', 'chanfrado', 'relevo', 'invertido', 'escurecer', 'nenhum']
    };
    const CAMPOS_APARENCIA = [
        ['botaoFormato', 'dbtf', FORMATOS_BOTAO], ['botaoEstilo', 'dbte', ESTILOS_BOTAO], ['botaoAtivo', 'dbta', ATIVOS_BOTAO],
        ['botaoPassarMouse', 'dbth', PASSAR_MOUSE_BOTAO], ['botaoAbertura', 'dbtn', ABERTURAS_BOTAO]
    ];

    // Troca as classes de aparência de um container (a barra ou a prévia) pelas da escolha (um config ou parecido)
    function aplicarAparenciaBotoes(container, escolha) {
        if (!container) return;
        CAMPOS_APARENCIA.forEach(([nome, prefixo, opcoes]) => {
            [...container.classList].filter(c => c.startsWith(prefixo + '-')).forEach(c => container.classList.remove(c));
            const valor = opcoes[escolha[nome]] ? escolha[nome] : PADRAO[nome];
            container.classList.add(`${prefixo}-${valor}`);
        });
    }

    // Iniciais do título da janela, para o formato "Círculo" ("Cadastro de Pessoas" -> "CP", "Pessoas" -> "PE")
    function iniciaisTitulo(titulo) {
        const palavras = String(titulo || '').replace(/\([^)]*\)/g, ' ').split(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ]+/)
            .filter(p => p && !/^(de|da|do|das|dos|e|a|o|em|na|no|para|por|com)$/i.test(p));
        if (!palavras.length) return '?';
        return (palavras.length === 1 ? palavras[0].slice(0, 2) : palavras[0][0] + palavras[1][0]).toUpperCase();
    }

    // Detecta o tema pela configuração do portal ou, se não houver, pelo CSS carregado (xtheme-<nome>.css)
    function detectarTema() {
        const doConfig = oW5Portal.config && oW5Portal.config.layout && oW5Portal.config.layout.theme;
        if (doConfig && TEMAS[doConfig]) return { nome: doConfig, ...TEMAS[doConfig] };
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
            const m = link.href.match(/xtheme-(\w+)\.css/);
            if (m && TEMAS[m[1]]) return { nome: m[1], ...TEMAS[m[1]] };
        }
        return { nome: 'blue', ...TEMAS.blue };
    }

    // O tema "volks" muda bastante o portal (barras maiores, ícones do Font Awesome em vez de imagens)
    function temaEhVolks() {
        return temaAtual && temaAtual.nome === 'volks';
    }

    // Ícones dos menus (SVG desenhado na cor do tema)
    const ICONES = {
        minimizar: '<path d="M3.5 12.5h9" stroke-width="2"/>',
        restaurar: '<rect x="2.5" y="5.5" width="8" height="8" rx="1"/><path d="M5.5 5.5v-3h8v8h-3"/>',
        inicio: '<path d="M2 8.5 8 3l6 5.5"/><path d="M4 7.3v6.2h3v-3.5h2v3.5h3V7.3"/>',
        duplicar: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5h-1v-8h8v1"/>',
        fechar: '<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.8"/>',
        reabrir: '<path d="M4 6.5h6a3.5 3.5 0 0 1 0 7H6"/><path d="M6.5 3.5 3.5 6.5l3 3"/>',
        configuracoes: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6 5 11M11 5l1.6-1.6"/>',
        sino: '<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1.5 1.5h-11z"/><path d="M6.5 14.5h3"/>',
        ajuda: '<circle cx="8" cy="8" r="6.3"/><path d="M6 6.2a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.2M8 11.4v.3"/>',
        caixa: '<path d="M2 9h3.5l1 2h3l1-2H14"/><path d="M2 9l2-5.5h8L14 9v4.5H2z"/>',
        fonte: '<path d="M2.5 13.5 6 3.5h1l3.5 10M3.8 10h5.4"/><path d="M11 9.5h3M12.5 8v5.5"/>',
        barra: '<rect x="1.5" y="3" width="13" height="10" rx="1.2"/><path d="M1.5 10h13M3.5 11.5h2.5M7.5 11.5h2.5"/>',
        janelas: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M1.5 5.5h13"/>',
        teclado: '<rect x="1" y="4" width="14" height="8.5" rx="1.2"/><path d="M3.5 6.8h.01M6 6.8h.01M8.5 6.8h.01M11 6.8h.01M12.5 6.8h.01M4.5 10h7" stroke-width="1.6"/>',
        cadeado: '<rect x="3" y="7" width="10" height="7.5" rx="1.2"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2"/>',
        sobre: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4M8 4.8v.2" stroke-width="1.7"/>',
        tema: '<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.8.6-1.3 1.4-1.3h1.6a2.6 2.6 0 0 0 2.6-2.6C14.2 4.1 11.4 1.8 8 1.8z"/><circle cx="4.8" cy="7" r=".7"/><circle cx="7.2" cy="4.6" r=".7"/><circle cx="10.4" cy="5" r=".7"/>'
    };

    // O SVG entra como máscara (a forma) e a cor vem do background-color: assim o Dealer/Tema, que traduz as
    // cores das folhas de estilo, também recolore os ícones (uma cor dentro do SVG ele não alcança)
    function urlIcone(nome) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" ` +
                    `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONES[nome]}</svg>`;
        return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    }

    // CSS da barra e de todas as aparências dos botões (ver FORMATOS_BOTAO e companhia). Vale para a barra e para a
    // prévia da aba Barra das configurações. As cores entram direto nas propriedades (o Dealer/Tema traduz).
    // Espaço entre a linha de cima da barra de status do portal e a nossa barra (o padding dela, menos a linha)
    function folgaTopoBarra() {
        try {
            const pad = parseFloat(getComputedStyle(oW5Portal.statusbar.getEl().dom).paddingTop) || 0;
            return Math.max(0, Math.round(pad) - 1);
        } catch (e) {
            return 1;
        }
    }

    function estilosBotoesBarra(tema, altura) {
        const B = ':is(#barraDeTarefas, .dbtPreviaBarra)';
        const h = altura - 5;                                     // altura dos botões
        const t = Math.max(6, Math.round(h * 0.33));              // tamanho das pontas
        const recortes = {
            chanfrado: ['polygon(5px 0, calc(100% - 5px) 0, 100% 5px, 100% calc(100% - 5px), calc(100% - 5px) 100%, 5px 100%, 0 calc(100% - 5px), 0 5px)', '0 10px'],
            seta: [`polygon(0 0, calc(100% - ${t}px) 0, 100% 50%, calc(100% - ${t}px) 100%, 0 100%)`, `0 ${t + 6}px 0 9px`],
            divisa: [`polygon(0 0, calc(100% - ${t}px) 0, 100% 50%, calc(100% - ${t}px) 100%, 0 100%, ${t}px 50%)`, `0 ${t + 5}px 0 ${t + 7}px`],
            pontas: [`polygon(${t}px 0, calc(100% - ${t}px) 0, 100% 50%, calc(100% - ${t}px) 100%, ${t}px 100%, 0 50%)`, `0 ${t + 6}px`],
            etiqueta: [`polygon(${t}px 0, 100% 0, 100% 100%, ${t}px 100%, 0 50%)`, `0 10px 0 ${t + 6}px`],
            inclinado: [`polygon(${t}px 0, 100% 0, calc(100% - ${t}px) 100%, 0 100%)`, `0 ${t + 6}px`]
        };
        const folga = folgaTopoBarra();
        // Doca de cada formato que precisa dela: [largura, forma do lado direito = avesso do lado esquerdo do botão]
        const doca = {
            divisa: [t + 10, `polygon(0 0, calc(100% - ${t}px) 0, 100% 50%, calc(100% - ${t}px) 100%, 0 100%)`],
            inclinado: [t + 10, `polygon(0 0, 100% 0, calc(100% - ${t}px) 100%, 0 100%)`],
            etiqueta: [t + 10, `polygon(0 0, 100% 0, calc(100% - ${t}px) 50%, 100% 100%, 0 100%)`],
            pontas: [t + 10, `polygon(0 0, 100% 0, calc(100% - ${t}px) 50%, 100% 100%, 0 100%)`]
        };
        const emRecorte = (sufixo) => Object.keys(recortes).map(f => `${B}.dbtf-${f}${sufixo}`).join(', ');
        // Camadas de imagem de cada estilo (o "reflexo" ao passar o mouse entra por cima delas)
        const camadas = {
            gradiente: 'linear-gradient(to bottom, rgba(255,255,255,.6), rgba(255,255,255,0) 55%, rgba(0,0,0,.1))',
            brilhante: 'linear-gradient(to bottom, rgba(255,255,255,.8), rgba(255,255,255,.35) 48%, rgba(255,255,255,0) 52%, rgba(0,0,0,.08))'
        };
        const contorno = ['1px 0', '-1px 0', '0 1px', '0 -1px'].map(d => `drop-shadow(${d} 0 currentColor)`).join(' ');
        const reflexo = 'linear-gradient(105deg, rgba(255,255,255,0) 40%, rgba(255,255,255,.7) 50%, rgba(255,255,255,0) 60%)';
        return `
            ${B} {
                display: flex;
                flex-wrap: nowrap;
                gap: 5px;
                height: ${altura}px;
                box-sizing: border-box;
                overflow-x: auto;
                overflow-y: hidden;
                white-space: nowrap;
                padding: 3px 2px 0 2px;
                scrollbar-width: none;
                font: normal 11px arial,tahoma,verdana,helvetica;
            }
            ${B}::-webkit-scrollbar { display: none; }

            ${B} button {
                position: relative;
                height: ${h}px;
                flex-shrink: 0;
                padding: 0 8px;
                margin: 0;
                border: 1px solid ${tema.corAtivo};
                border-radius: 0;
                background: ${tema.corPadrao};
                background-repeat: no-repeat;
                color: ${tema.corTexto};
                cursor: pointer;
                font-size: 12px;
                white-space: nowrap;
                max-width: ${config.larguraMaxBotao}px;
                overflow: hidden;
                text-overflow: ellipsis;
                transition: background-color 0.2s, color 0.2s, opacity 0.2s, transform 0.15s, box-shadow 0.2s, filter 0.2s;
            }

            /* Formatos */
            ${B}.dbtf-arredondado button { border-radius: 6px; }
            ${B}.dbtf-pilula button { border-radius: ${h}px; padding: 0 12px; }
            ${B}.dbtf-folha button { border-radius: ${Math.round(h / 2)}px 0; padding: 0 11px; }
            ${B}.dbtf-aba button { border-radius: 0 0 8px 8px; border-top-width: 0; margin-top: -3px; height: ${h + 3}px; padding: 0 12px; }
            /* Na barra de verdade, a aba fica pendurada na linha de cima da barra de status (acima da nossa barra há o
               padding do portal): a barra sobe essa folga e as abas crescem o mesmo, sem sobrar espaço embaixo */
            #barraDeTarefas.dbtf-aba { margin-top: -${folga}px; height: ${altura + folga}px; }
            #barraDeTarefas.dbtf-aba button { height: ${h + 3 + folga}px; }
            ${Object.entries(recortes).map(([f, [forma, recuo]]) =>
                `${B}.dbtf-${f} button { clip-path: ${forma}; padding: ${recuo}; border-color: transparent; }`).join('\n            ')}
            /* Nos formatos recortados a borda some nas diagonais: o contorno vem de sombras de 1px na barra toda, que
               seguem o recorte. A cor vem do "color" da barra (currentColor), que o Dealer/Tema traduz (o filter não). */
            ${emRecorte('')} {
                color: ${tema.corAtivo};
                filter: ${contorno};
            }
            ${emRecorte('.dbte-sombra')} { filter: ${contorno} drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
            ${emRecorte('.dbte-plano')} { filter: none; }
            ${emRecorte('.dbte-vidro button:not(.ativo)')} { background-color: rgba(255,255,255,.8); }
            ${B}.dbtf-divisa, ${B}.dbtf-inclinado { gap: 0; }
            ${B}.dbtf-divisa button { margin-left: -${t - 3}px; }
            ${B}.dbtf-inclinado button { margin-left: -${t - 4}px; }
            /* Doca: peça fixa (só enfeite) no começo da barra, com o lado direito no formato do lado esquerdo dos
               botões, para o primeiro encaixar nela. É um ::before (sempre o primeiro, não arrasta, sem lógica de
               "primeiro botão") e fica parada ao rolar a barra. */
            ${Object.keys(doca).map(f => `${B}.dbtf-${f}::before`).join(', ')} {
                content: ''; flex: none; position: sticky; left: 0; z-index: 2; align-self: flex-start;
                height: ${h}px; background-color: ${tema.corTexto};
                background-image: linear-gradient(90deg, ${tema.corTexto}, ${tema.corAtivo});   /* não parece um botão ativo */
            }
            ${Object.entries(doca).map(([f, [largura, forma]]) =>
                `${B}.dbtf-${f}::before { width: ${largura}px; clip-path: ${forma}; }`).join('\n            ')}
            ${B}.dbtf-circulo button {
                width: ${h}px; min-width: ${h}px; max-width: ${h}px; padding: 0; border-radius: 50%;
                font-size: 0; text-overflow: clip; text-align: center;
            }
            ${B}.dbtf-circulo button::after {
                content: attr(data-iniciais); font-size: ${Math.max(9, Math.round(h * 0.4))}px; font-weight: bold; letter-spacing: -0.3px;
            }

            /* Estilos */
            ${Object.entries(camadas).map(([e, img]) => `${B}.dbte-${e} button { background-image: ${img}; }`).join('\n            ')}
            ${B}.dbte-relevo button { box-shadow: inset 0 1px 0 rgba(255,255,255,.8), inset 0 -2px 0 rgba(0,0,0,.2); }
            ${B}.dbte-relevo button.ativo { box-shadow: inset 0 2px 4px rgba(0,0,0,.35); }
            ${B}.dbte-vidro button {
                background-color: rgba(255,255,255,.4); border-color: rgba(255,255,255,.75);
                -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
                box-shadow: inset 0 1px 0 rgba(255,255,255,.85), 0 1px 3px rgba(0,0,0,.15);
            }
            ${B}.dbte-sombra { filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
            ${B}.dbte-contorno button { background-color: transparent; }
            ${emRecorte('.dbte-contorno button:not(.ativo)')} { background-color: ${tema.corPadrao}; }
            ${B}.dbte-plano button { background-color: transparent; border-color: transparent; }
            ${B}.dbte-plano button:not(.ativo):hover { background-color: ${tema.corPadrao}; }

            /* Janela ativa (e minimizada) */
            ${B} button.ativo {
                background-color: ${tema.corAtivo};
                color: ${tema.corTextoAtivo};
            }
            ${B} button.botaoMinimizado { opacity: 0.5; }
            ${B}.dbta-linha button.ativo { box-shadow: inset 0 -3px 0 ${tema.corTexto}; }
            ${B}.dbta-sublinhado button.ativo {
                background-color: ${tema.corPadrao}; color: ${tema.corTexto}; font-weight: bold; box-shadow: inset 0 -3px 0 ${tema.corAtivo};
            }
            ${B}.dbta-sublinhado.dbte-plano button.ativo, ${B}.dbta-sublinhado.dbte-contorno button.ativo { background-color: transparent; }
            ${B}.dbta-sublinhado.dbte-vidro button.ativo { background-color: rgba(255,255,255,.4); }
            ${emRecorte('.dbta-sublinhado.dbte-contorno button.ativo')} { background-color: ${tema.corPadrao}; }
            ${emRecorte('.dbta-sublinhado.dbte-vidro button.ativo')} { background-color: rgba(255,255,255,.8); }
            ${B}.dbta-invertido button.ativo { background-color: ${tema.corTexto}; color: ${tema.corPadrao}; border-color: ${tema.corTexto}; }
            ${B}.dbta-aceso button.ativo {
                box-shadow: 0 0 0 1px ${tema.corAtivo}, 0 0 9px 2px ${tema.corAtivo}, inset 0 0 7px rgba(255,255,255,.6);
                text-shadow: 0 0 4px rgba(255,255,255,.9);
            }
            ${B}.dbta-pulsar button.ativo { animation: barraTarefasPulsar 1.8s ease-in-out infinite; }
            @keyframes barraTarefasPulsar { 50% { filter: brightness(1.22) saturate(1.25); } }
            ${B}.dbta-levantado button.ativo { transform: translateY(-2px); box-shadow: 0 2px 0 rgba(0,0,0,.3); }

            /* Ao passar o mouse */
            ${B}.dbth-clarear button:hover { filter: brightness(1.1); }
            ${B}.dbth-escurecer button:hover { filter: brightness(0.9); }
            ${B}.dbth-levantar button:hover { transform: translateY(-2px); box-shadow: 0 3px 5px rgba(0,0,0,.25); }
            ${B}.dbth-crescer button:hover { transform: scale(1.07); z-index: 1; }
            ${B}.dbth-sublinhar button:hover { box-shadow: inset 0 -2px 0 ${tema.corAtivo}; }
            ${B}.dbth-balancar button:hover { animation: barraTarefasBalancar 0.4s ease-in-out; }
            @keyframes barraTarefasBalancar { 25% { transform: rotate(-3deg); } 75% { transform: rotate(3deg); } }
            ${B}.dbth-reflexo button:hover {
                background-image: ${reflexo}; background-size: 250% 100%; background-position: -30% 0;
                animation: barraTarefasReflexo 0.7s ease-out;
            }
            ${Object.entries(camadas).map(([e, img]) => `${B}.dbth-reflexo.dbte-${e} button:hover { background-image: ${reflexo}, ${img}; background-size: 250% 100%, 100% 100%; }`).join('\n            ')}
            @keyframes barraTarefasReflexo { from { background-position: 130% 0; } to { background-position: -30% 0; } }

            /* Ao abrir uma janela (o botão novo tem a classe dbtNovo por um instante) */
            ${B}.dbtn-aparecer button.dbtNovo { animation: barraTarefasAparecer 0.4s ease-out both; }
            ${B}.dbtn-subir button.dbtNovo { animation: barraTarefasSubir 0.35s ease-out both; }
            ${B}.dbtn-saltar button.dbtNovo { animation: barraTarefasSaltar 0.45s ease-out both; }
            ${B}.dbtn-deslizar button.dbtNovo { animation: barraTarefasDeslizar 0.35s ease-out both; }
            @keyframes barraTarefasAparecer { from { opacity: 0; } }
            @keyframes barraTarefasSubir { from { opacity: 0; transform: translateY(100%); } }
            @keyframes barraTarefasSaltar { 0% { opacity: 0; transform: scale(.3); } 60% { opacity: 1; transform: scale(1.12); } 100% { transform: scale(1); } }
            @keyframes barraTarefasDeslizar { from { opacity: 0; transform: translateX(-24px); } }

            /* Indicador de carregamento */
            ${B} button.carregando::before {
                content: '';
                display: inline-block;
                width: 8px;
                height: 8px;
                margin-right: 6px;
                vertical-align: -1px;
                border: 2px solid currentColor;
                border-right-color: transparent;
                border-radius: 50%;
                animation: barraTarefasGira 0.8s linear infinite;
            }
            @keyframes barraTarefasGira { to { transform: rotate(360deg); } }
            ${B}.dbtf-circulo button.carregando::before { position: absolute; inset: 1px; width: auto; height: auto; margin: 0; box-sizing: border-box; }

            /* Terminou de carregar enquanto estava em segundo plano */
            ${B} button.concluido {
                font-weight: bold;
                box-shadow: inset 0 -3px 0 #3c9a46;
            }
            ${B} button.concluido::before {
                content: '\\2714';
                margin-right: 5px;
                color: #3c9a46;
            }
            ${B}.dbtf-circulo button.concluido { box-shadow: inset 0 0 0 2px #3c9a46; }
            ${B}.dbtf-circulo button.concluido::before { content: none; }

            /* Botão "Iniciar" (busca no menu) no começo da barra: sempre o primeiro, parado ao rolar, só com a lupa.
               Nos formatos com doca ele toma o lugar dela, com a mesma forma, e o primeiro botão encaixa nele. */
            ${B} button.dbtIniciar {
                position: sticky; left: 0; z-index: 2; flex: none; padding: 0; margin-left: 0; text-overflow: clip;
                width: ${h + 6}px; min-width: ${h + 6}px; max-width: ${h + 6}px;
            }
            ${B} button.dbtIniciar i { font-size: ${Math.max(11, Math.round(h * 0.48))}px; }
            ${B} button.dbtIniciar:hover { filter: brightness(1.08); }
            ${B}.dbtf-circulo button.dbtIniciar::after { content: none; }
            ${Object.keys(doca).map(f => `${B}.dbtComIniciar.dbtf-${f}::before`).join(', ')} { display: none; }
            ${Object.entries(doca).map(([f, [largura, forma]]) => `${B}.dbtf-${f} button.dbtIniciar {
                width: ${largura + 18}px; min-width: ${largura + 18}px; max-width: ${largura + 18}px; margin-left: 0;
                padding: 0 ${t}px 0 0; clip-path: ${forma}; border-color: transparent; box-shadow: none;
                background-color: ${tema.corTexto}; background-image: linear-gradient(90deg, ${tema.corTexto}, ${tema.corAtivo});
                color: ${tema.corTextoAtivo};
            }`).join('\n            ')}

            /* Prévia (aba Barra das configurações) */
            .dbtPreviaFundo { padding: 6px 6px 4px; border: 1px solid #ccc; margin-top: 6px; }
            .dbtPreviaBarra button { font-family: arial, tahoma, verdana, helvetica; }`;
    }

    // ---------------------------------------------------------------------------------------------
    // Esquema "GTA VI" do Dealer/Tema (id 'vice'; céu de pôr do sol + neon): a barra, os menus, as janelas de configurações e
    // os avisos ganham o mesmo visual que o tema dá aos botões do portal (vidro roxo com borda rosa -> laranja,
    // destaque cheio com o pôr do sol). Tudo fica preso a html[data-dealer-tema-esquema="vice"] (o tema põe esse
    // atributo em cada documento que ele pinta) e o <style> leva data-dealer-tema, para o tema não remapear as
    // cores. A mesma folha entra no portal e em cada tela (iframe): cada regra só acha os elementos do seu lugar.
    // ---------------------------------------------------------------------------------------------
    function cssVice() {
        const H = 'html[data-dealer-tema-esquema="vice"]';
        // Os :not(#...) só aumentam a especificidade, para ganhar de todas as combinações de aparência dos botões
        const V = `${H} :is(#barraDeTarefas, .dbtPreviaBarra):not(#dbtVice1):not(#dbtVice2)`;
        const borda = 'linear-gradient(100deg,#ff3ea5,#ff8c42) border-box';
        const vidro = `linear-gradient(180deg,#3b1d63,#26133f) padding-box, ${borda}`;
        const vidroAceso = 'linear-gradient(180deg,#5b2486,#3a1659) padding-box, linear-gradient(100deg,#ff6cbd,#ffad66) border-box';
        const porDoSol = 'linear-gradient(100deg,#ff3ea5 0%,#ff5f7e 50%,#ff8c42 100%)';
        const brilho = '0 0 10px -5px rgba(255,62,165,.7)';
        const brilhoAceso = '0 0 14px -3px rgba(255,62,165,.85), 0 0 22px -8px rgba(255,140,66,.7)';
        const brilhoDestaque = '0 4px 16px -4px rgba(255,62,165,.75)';
        const textoDestaque = '0 1px 2px rgba(80,0,40,.45)';
        const reflexo = 'linear-gradient(105deg, rgba(255,255,255,0) 40%, rgba(255,255,255,.35) 50%, rgba(255,255,255,0) 60%)';
        const foco = '0 0 0 2px rgba(255,62,165,.3), 0 0 12px -2px rgba(255,62,165,.6)';
        const campos = ':is(input[type=text], input[type=number], input:not([type]), select, textarea)';
        return `
/* ---- Barra de tarefas (e a prévia da aba Barra) ---- */
${V} { color: #ff3ea5; }   /* contorno dos formatos recortados (currentColor) */
${V} button { border-color: transparent; background: ${vidro}; color: #fff0fa; text-shadow: none; box-shadow: ${brilho}; }
${V}.dbte-gradiente button { background: linear-gradient(rgba(255,255,255,.16), rgba(255,255,255,0) 55%) padding-box, ${vidro}; }
${V}.dbte-brilhante button { background: linear-gradient(rgba(255,255,255,.24), rgba(255,255,255,.08) 48%, rgba(255,255,255,0) 52%) padding-box, ${vidro}; }
${V}.dbte-relevo button { box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 0 -2px 0 rgba(0,0,0,.4), ${brilho}; }
${V}.dbte-vidro button { background: linear-gradient(180deg,rgba(91,36,134,.55),rgba(38,19,63,.55)) padding-box,
    linear-gradient(100deg,rgba(255,62,165,.75),rgba(255,140,66,.75)) border-box; box-shadow: inset 0 1px 0 rgba(255,255,255,.15), ${brilho}; }
${V}.dbte-contorno button { background: transparent; border-color: #ff3ea5; }
${V}.dbte-contorno:is(.dbtf-chanfrado, .dbtf-seta, .dbtf-divisa, .dbtf-pontas, .dbtf-etiqueta, .dbtf-inclinado) button { background: #26133f; }
${V}.dbte-plano button { background: transparent; box-shadow: none; }
${V} button:not(.ativo):hover { background: ${vidroAceso}; color: #ffffff; box-shadow: ${brilhoAceso}; }
${V}.dbte-contorno button:not(.ativo):hover, ${V}.dbte-plano button:not(.ativo):hover { background: rgba(255,62,165,.16); }
${V}.dbth-sublinhar button:not(.ativo):hover { box-shadow: inset 0 -2px 0 #ff3ea5, ${brilhoAceso}; }
${V}.dbth-reflexo button:not(.ativo):hover { background: ${reflexo} padding-box, ${vidroAceso};
    background-size: 250% 100%, 100% 100%, 100% 100%; animation: barraTarefasReflexo .7s ease-out; }
/* janela ativa: cheia com o pôr do sol */
${V} button.ativo { background: ${porDoSol}; border-color: rgba(255,255,255,.14); color: #ffffff; text-shadow: ${textoDestaque}; box-shadow: ${brilhoDestaque}; }
${V} button.ativo:hover { box-shadow: 0 6px 22px -4px rgba(255,120,80,.9); }
${V}.dbth-reflexo button.ativo:hover { background: ${reflexo}, ${porDoSol}; background-size: 250% 100%, 100% 100%; animation: barraTarefasReflexo .7s ease-out; }
${V}.dbte-relevo button.ativo { box-shadow: inset 0 2px 4px rgba(80,0,40,.55), ${brilhoDestaque}; }
${V}.dbta-linha button.ativo { box-shadow: inset 0 -3px 0 #2de2e6, ${brilhoDestaque}; }
${V}.dbta-sublinhado button.ativo { background: ${vidro}; color: #ffffff; text-shadow: none; font-weight: bold; box-shadow: inset 0 -3px 0 #ff3ea5, ${brilho}; }
${V}.dbta-sublinhado:is(.dbte-plano, .dbte-contorno) button.ativo { background: transparent; }
${V}.dbta-invertido button.ativo { background: #ffd1ec; border-color: #ffd1ec; color: #3a1760; text-shadow: none; }
${V}.dbta-aceso button.ativo { box-shadow: 0 0 0 1px #ff3ea5, 0 0 10px 2px #ff3ea5, 0 0 18px 2px rgba(255,140,66,.6); text-shadow: 0 0 4px rgba(255,255,255,.9); }
${V}.dbta-levantado button.ativo { box-shadow: 0 3px 0 #8a2470, 0 6px 14px -4px rgba(255,62,165,.7); }
/* terminou de carregar em segundo plano: verde-neon (o ✔ e o negrito continuam, não depende só da cor) */
${V} button.concluido { box-shadow: inset 0 -3px 0 #46f2a6, 0 0 10px -4px rgba(70,242,166,.8); }
${V} button.concluido::before { color: #46f2a6; }
${V}.dbtf-circulo button.concluido { box-shadow: inset 0 0 0 2px #46f2a6, 0 0 10px -4px rgba(70,242,166,.8); }
/* doca dos formatos encaixados (e o botão Iniciar, quando toma o lugar dela) */
${V}:is(.dbtf-divisa, .dbtf-inclinado, .dbtf-etiqueta, .dbtf-pontas) button.dbtIniciar { background: linear-gradient(90deg, #3a1760, #8a2470 70%, #ff3ea5);
    color: #ffffff; box-shadow: none; }
${V}::before { background-color: #3a1760; background-image: linear-gradient(90deg, #3a1760, #8a2470 70%, #ff3ea5); }
${H} .dbtPreviaFundo { border-color: #4b2d7a; border-radius: 6px; }

/* ---- Menus (engrenagem, clique direito, sino) ---- */
${H} .x-menu { border-color: #ff3ea5 !important; box-shadow: 0 0 0 1px rgba(255,62,165,.2), 0 12px 30px -8px rgba(255,62,165,.55); }
${H} .x-menu-item-active { background-image: linear-gradient(100deg, rgba(255,62,165,.4), rgba(255,140,66,.28)) !important; border-color: #ff3ea5 !important; }
${H} .x-menu-item-active .x-menu-item-text { color: #ffffff !important; text-shadow: 0 0 6px rgba(255,62,165,.9); }
${H} .x-menu-item-icon.dbt-ico { background-color: #ff8fd0 !important; }
${H} .x-menu-item-active .x-menu-item-icon.dbt-ico { background-color: #ffffff !important; }
${H} .barraTarefasMenuTitulo { color: #ffd1ec; border-bottom-color: #4b2d7a; text-shadow: 0 0 8px rgba(255,62,165,.7); }
${H} .dbtMenuGrupo { color: #2de2e6; }
${H} .x-tool.x-tool-dbt-inicio { color: #ffd1ec; }
${H} .x-tool.x-tool-dbt-inicio-over { color: #ffffff; text-shadow: 0 0 6px rgba(255,62,165,.9); }

/* ---- Janelas de configurações e tutoriais ---- */
${H} .barraTarefasConfig fieldset { border-color: #4b2d7a; border-radius: 8px; box-shadow: 0 6px 18px -12px rgba(255,62,165,.6); }
${H} .barraTarefasConfig legend, ${H} .barraTarefasTutorial h3 { color: #ffd1ec; text-shadow: 0 0 8px rgba(255,62,165,.7); }
${H} .barraTarefasConfig .dbtAbas { border-bottom: 1px solid #ff3ea5; border-image: linear-gradient(90deg, #2de2e6, #ff3ea5, #ff8c42) 0 0 1 0; }
${H} .barraTarefasConfig .dbtAba { background: linear-gradient(180deg, #3b1d63, #26133f); border-color: #4b2d7a; color: #e9d8ff; }
${H} .barraTarefasConfig .dbtAba:hover { background: linear-gradient(180deg, #5b2486, #3a1659); color: #ffffff; filter: none; box-shadow: 0 -2px 10px -4px rgba(255,62,165,.7); }
${H} .barraTarefasConfig .dbtAba.ativa { background: ${porDoSol}; border-color: #ff3ea5; color: #ffffff; text-shadow: ${textoDestaque};
    box-shadow: 0 -2px 14px -4px rgba(255,62,165,.85); }
${H} .barraTarefasConfig .dbtAbaIco { background-color: #ff8fd0; }
${H} .barraTarefasConfig .dbtAba.ativa .dbtAbaIco { background-color: #ffffff; }
${H} .barraTarefasConfig.dbtBuscando .dbtAbas .dbtAba.ativa { background: linear-gradient(180deg, #3b1d63, #26133f); border-color: #4b2d7a;
    color: #e9d8ff; text-shadow: none; box-shadow: none; }
${H} .barraTarefasConfig.dbtBuscando .dbtAbas .dbtAba.ativa .dbtAbaIco { background-color: #ff8fd0; }
${H} .barraTarefasConfig.dbtBuscando .dbtAbaPainel::before { color: #ffd1ec; border-bottom-color: #ff3ea5; text-shadow: 0 0 8px rgba(255,62,165,.6); }
${H} ::highlight(dbt-busca-config) { background-color: #ffd23f; color: #1a0f2e; }
${H} .barraTarefasConfig .dbtBotao { border-color: transparent; border-radius: 6px; background: ${vidro}; color: #fff0fa; box-shadow: ${brilho}; }
${H} .barraTarefasConfig .dbtBotao:hover { background: ${vidroAceso}; color: #ffffff; box-shadow: ${brilhoAceso}; }
${H} .barraTarefasConfig ${campos}, ${H} .barraTarefasConfig input.dbtAtalho {
    background-color: #1a0f2e; border: 1px solid #4b2d7a; border-radius: 4px; color: #fff0fa; }
${H} .barraTarefasConfig ${campos}:focus { outline: none; border-color: #ff3ea5; box-shadow: ${foco}; }
${H} .barraTarefasConfig input.dbtCampoBuscaConfig { border-radius: 6px; }
${H} .barraTarefasConfig input.dbtAtalho.gravando { background-color: rgba(255,210,63,.14); border-color: #ffd23f; box-shadow: 0 0 10px -3px rgba(255,210,63,.8); }
${H} .barraTarefasConfig .dbtLimpar:hover { color: #ff4d6d; }
${H} :is(.barraTarefasConfig, .barraTarefasTutorial) { accent-color: #ff3ea5; }
${H} .barraTarefasConfig .dbtListaFluxos { background-color: #1a0f2e; border-color: #4b2d7a; border-radius: 6px; }
${H} .barraTarefasConfig .dbtListaFluxos label:hover { background: rgba(255,62,165,.16); }
${H} .barraTarefasConfig .dbtSobreNome { background: ${porDoSol}; -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0 6px rgba(255,62,165,.55)); }
${H} .barraTarefasConfig .dbtAvisoAlfa { background: rgba(255,140,66,.12); border-left-color: #ff8c42; color: #ffd9bd; }
${H} .barraTarefasConfig :is(.dbtAvisoDepuracao, .dbtAvisoVolume) { background: rgba(255,77,109,.12); border-left-color: #ff4d6d; color: #ffc2cf; }
${H} .barraTarefasTutorial .dbtAviso { background: rgba(255,210,63,.1); border-color: #ffd23f; border-radius: 6px; color: #fff0fa; }
${H} .barraTarefasTutorial kbd { background: #2d1a4f; border-color: #ff3ea5 #ff3ea5 #ff8c42; color: #fff0fa; box-shadow: 0 0 6px -2px rgba(255,62,165,.7); }
${H} .barraTarefasTutorial i.fa { color: #ff6cbd; }
/* botões do rodapé (Salvar, Cancelar...) e das caixas de mensagem; o principal (Salvar) cheio com o pôr do sol */
${H} :is(.barraTarefasJanela, .x-window-dlg) .x-panel-fbar .x-btn { border: 1px solid transparent !important; border-radius: 6px;
    background: ${vidro} !important; box-shadow: ${brilho}; }
${H} :is(.barraTarefasJanela, .x-window-dlg) .x-panel-fbar .x-btn button { color: #fff0fa !important; }
${H} :is(.barraTarefasJanela, .x-window-dlg) .x-panel-fbar .x-btn-over { background: ${vidroAceso} !important; box-shadow: ${brilhoAceso}; }
${H} :is(.barraTarefasJanela, .x-window-dlg) .x-panel-fbar .x-btn-click { transform: translateY(1px); }
${H} :is(.barraTarefasJanela, .x-window-dlg) .x-panel-fbar .x-btn-focus { box-shadow: 0 0 0 2px rgba(45,226,230,.6), ${brilho}; }
${H} .barraTarefasJanela .x-panel-fbar .x-btn.dbtPrimario { background: ${porDoSol} !important; border-color: rgba(255,255,255,.14) !important; box-shadow: ${brilhoDestaque}; }
${H} .barraTarefasJanela .x-panel-fbar .x-btn.dbtPrimario button { color: #ffffff !important; font-weight: bold; text-shadow: ${textoDestaque}; }
${H} .barraTarefasJanela .x-panel-fbar .x-btn.dbtPrimario.x-btn-over { filter: brightness(1.1) saturate(1.1); box-shadow: 0 6px 22px -4px rgba(255,120,80,.9); }

/* ---- Aviso de novos fluxos ---- */
${H} .barraTarefasNotificacao { border: 1px solid transparent; border-left-width: 5px; border-right: none; border-radius: 8px 0 0 8px; color: #fff0fa;
    background: linear-gradient(180deg, #2d1a4f, #22143d) padding-box, linear-gradient(180deg, #ff3ea5, #ff8c42) border-box;
    box-shadow: 0 0 0 1px rgba(255,62,165,.2), 0 12px 32px -8px rgba(255,62,165,.6); }
${H} .barraTarefasNotificacao strong { color: #ffd1ec; text-shadow: 0 0 8px rgba(255,62,165,.75); }
${H} .barraTarefasNotificacao .dbtTempo, ${H} .barraTarefasNotificacao .dbtFechar { color: #a48cce; }
${H} .barraTarefasNotificacao .dbtFechar:hover { color: #ffffff; background: #ff4d6d; }
${H} .barraTarefasNotificacao .dbtLinhaFluxo:hover { color: #2de2e6; text-shadow: 0 0 6px rgba(45,226,230,.7); }
${H} .barraTarefasNotificacao .dbtAcoes a { color: #2de2e6; }

/* ---- Busca no menu ---- */
${H} #dbtBuscaMenu { background-color: #22143d; border-color: #ff3ea5; border-radius: 8px; color: #fff0fa;
    box-shadow: 0 0 0 1px rgba(255,62,165,.25), 0 14px 36px -8px rgba(255,62,165,.6); }
${H} #dbtBuscaMenu input { background-color: #1a0f2e; border-color: #4b2d7a; border-radius: 6px; color: #fff0fa; }
${H} #dbtBuscaMenu input:focus { border-color: #ff3ea5; box-shadow: ${foco}; }
${H} #dbtBuscaMenu .dbtBuscaMenuNome { color: #fff0fa; }
${H} #dbtBuscaMenu .dbtBuscaMenuCaminho { color: #a48cce; }
${H} #dbtBuscaMenu .dbtBuscaMenuCaminho b { color: #2de2e6; }
${H} #dbtBuscaMenu li.dbtBuscaMenuItem.dbtMarcado { background: linear-gradient(100deg, rgba(255,62,165,.35), rgba(255,140,66,.22)); border-left-color: #ff3ea5; }
${H} #dbtBuscaMenu li.dbtBuscaMenuItem.dbtMarcado .dbtBuscaMenuCaminho { color: #ffd1ec; }
${H} #dbtBuscaMenu mark { background-color: #ffd23f; color: #1a0f2e; }
${H} #dbtBuscaMenu :is(li.dbtBuscaMenuTitulo, li.dbtBuscaMenuVazio) { color: #a48cce; }
${H} #dbtBuscaMenu .dbtBuscaMenuRodape { background-color: #1a0f2e; border-top-color: #4b2d7a; color: #a48cce; }

/* ---- Avisos das telas (dentro de cada tela) ---- */
${H} span.ErrorViewer>div { background-color: rgba(255,77,109,.14); border-left-color: #ff4d6d; color: #fff0fa !important; }
${H} #dnf-aviso { border: 1px solid transparent; border-left-width: 4px; color: #fff0fa;
    background: linear-gradient(180deg, #2d1a4f, #22143d) padding-box, linear-gradient(160deg, #ff4d6d, #ff3ea5 55%, #ff8c42) border-box;
    box-shadow: 0 0 0 1px rgba(255,77,109,.25), 0 16px 48px -10px rgba(255,62,165,.65); }
${H} #dnf-aviso svg, ${H} #dnf-aviso-pilula svg { color: #ff4d6d; filter: drop-shadow(0 0 4px rgba(255,77,109,.8)); }
${H} #dnf-aviso .dnf-acoes { border-left-color: #4b2d7a; }
${H} #dnf-aviso .dnf-acoes button { border-color: transparent; border-radius: 6px; background: ${vidro}; color: #fff0fa; box-shadow: ${brilho}; }
${H} #dnf-aviso .dnf-acoes button:hover { background: ${vidroAceso}; color: #ffffff; box-shadow: ${brilhoAceso}; }
${H} #dnf-aviso-pilula { border-color: transparent; color: #fff0fa;
    background: linear-gradient(180deg, #3a1760, #26133f) padding-box, linear-gradient(100deg, #ff4d6d, #ff8c42) border-box;
    box-shadow: 0 0 12px -3px rgba(255,77,109,.8); }

/* ---- Busca nas listas de opções (dentro de cada tela) ---- */
${H} #dnf-busca { background-color: #22143d; border-color: #ff3ea5; border-radius: 8px; color: #fff0fa;
    box-shadow: 0 0 0 1px rgba(255,62,165,.25), 0 12px 32px -8px rgba(255,62,165,.6); }
${H} #dnf-busca input { background-color: #1a0f2e; border-color: #4b2d7a; border-radius: 6px; color: #fff0fa; }
${H} #dnf-busca input:focus { border-color: #ff3ea5; box-shadow: ${foco}; }
${H} #dnf-busca li.dnf-desativada { color: #6e5a96; }
${H} #dnf-busca li.dnf-vazio { color: #a48cce; }
${H} #dnf-busca li.dnf-marcada { background: ${porDoSol}; color: #ffffff; text-shadow: ${textoDestaque}; }
${H} #dnf-busca mark { background-color: #ffd23f; color: #1a0f2e; }
${H} #dnf-busca li.dnf-marcada mark { background-color: rgba(255,255,255,.3); color: #ffffff; }
${H} #dnf-busca .dnf-barra-busca { background: linear-gradient(90deg, rgba(45,226,230,.12), rgba(255,62,165,.12)); color: #2de2e6; border-bottom-color: #4b2d7a; }
${H} #dnf-busca .dnf-barra-busca:hover { background: linear-gradient(90deg, rgba(45,226,230,.22), rgba(255,62,165,.22)); }
${H} #dnf-busca .dnf-barra-busca kbd { background-color: #1a0f2e; border-color: #4b2d7a; color: #a48cce; }
${H} #dnf-busca .dnf-rodape { background-color: #1a0f2e; border-top-color: #4b2d7a; color: #a48cce; }
${H} #dnf-lupa { background: ${porDoSol}; border-left-color: rgba(255,255,255,.2); color: #ffffff; box-shadow: 0 0 10px -2px rgba(255,62,165,.85); }
${H} #dnf-lupa:hover { background: ${porDoSol}; filter: brightness(1.12) saturate(1.1); }
`;
    }

    // Põe a folha do esquema "GTA VI" num documento (o portal ou uma tela), uma vez só
    function estiloVice(doc) {
        if (!doc || doc.getElementById('dbt-vice-css')) return;
        const el = doc.createElement('style');
        el.id = 'dbt-vice-css';
        el.setAttribute('data-dealer-tema', '');   // marcado antes de entrar: o tema não traduz estas cores
        el.textContent = cssVice();
        (doc.head || doc.documentElement).appendChild(el);
    }

    function gerarEstilos(tema) {
        const altura = config.alturaBarra;
        const icones = Object.keys(ICONES).map(nome =>
            `.dbt-ico-${nome} { -webkit-mask-image: ${urlIcone(nome)}; mask-image: ${urlIcone(nome)}; }`).join('\n');
        return `
            ${estilosBotoesBarra(tema, altura)}

            /* Estilos do SortableJS */
            #barraDeTarefas .sortable-ghost,
            #barraDeTarefas .sortable-chosen { opacity: 0.5; }

            /* Durante arrastar/redimensionar, os iframes não podem "engolir" o mouse */
            body.barraTarefasArrastando iframe { pointer-events: none !important; }

            /* Botão "Início" no título das janelas.
               Temas comuns: mesma moldura dos botões de imprimir/atualizar (célula vazia do sprite do portal)
               com o ícone de casa do Font Awesome por cima. Tema volks: só o ícone, como os botões do tema. */
            .x-tool.x-tool-dbt-inicio {
                width: 15px !important;
                height: 15px !important;
                margin: 0 1px;
                font-size: 0;
                text-align: center;
                cursor: pointer;
                background-repeat: no-repeat !important;
                background-position: 0 -60px !important;
                color: #808080;
            }
            .x-tool.x-tool-dbt-inicio-over {
                background-position: -15px -60px !important;
                color: #444;
            }
            html[data-dealer-tema-esquema] .x-tool.x-tool-dbt-inicio { background-image: none !important; color: #555555; }
            /* Botões das janelas do Dealer/Fluxo e das caixas de mensagem: o portal os desenha com imagens, que o
               tema tira; aqui viram botões de verdade (cores claras que o tema traduz para a paleta dele) */
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn {
                border: 1px solid #a8a8a8 !important;
                border-radius: 4px;
                background-color: #eeeeee !important;
                border-collapse: separate;
            }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn td,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn td { background-image: none !important; }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn button,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn button { padding: 0 10px !important; color: #222222 !important; }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn-over,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn-over { background-color: #d9d9d9 !important; border-color: #888888 !important; }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn-click,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn-click { background-color: #c8c8c8 !important; }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-btn-focus,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-btn-focus { border-color: #2f6fd0 !important; }
            html[data-dealer-tema-esquema] .barraTarefasJanela .x-panel-fbar .x-item-disabled,
            html[data-dealer-tema-esquema] .x-window-dlg .x-panel-fbar .x-item-disabled { opacity: .5; }
            html[data-dealer-tema-esquema] .x-tool.x-tool-dbt-inicio-over { color: #222222; }
            .x-tool.x-tool-dbt-inicio::before {
                content: '\\f015';
                font: normal normal normal 10px/15px FontAwesome;
            }
            body.dbt-tema-volks .x-tool.x-tool-dbt-inicio {
                background: none !important;
                width: auto !important;
                height: auto !important;
                color: inherit;
            }
            body.dbt-tema-volks .x-tool.x-tool-dbt-inicio::before {
                font: normal normal normal 14px/1 FontAwesome;
            }

            /* Ícones dos menus */
            .x-menu-item-icon.dbt-ico {
                top: 50% !important;
                margin-top: -8px;
                background-image: none !important;
                background-color: ${tema.corTexto} !important;
                -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
                -webkit-mask-position: center; mask-position: center;
                -webkit-mask-size: 14px 14px; mask-size: 14px 14px;
            }
            ${icones}

            /* Título do menu de contexto (o recuo é calculado para alinhar com o texto dos itens) */
            .barraTarefasMenuTitulo {
                display: block;
                padding: 4px 8px 4px 0;
                font-size: 10px;
                font-weight: bold;
                color: ${tema.corTexto};
                border-bottom: 1px solid ${tema.corPadrao};
                max-width: 260px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            /* Botões do Dealer/Fluxo: engrenagem (barra de status) e sino (barra do alto, ao lado de "Minimiza todas") */
            /* Compactos: sem a setinha de menu e sem margens, um colado no outro */
            .barraTarefasBotaoStatus { margin: 0; }
            #barraTarefasBotaoFluxos { margin-left: 2px; }
            .barraTarefasBotaoStatus .x-btn-text { padding: 0 3px !important; }
            .barraTarefasBotaoStatus em.x-btn-arrow { background: none !important; padding-right: 0 !important; }
            .barraTarefasBotaoStatus em.x-btn-arrow::after, .barraTarefasBotaoStatus em.x-btn-arrow::before { content: none !important; display: none !important; }
            .barraTarefasBotaoStatus .x-btn-ml, .barraTarefasBotaoStatus .x-btn-mr { width: 1px !important; }
            .barraTarefasBotaoStatus .dbtNumero { margin-left: 2px; }
            .barraTarefasBotaoStatus.dbt-novidade .x-btn-text,
            .barraTarefasBotaoStatus.dbt-novidade button { color: #c0392b !important; font-weight: bold; }

            /* Janelas de configurações e tutoriais */
            body.dbt-tema-volks .barraTarefasJanela .x-panel-fbar button,
            body.dbt-tema-volks .barraTarefasJanela .x-panel-fbar label { color: #000 !important; }
            body.dbt-tema-volks .barraTarefasJanela .x-panel-fbar button { font-weight: bold; }
            .barraTarefasConfig { font: normal 12px arial,tahoma,verdana,helvetica; color: #333; }
            .barraTarefasConfig fieldset { border: 1px solid #ccc; margin: 0 0 10px 0; padding: 6px 10px 8px; }
            .barraTarefasConfig legend { font-weight: bold; color: ${tema.corTexto}; padding: 0 4px; }
            .barraTarefasConfig table { border-collapse: collapse; width: 100%; }
            .barraTarefasConfig td { padding: 3px 4px; vertical-align: middle; }
            .barraTarefasConfig td:first-child { width: 60%; }
            .barraTarefasConfig input[type=number] { width: 60px; }
            .barraTarefasConfig input[type=text] { width: 150px; }
            .barraTarefasConfig input.dbtAtalho { cursor: pointer; background: #fafafa; }
            .barraTarefasConfig input.dbtAtalho.gravando { background: #fff7d6; border-color: #e0b400; }
            .barraTarefasConfig .dbtLimpar { cursor: pointer; color: #999; margin-left: 4px; }
            .barraTarefasConfig .dbtLimpar:hover { color: #c00; }
            .barraTarefasConfig .dbtDica { color: #777; font-size: 11px; margin-top: 4px; }
            .barraTarefasConfig .dbtBotao {
                font: inherit; padding: 3px 10px; cursor: pointer; margin: 2px 4px 2px 0;
                border: 1px solid ${tema.corAtivo}; background: ${tema.corPadrao}; color: ${tema.corTexto};
            }
            .barraTarefasConfig .dbtTestarSom { padding: 0 6px; margin: 0 0 0 6px; font-size: 11px; }
            .barraTarefasConfig .dbtAbas { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid ${tema.corAtivo}; margin-bottom: 10px; }
            .barraTarefasConfig .dbtAba {
                font: inherit; padding: 5px 11px; margin-bottom: -1px; cursor: pointer; border: 1px solid #ccc;
                border-bottom-color: ${tema.corAtivo}; border-radius: 3px 3px 0 0; background: ${tema.corPadrao}; color: ${tema.corTexto};
            }
            .barraTarefasConfig .dbtAba:hover { filter: brightness(.96); }
            .barraTarefasConfig .dbtAba.ativa { background: #fff; font-weight: bold; border-color: ${tema.corAtivo}; border-bottom-color: #fff; }
            .barraTarefasConfig .dbtAbaPainel { display: none; height: 390px; overflow-y: auto; }
            .barraTarefasConfig .dbtAbaPainel.ativa { display: block; }
            .barraTarefasConfig .dbtBuscaConfig { margin: 0 0 8px; }
            .barraTarefasConfig input.dbtCampoBuscaConfig { width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit;
                border: 1px solid #b5b8c8; border-radius: 4px; }
            .barraTarefasConfig .dbtPaineis { overflow-y: auto; }
            .barraTarefasConfig .dbtSemResultado { display: none; padding: 30px 0; text-align: center; color: #777; }
            .barraTarefasConfig.dbtBuscando .dbtAbas .dbtAba.ativa { background: ${tema.corPadrao}; font-weight: normal; border-color: #ccc; border-bottom-color: ${tema.corAtivo}; }
            .barraTarefasConfig.dbtBuscando .dbtAbaPainel { display: block; height: auto !important; overflow: visible; }
            .barraTarefasConfig.dbtBuscando .dbtAbaPainel::before {
                content: attr(data-titulo); display: block; margin: 4px 0 6px; padding-bottom: 3px; font-weight: bold;
                color: ${tema.corTexto}; border-bottom: 1px solid ${tema.corAtivo};
            }
            .barraTarefasConfig.dbtBuscando .dbtFora { display: none !important; }
            .barraTarefasConfig.dbtBuscando.dbtNada .dbtSemResultado { display: block; }
            ::highlight(dbt-busca-config) { background-color: #ffe58a; color: #000000; }
            .barraTarefasConfig select { font: inherit; max-width: 150px; }
            .barraTarefasConfig input[type=range] { width: 130px; vertical-align: middle; }
            .barraTarefasConfig .dbtVolumeValor { display: inline-block; min-width: 36px; }
            .barraTarefasConfig .dbtVolumeValor.dbtAlto { color: #c0392b; font-weight: bold; }
            .barraTarefasConfig .dbtAvisoAlfa {
                margin: 0 0 10px; padding: 6px 8px; border-left: 3px solid #d4880f; background: #fff4e0; color: #6b4100;
            }
            .barraTarefasConfig select.dbtSelectTema { max-width: 230px; }
            .barraTarefasConfig select.dbtSelectAparencia { max-width: 230px; }
            .barraTarefasConfig .dbtAceite { display: block; margin-top: 6px; font-weight: bold; cursor: pointer; }
            .barraTarefasTutorial .dbtAceiteTelemetria { display: block; margin: 10px 0 4px; font-weight: bold; cursor: pointer; }
            .barraTarefasTutorial .dbtAceiteTelemetria input { vertical-align: -2px; margin: 0 5px 0 0; }
            .barraTarefasConfig .dbtSituacaoTelemetria:empty { display: none; }
            .barraTarefasConfig .dbtTextoPrivacidade p { margin: 0 0 8px; line-height: 1.45; }
            .barraTarefasConfig .dbtSobre { padding: 4px 2px 6px; }
            .barraTarefasConfig .dbtSobre p, .barraTarefasConfig .dbtDoacoes p { margin: 0 0 8px; line-height: 1.45; }
            .barraTarefasConfig .dbtSobreNome { font-size: 18px; font-weight: bold; color: ${tema.corTexto}; }
            .barraTarefasConfig .dbtSobreVersoes { color: #777; margin: 2px 0 10px; }
            .barraTarefasConfig .dbtCentro { text-align: center; }
            .barraTarefasConfig .dbtAbaIco {
                display: inline-block; width: 14px; height: 14px; margin: 0 5px 0 0; vertical-align: -3px;
                background-color: ${tema.corTexto};
                -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
                -webkit-mask-position: center; mask-position: center;
                -webkit-mask-size: 14px 14px; mask-size: 14px 14px;
            }
            .barraTarefasConfig fieldset.dbtApagado > :not(legend) { opacity: .5; }
            .barraTarefasConfig .dbtPixQr { display: block; margin: 0 auto 12px; image-rendering: pixelated;
                border: 1px solid #dddddd; border-radius: 6px; background: #ffffff; }
            .barraTarefasConfig .dbtPixCopia { display: flex; gap: 6px; justify-content: center; margin: 0 auto 10px; max-width: 560px; }
            .barraTarefasConfig .dbtPixCopia input.dbtPixCodigo { flex: 1; width: auto; font: 11px monospace; }
            .barraTarefasConfig .dbtSituacaoTelemetria { color: #a35a00; font-weight: bold; margin: 2px 0 6px; }
            .barraTarefasConfig .dbtAceite input { vertical-align: -2px; margin: 0 5px 0 0; }
            .barraTarefasConfig fieldset[disabled] table, .barraTarefasConfig fieldset[disabled] .dbtDica,
            .barraTarefasConfig fieldset[disabled] .dbtBotao, .barraTarefasConfig fieldset[disabled] legend { opacity: .45; }
            .barraTarefasConfig fieldset[disabled] .dbtAvisoDepuracao { opacity: .45; }
            .barraTarefasConfig tr:has(input:disabled) { opacity: .45; }
            .barraTarefasConfig .dbtAvisoDepuracao {
                margin: 0 0 6px; padding: 6px 8px; border-left: 3px solid #c0392b; background: #fbe9ea; color: #8a1f17; font-size: 11px;
            }
            .dbtMenuGrupo { font-weight: bold; font-size: 11px; color: #777777; padding: 3px 4px 1px 27px !important; }
            .barraTarefasConfig .dbtSemIcone { width: 100%; height: 260px; box-sizing: border-box; font: 11px/1.4 monospace; }
            .barraTarefasConfig .dbtAvisoVolume {
                margin-top: 6px; padding: 5px 8px; border-left: 3px solid #c0392b; background: #fbe9ea; color: #8a1f17; font-size: 11px;
            }
            .barraTarefasConfig .dbtBotao:hover { background: ${tema.corAtivo}; color: ${tema.corTextoAtivo}; }
            .barraTarefasConfig .dbtListaFluxos {
                height: 220px; overflow: auto; border: 1px solid #ccc; padding: 2px 4px; margin-top: 6px; background: #fff;
            }
            .barraTarefasConfig .dbtListaFluxos label { display: block; padding: 2px 0; white-space: nowrap; cursor: pointer; }
            .barraTarefasConfig .dbtListaFluxos label:hover { background: ${tema.corPadrao}; }
            .barraTarefasConfig .dbtCodigo { color: #999; font-size: 11px; }
            .barraTarefasConfig .dbtPendente { color: ${tema.corTexto}; font-weight: bold; }
            .barraTarefasConfig .dbtFiltro { width: 260px !important; }
            .barraTarefasConfig .dbtPersonalizados div { padding: 2px 0; }
            .barraTarefasTutorial { font: normal 12px/1.5 arial,tahoma,verdana,helvetica; color: #333; }
            .barraTarefasTutorial h3 { font-size: 13px; color: ${tema.corTexto}; margin: 10px 0 4px; }
            .barraTarefasTutorial h3:first-child { margin-top: 0; }
            .barraTarefasTutorial ul { margin: 0 0 0 18px; padding: 0; list-style: disc; }
            .barraTarefasTutorial li { margin: 2px 0; }
            .barraTarefasTutorial .dbtAviso {
                background: #fff7d6; border: 1px solid #e0b400; padding: 8px 10px; margin-bottom: 10px;
            }
            .barraTarefasTutorial kbd {
                border: 1px solid #bbb; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px;
                background: #f7f7f7; font: 11px arial;
            }
            .barraTarefasTutorial i.fa { color: ${tema.corTexto}; }

            /* Busca no menu: lupa na barra de status / no alto (compactas, como a engrenagem) e o painel de resultados */
            .dbtBuscaMenuStatus { margin-right: 4px; }
            .dbtBuscaMenuAlto { margin: 0 4px 0 6px; }
            .dbtBuscaMenuAlto .x-btn-text { font-size: 14px !important; padding: 0 6px !important; }
            #dbtBuscaMenu {
                position: fixed; z-index: 14500;          /* acima das janelas, abaixo dos menus do ExtJS (15000) */
                display: flex; flex-direction: column; max-height: min(70vh, 560px); box-sizing: border-box;
                background-color: #ffffff; color: #1f2328; border: 1px solid #8a9bb0; border-radius: 6px;
                box-shadow: 0 10px 30px rgba(0,0,0,.25); font: 12px/1.35 Tahoma, "Segoe UI", Arial, sans-serif; overflow: hidden;
            }
            #dbtBuscaMenu input {
                flex: none; margin: 8px; padding: 6px 9px; border: 1px solid #8a9bb0; border-radius: 4px;
                background-color: #ffffff; color: #1f2328; font: 13px Tahoma, "Segoe UI", Arial, sans-serif; outline: none;
            }
            #dbtBuscaMenu input:focus { border-color: #3b73b9; box-shadow: 0 0 0 2px rgba(59,115,185,.25); }
            #dbtBuscaMenu ul { flex: 1 1 auto; min-height: 0; margin: 0; padding: 0 0 4px; list-style: none; overflow-y: auto; }
            #dbtBuscaMenu li.dbtBuscaMenuItem { padding: 5px 12px; cursor: pointer; border-left: 3px solid transparent; }
            #dbtBuscaMenu li.dbtBuscaMenuItem.dbtMarcado { background-color: #e5eef9; border-left-color: #3b73b9; }
            #dbtBuscaMenu .dbtBuscaMenuNome { font-size: 13px; color: #1f2328; }
            #dbtBuscaMenu .dbtBuscaMenuCaminho { margin-top: 1px; font-size: 11px; color: #57606a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #dbtBuscaMenu .dbtBuscaMenuCaminho b { color: #1f2328; }
            #dbtBuscaMenu mark { padding: 0; border-radius: 2px; background-color: #ffe58a; color: inherit; }
            #dbtBuscaMenu li.dbtBuscaMenuTitulo { padding: 4px 12px 2px; font-size: 11px; font-weight: bold; color: #57606a; }
            #dbtBuscaMenu li.dbtBuscaMenuVazio { padding: 10px 12px; color: #57606a; font-style: italic; }
            #dbtBuscaMenu .dbtBuscaMenuRodape { flex: none; padding: 4px 12px; border-top: 1px solid #d0d7de; background-color: #f6f8fa; color: #57606a; font-size: 11px; }

            /* Avisos de novos fluxos */
            /* No canto superior direito, abaixo da barra do alto e do título das janelas (perto do sino) */
            #barraTarefasNotificacoes {
                position: fixed; right: 0; z-index: 14000;  /* acima das janelas, abaixo dos menus do ExtJS (15000) */
                display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
                pointer-events: none;
            }
            .barraTarefasNotificacao {
                pointer-events: auto;
                width: 340px; box-sizing: border-box;
                background: #fff; color: #333;
                border: 1px solid #aaa; border-right: none; border-left: 5px solid ${tema.corAtivo};
                box-shadow: 0 6px 16px rgba(0,0,0,0.2);
                padding: 10px 14px 12px; cursor: pointer;
                font: normal 12px/1.45 arial,tahoma,verdana,helvetica;
                transform: translateX(105%); opacity: 0;
                transition: transform 0.4s ease, opacity 0.3s ease;
            }
            .barraTarefasNotificacao.visivel { transform: translateX(0); opacity: 1; }
            .barraTarefasNotificacao .dbtCabecalho { display: flex; align-items: center; margin-bottom: 4px; }
            .barraTarefasNotificacao strong { flex: 1; font-size: 14px; color: ${tema.corTexto}; }
            .barraTarefasNotificacao .dbtTempo { color: #999; font-size: 11px; margin-left: 8px; white-space: nowrap; }
            .barraTarefasNotificacao .dbtTempo .fa { font-size: 9px; }
            .barraTarefasNotificacao .dbtFechar {
                margin: -4px -8px -4px 2px; padding: 2px 6px; font-size: 14px; line-height: 1;
                color: #888; border-radius: 3px;
            }
            .barraTarefasNotificacao .dbtFechar:hover { color: #fff; background: #c0392b; }
            .barraTarefasNotificacao .dbtLinhas { max-height: 220px; overflow: hidden; }
            /* Só o texto é clicável: clicar no espaço em branco ao lado fecha o aviso */
            .barraTarefasNotificacao .dbtLinhaFluxo:hover { text-decoration: underline; color: ${tema.corTexto}; }
            .barraTarefasNotificacao .dbtAcoes { margin-top: 6px; font-size: 11px; }
            .barraTarefasNotificacao .dbtAcoes a { color: ${tema.corTexto}; text-decoration: underline; cursor: pointer; }
        `;
    }

    function aplicarEstilos() {
        temaAtual = detectarTema();
        document.body.classList.toggle('dbt-tema-volks', temaEhVolks());
        if (!elementoEstilo) {
            elementoEstilo = document.createElement('style');
            elementoEstilo.id = 'barraDeTarefasEstilos';
            document.head.appendChild(elementoEstilo);
        }
        elementoEstilo.textContent = gerarEstilos(temaAtual);
        estiloVice(document);
    }

    // ---------------------------------------------------------------------------------------------
    // Ações sobre as janelas (sempre usando as funções do próprio portal)
    // ---------------------------------------------------------------------------------------------

    function estaMinimizada(janela) {
        return !!janela.minimized || !janela.isVisible();
    }

    function obterIframe(janela) {
        return janela.el && janela.el.dom.querySelector('iframe');
    }

    // Coloca o foco dentro da tela, para poder digitar logo depois de trocar de janela
    function focarConteudo(janela) {
        setTimeout(() => {
            const iframe = obterIframe(janela);
            try {
                if (iframe && !estaMinimizada(janela)) iframe.contentWindow.focus();
            } catch (e) { /* iframe de outro domínio */ }
        }, 50);
    }

    // Restaura usando o mesmo item do menu "Minimizadas (x)", para o contador do portal continuar certo
    function restaurarJanela(janela) {
        const menu = oW5Portal.statusbar && oW5Portal.statusbar.minimizedWindows;
        const item = menu && menu.items && menu.items.find(i => i.referer === janela.id && !i.hidden);
        if (item && item.handler) {
            item.handler.call(item, item);
        } else {
            janela.minimized = false;
            janela.show();
        }
        janela.toFront();
    }

    function minimizarJanela(janela) {
        if (!estaMinimizada(janela)) oW5Portal.minimizeWindow(janela);
    }

    function focarJanela(janela) {
        if (estaMinimizada(janela)) {
            restaurarJanela(janela);
        } else {
            janela.toFront();
        }
        focarConteudo(janela);
    }

    function janelaAtiva() {
        const ativa = Ext.WindowMgr.getActive();
        return ativa && registro.has(ativa.id) && !estaMinimizada(ativa) ? ativa : null;
    }

    // Endereço da tela dentro do portal, ex.: "../wp_pessoaconsulta.aspx"
    function urlDaTela(janela) {
        const qs = (oW5Portal.config.common.urlQueryStringName || 'url') + '=';
        const pos = janela.url ? janela.url.indexOf(qs) : -1;
        return pos < 0 ? null : janela.url.substring(pos + qs.length);
    }

    function dadosDaJanela(janela) {
        const restaurado = janela.maximized && janela.restoreSize;
        return {
            url: urlDaTela(janela),
            title: janela.title,
            width: restaurado ? janela.restoreSize.width : janela.getWidth(),
            height: restaurado ? janela.restoreSize.height : janela.getHeight(),
            maximized: !!janela.maximized
        };
    }

    // Abre uma tela numa janela nova do portal.
    // O createWindow do portal se recusa a abrir uma tela que já está aberta (ele só traz a existente pra
    // frente). Por isso escondemos a lista de janelas dele durante a chamada e juntamos de volta depois.
    function abrirTela(dados) {
        if (!dados.url) {
            console.error(`[${NOME_SCRIPT}] Não foi possível descobrir a URL da janela`, dados);
            return;
        }
        const janelasExistentes = oW5Portal.windows;
        oW5Portal.windows = [];
        try {
            oW5Portal.createWindow({ windows: [dados] });
        } finally {
            oW5Portal.windows = janelasExistentes.concat(oW5Portal.windows);
        }
    }

    function duplicarJanela(janela) {
        if (janela.__dnfDocumento) {
            abrirJanelaDocumento(`${janela.title}${config.sufixoCopia || ''}`, janela.__dnfDocumento.url, 1);
            return;
        }
        const dados = dadosDaJanela(janela);
        dados.title = `${janela.title}${config.sufixoCopia || ''}`;
        abrirTela(dados);
    }

    function reabrirFechada(indice = 0) {
        const [dados] = fechadas.splice(indice, 1);
        if (dados && dados.documento) abrirJanelaDocumento(dados.title, dados.documento.url);
        else if (dados) abrirTela(dados);
    }

    function fecharJanela(janela) {
        janela.close();
    }

    // Volta o iframe da janela para a tela que foi aberta pelo menu. Ex.: em Cadastro > Pessoas, depois de
    // clicar em "Modifica" o iframe está em wp_pessoa.aspx; isto volta para wp_pessoaconsulta.aspx.
    function irParaInicio(janela) {
        const iframe = obterIframe(janela);
        if (!iframe) return;
        const inicio = iframe.src;  // atributo src resolvido; não muda quando a tela navega
        try {
            iframe.contentWindow.location.replace(inicio);
        } catch (e) {
            iframe.src = inicio;
        }
        focarConteudo(janela);
    }

    // Mostra a tela inicial (Caixa de Entrada), que fica atrás das janelas
    function mostrarCaixaDeEntrada() {
        oW5Portal.minimizeAllWindows();
    }

    // Janelas na ordem em que aparecem na barra (respeita a ordem arrastada pelo usuário)
    function janelasNaOrdemDaBarra() {
        return [...containerBotoes.children]
            .map(b => registro.get(b.dataset.windowId))
            .filter(Boolean)
            .map(info => info.janela);
    }

    function irParaVizinha(direcao) {
        const lista = janelasNaOrdemDaBarra();
        if (!lista.length) return;
        const atual = lista.indexOf(janelaAtiva());
        let indice;
        if (atual < 0) {
            indice = direcao > 0 ? 0 : lista.length - 1;
        } else {
            indice = (atual + direcao + lista.length) % lista.length;
        }
        focarJanela(lista[indice]);
    }

    function irParaNumero(numero) {
        const janela = janelasNaOrdemDaBarra()[numero - 1];
        if (janela) focarJanela(janela);
    }

    // ---------------------------------------------------------------------------------------------
    // Atalhos de teclado
    // ---------------------------------------------------------------------------------------------

    const TECLAS_MODIFICADORAS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'];

    function modificadoresDoEvento(e) {
        const partes = [];
        if (e.ctrlKey) partes.push('Ctrl');
        if (e.altKey) partes.push('Alt');
        if (e.shiftKey) partes.push('Shift');
        if (e.metaKey) partes.push('Meta');
        return partes.join('+');
    }

    function comboDoEvento(e) {
        if (TECLAS_MODIFICADORAS.includes(e.key) || !e.code) return null;
        const mods = modificadoresDoEvento(e);
        return mods ? `${mods}+${e.code}` : e.code;
    }

    function digitoDoEvento(e) {
        const m = e.code && e.code.match(/^(?:Digit|Numpad)([1-9])$/);
        return m ? Number(m[1]) : null;
    }

    const NOMES_TECLAS = {
        ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
        PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc', Space: 'Espaço',
        Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
        Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlRo: '/'
    };

    function nomeAtalho(combo, ehNumero) {
        if (!combo) return '';
        const partes = combo.split('+').map(p => NOMES_TECLAS[p] || p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num '));
        return ehNumero ? `${partes.join('+')}+[1-9]` : partes.join('+');
    }

    const ACOES_ATALHO = {
        proxima: () => irParaVizinha(1),
        anterior: () => irParaVizinha(-1),
        minimizar: () => { const j = janelaAtiva(); if (j) minimizarJanela(j); },
        inicio: () => { const j = janelaAtiva(); if (j) irParaInicio(j); },
        reabrir: () => reabrirFechada(0),
        duplicar: () => { const j = janelaAtiva(); if (j) duplicarJanela(j); },
        fechar: () => { const j = janelaAtiva(); if (j) fecharJanela(j); },
        configuracoes: () => abrirConfiguracoes(),
        buscaMenu: () => abrirBuscaMenu()
    };

    // Recebe o keydown do portal e de todos os iframes (fase de captura, antes da própria tela)
    function tratarTecla(e) {
        if (e.target && e.target.classList && e.target.classList.contains('dbtAtalho')) return;  // gravando atalho

        const combo = comboDoEvento(e);
        if (!combo) return;

        let acao = null;
        const digito = digitoDoEvento(e);
        if (digito && config.atalhos.numero && modificadoresDoEvento(e) === config.atalhos.numero) {
            acao = () => irParaNumero(digito);
        } else {
            const nome = Object.keys(ACOES_ATALHO).find(n => config.atalhos[n] && config.atalhos[n] === combo);
            if (nome) acao = ACOES_ATALHO[nome];
            // Busca na lista: só com uma lista de opções em foco; fora dela a tecla segue para o navegador/tela
            if (config.atalhos.buscaLista === combo && listaComBusca(e.target)) {
                const lista = e.target;
                acao = () => abrirBuscaLista(lista);
            }
        }
        if (!acao) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        acao();
    }

    // ---------------------------------------------------------------------------------------------
    // Instrumentação dos iframes (atalhos, fechar menus e indicador de carregamento)
    // ---------------------------------------------------------------------------------------------

    function idJanelaDoElemento(elemento) {
        const el = elemento.closest && elemento.closest('.x-window');
        return el && ID_JANELA.test(el.id) ? el.id : null;
    }

    // Fecha os menus do ExtJS (da barra e do próprio portal). Cliques dentro de um iframe não chegam
    // ao documento do portal, então o ExtJS não fecha os menus sozinho nesse caso.
    function fecharMenus() {
        if (Ext.menu && Ext.menu.MenuMgr) Ext.menu.MenuMgr.hideAll();
        fecharBuscaMenu();
    }

    // Chamado quando qualquer iframe termina de carregar (e para os que já existiam ao iniciar)
    function instrumentarIframe(iframe, idJanela) {
        let win, doc;
        try {
            win = iframe.contentWindow;
            doc = win.document;
        } catch (e) {
            return;  // outro domínio: não dá para instrumentar
        }
        if (!doc || doc.__barraTarefas || navegacaoPendente(iframe, win)) return;
        doc.__barraTarefas = true;
        win.__barraTarefasJanela = idJanela;
        win.__barraTarefasPendentes = 0;

        // Visual do esquema "GTA VI" do Dealer/Tema para os avisos e a busca nas listas desta tela
        estiloVice(doc);

        // Avisos do GeneXus (mensagens em vermelho no topo da tela) em destaque
        instalarAvisoFlutuante(doc);

        // Busca nas listas de opções (<select>) com muitas opções
        instalarBuscaListas(doc);

        // Impressão da OS: documentos marcados abrem em janelas em vez de baixar
        instalarDocumentosOS(win, doc);

        // Atalhos mesmo com o foco dentro da tela
        win.addEventListener('keydown', tratarTecla, true);

        // Clique dentro da tela fecha os menus abertos (sem "engolir" o clique)
        doc.addEventListener('mousedown', fecharMenus, true);

        // Iframes dentro desta tela (popups do GeneXus, etc.)
        doc.addEventListener('load', (e) => {
            if (e.target && e.target.tagName === 'IFRAME') instrumentarIframe(e.target, idJanela);
        }, true);
        doc.querySelectorAll('iframe').forEach(f => instrumentarIframe(f, idJanela));

        // Arrastar/redimensionar começa no portal, mas o mouse pode ser solto aqui dentro
        doc.addEventListener('mouseup', () => document.body.classList.remove('barraTarefasArrastando'), true);

        // Tela inicial (fundo do portal): ao recarregar, relê os fluxos
        if (!idJanela) verificarFluxosEmBreve();

        // Navegação saindo desta página (ex.: clicar em "Modifica" numa grade)
        win.addEventListener('beforeunload', () => {
            win.__barraTarefasSaindo = true;
            if (idJanela) atualizarCarregamento(idJanela);
        });

        // Requisições AJAX do GeneXus (consultas, botões "Atualizar", etc.).
        // Na tela inicial também contamos, para não ler a lista de fluxos no meio de uma atualização.
        const contar = (delta) => {
            win.__barraTarefasPendentes = Math.max(0, win.__barraTarefasPendentes + delta);
            if (idJanela) atualizarCarregamento(idJanela);
            else if (delta < 0 && win.__barraTarefasPendentes === 0) verificarFluxosEmBreve();
        };

        const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
        if (proto && !proto.__barraTarefas) {
            proto.__barraTarefas = true;
            const enviarOriginal = proto.send;
            proto.send = function() {
                let terminou = false;
                const fim = () => {
                    if (!terminou) {
                        terminou = true;
                        contar(-1);
                    }
                };
                this.addEventListener('loadend', fim);
                contar(1);
                try {
                    return enviarOriginal.apply(this, arguments);
                } catch (erro) {
                    fim();
                    throw erro;
                }
            };
        }

        if (typeof win.fetch === 'function' && !win.fetch.__barraTarefas) {
            const fetchOriginal = win.fetch;
            const novoFetch = function() {
                contar(1);
                const promessa = fetchOriginal.apply(this, arguments);
                promessa.then(() => contar(-1), () => contar(-1));
                return promessa;
            };
            novoFetch.__barraTarefas = true;
            win.fetch = novoFetch;
        }

        if (idJanela) atualizarCarregamento(idJanela);
    }

    // Iframe que já tem endereço mas ainda mostra o about:blank inicial: a página dele ainda não chegou.
    // Ex.: relatórios (wp_reportingservices.aspx) carregam o relatório num iframe interno que fica
    // vários segundos assim enquanto o servidor gera o relatório.
    function navegacaoPendente(iframe, win) {
        const src = (iframe.getAttribute('src') || '').trim();
        return !!src && !/^(about:|javascript:)/i.test(src) && iframe.getAttribute('loading') !== 'lazy' &&
            win.location.href === 'about:blank';
    }

    // Verifica (recursivamente) se a tela ou algum iframe dela está carregando
    function iframeCarregando(iframe) {
        let win, doc;
        try {
            win = iframe.contentWindow;
            doc = win.document;
        } catch (e) {
            return false;
        }
        if (!doc) return false;
        if (navegacaoPendente(iframe, win)) return true;
        if (win.__barraTarefasSaindo) return true;
        if (doc.readyState !== 'complete') return true;
        if (win.__barraTarefasPendentes > 0) return true;
        for (const filho of doc.querySelectorAll('iframe')) {
            if (iframeCarregando(filho)) return true;
        }
        return false;
    }

    function atualizarCarregamento(idJanela) {
        const info = registro.get(idJanela);
        if (!info) return;

        const iframe = obterIframe(info.janela);
        // A tela ainda não terminou de carregar, mas já dá para contar as consultas dela
        if (iframe) {
            try {
                if (iframe.contentDocument.readyState !== 'loading') instrumentarIframe(iframe, idJanela);
            } catch (e) { /* outro domínio */ }
        }
        const carregando = !!iframe && iframeCarregando(iframe);

        if (carregando && !info.inicioCarga) {
            info.inicioCarga = Date.now();
            info.timerIndicador = setTimeout(() => {
                if (config.indicadorCarregamento) info.botao.classList.add('carregando');
            }, ATRASO_INDICADOR);
            // Garantia: confere de tempos em tempos, caso algum evento não chegue
            info.timerVerificacao = setInterval(() => atualizarCarregamento(idJanela), 500);
            info.botao.classList.remove('concluido');
        } else if (!carregando && info.inicioCarga) {
            const duracao = Date.now() - info.inicioCarga;
            info.inicioCarga = null;
            clearTimeout(info.timerIndicador);
            clearInterval(info.timerVerificacao);
            info.botao.classList.remove('carregando');

            const emSegundoPlano = janelaAtiva() !== info.janela;
            if (config.avisarConclusao && emSegundoPlano && duracao >= config.avisarAposSegundos * 1000) {
                info.botao.classList.add('concluido');
            }
        }
        atualizarBotao(idJanela);
    }

    function configurarInstrumentacao() {
        // "load" não sobe na árvore, mas passa pela fase de captura do documento
        document.addEventListener('load', (e) => {
            if (e.target && e.target.tagName === 'IFRAME') {
                instrumentarIframe(e.target, idJanelaDoElemento(e.target));
            }
        }, true);
        document.querySelectorAll('iframe').forEach(f => instrumentarIframe(f, idJanelaDoElemento(f)));
        window.addEventListener('keydown', tratarTecla, true);
        // Clique num iframe de outro domínio (que não dá para instrumentar) tira o foco do portal
        window.addEventListener('blur', fecharMenus);
    }

    // ---------------------------------------------------------------------------------------------
    // Barra de tarefas
    // ---------------------------------------------------------------------------------------------

    function atualizarBotao(id) {
        const info = registro.get(id);
        if (!info) return;
        const { janela, botao } = info;
        const minimizada = estaMinimizada(janela);
        const ativa = Ext.WindowMgr.getActive() === janela && !minimizada;
        const titulo = janela.title || 'Sem título';

        if (botao.textContent !== titulo) botao.textContent = titulo;
        const iniciais = iniciaisTitulo(titulo);
        if (botao.dataset.iniciais !== iniciais) botao.dataset.iniciais = iniciais;
        botao.title = info.inicioCarga ? `${titulo} (carregando...)` : titulo;
        botao.classList.toggle('botaoMinimizado', minimizada);
        botao.classList.toggle('ativo', ativa);
        if (ativa) botao.classList.remove('concluido');
    }

    function atualizarTodosBotoes() {
        registro.forEach((_, id) => atualizarBotao(id));
    }

    // Mostra/esconde a barra aumentando a altura da região "south" do layout do portal e pedindo
    // para o ExtJS refazer o layout. Assim janelas maximizadas e o redimensionamento do navegador
    // continuam funcionando sem ajustes manuais de altura.
    function atualizarVisibilidadeBarra(forcar = false) {
        const deveMostrar = registro.size > 0;
        if (deveMostrar === barraVisivel && !forcar) return;
        barraVisivel = deveMostrar;

        containerBotoes.style.display = deveMostrar ? '' : 'none';
        posicionarBotaoBuscaMenu();
        oW5Portal.statusbar.setHeight(alturaOriginalStatusbar + (deveMostrar ? config.alturaBarra : 0));
        oW5Portal.viewport.doLayout();

        // Janelas maximizadas precisam se ajustar ao novo tamanho da área central.
        // (O evento resize do portal falha em janelas cujo iframe ainda não carregou; ignoramos.)
        oW5Portal.windows.forEach(j => {
            try {
                if (j.maximized && j.isVisible() && j.fitContainer) j.fitContainer();
            } catch (e) { /* iframe ainda não existe */ }
        });
    }

    // Agenda a atualização da barra para depois que o portal terminar o que está fazendo
    // (ex.: o createWindow abrindo várias janelas de um workspace)
    let atualizacaoAgendada = false;
    function agendarAtualizacaoBarra() {
        if (atualizacaoAgendada) return;
        atualizacaoAgendada = true;
        setTimeout(() => {
            atualizacaoAgendada = false;
            atualizarVisibilidadeBarra();
            atualizarTodosBotoes();
        }, 0);
    }

    function adicionarBotaoInicio(janela) {
        if (!janela.header || (janela.tools && janela.tools['dbt-inicio'])) return;
        janela.addTool({
            id: 'dbt-inicio',
            qtip: 'Voltar para a página inicial desta tela',
            handler: () => irParaInicio(janela)
        });
        const ferramenta = janela.tools['dbt-inicio'];
        // Posiciona junto dos botões de imprimir/atualizar do portal e usa a mesma imagem de fundo deles
        const imprimir = janela.tools.W5Portal_Icon_Print;
        if (imprimir) {
            ferramenta.insertAfter(imprimir);
            const fundo = getComputedStyle(imprimir.dom).backgroundImage;
            if (fundo && fundo !== 'none') ferramenta.dom.style.backgroundImage = fundo;
        }
        ferramenta.setDisplayed(config.botaoInicio);
    }

    // Classe dbtNovo por um instante: é ela que dispara a animação de abertura escolhida (config.botaoAbertura)
    function marcarBotaoNovo(botao) {
        botao.classList.remove('dbtNovo');
        void botao.offsetWidth;                  // reinicia a animação se a classe já estava
        botao.classList.add('dbtNovo');
        const tirar = () => botao.classList.remove('dbtNovo');
        botao.addEventListener('animationend', tirar, { once: true });
        setTimeout(tirar, 800);
    }

    function registrarJanela(janela) {
        if (!janela || !ID_JANELA.test(janela.id) || registro.has(janela.id)) return;

        const botao = document.createElement('button');
        botao.type = 'button';
        botao.dataset.windowId = janela.id;
        marcarBotaoNovo(botao);
        containerBotoes.appendChild(botao);
        registro.set(janela.id, { janela, botao, inicioCarga: null });

        botao.addEventListener('click', () => {
            if (config.cliqueAtivaMinimiza && janelaAtiva() === janela) {
                minimizarJanela(janela);
            } else {
                focarJanela(janela);
            }
        });

        // Botão do meio fecha a janela
        botao.addEventListener('mouseup', (e) => {
            if (e.button === 1 && config.botaoMeioFecha) {
                e.preventDefault();
                fecharJanela(janela);
            }
        });

        botao.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            exibirMenuJanela(e, janela);
        });

        const atualizar = () => atualizarTodosBotoes();
        janela.on({
            activate: atualizar,
            deactivate: atualizar,
            show: atualizar,
            hide: atualizar,
            titlechange: atualizar,
            close: () => lembrarFechada(janela),
            destroy: () => removerJanela(janela.id)
        });

        // Janelas novas: indicador desde o começo. O "load" da tela só chega quando tudo terminou
        // (num relatório, só quando o relatório chega), e logo depois de criada a janela o iframe ainda
        // está vazio, sem endereço. Então vigia até a tela começar a carregar ou terminar.
        const acompanhar = () => {
            adicionarBotaoInicio(janela);
            const info = registro.get(janela.id);
            if (!info) return;
            const inicio = Date.now();
            info.timerVigia = setInterval(() => {
                if (!registro.has(janela.id)) return clearInterval(info.timerVigia);
                atualizarCarregamento(janela.id);
                // O iframe da tela pode nem existir ainda (o portal cria depois de consultar o servidor)
                const iframe = obterIframe(janela);
                let pronto = false;
                try {
                    const doc = iframe && iframe.contentDocument;
                    pronto = !!doc && doc.__barraTarefas && doc.readyState === 'complete';
                } catch (e) {
                    pronto = true;  // outro domínio: não dá para acompanhar
                }
                if (info.inicioCarga || pronto || Date.now() - inicio > 60000) clearInterval(info.timerVigia);
            }, 300);
        };
        if (janela.rendered) {
            acompanhar();
        } else {
            janela.on('render', acompanhar, null, { single: true });
        }

        agendarAtualizacaoBarra();
        botao.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function lembrarFechada(janela) {
        if (janela.__dnfDocumento) {            // documento da OS (blob): reabre o mesmo documento
            fechadas.unshift({ title: janela.title, documento: janela.__dnfDocumento });
            if (fechadas.length > MAX_FECHADAS) fechadas.length = MAX_FECHADAS;
            return;
        }
        const dados = dadosDaJanela(janela);
        if (!dados.url) return;
        fechadas.unshift(dados);
        if (fechadas.length > MAX_FECHADAS) fechadas.length = MAX_FECHADAS;
    }

    function removerJanela(id) {
        const info = registro.get(id);
        if (!info) return;
        clearTimeout(info.timerIndicador);
        clearInterval(info.timerVerificacao);
        clearInterval(info.timerVigia);
        info.botao.remove();
        registro.delete(id);
        // O WindowMgr ativa outra janela depois do destroy; atualiza no próximo ciclo
        agendarAtualizacaoBarra();
    }

    // ---------------------------------------------------------------------------------------------
    // Menus (menus do próprio ExtJS, com o visual do tema do portal)
    // ---------------------------------------------------------------------------------------------

    function item(texto, icone, handler, extra = {}) {
        return { text: texto, iconCls: `dbt-ico dbt-ico-${icone}`, handler, ...extra };
    }

    function itensReabrir() {
        if (!fechadas.length) {
            return [item('Reabrir janela fechada', 'reabrir', null, { disabled: true })];
        }
        return [item('Reabrir janela fechada', 'reabrir', null, {
            menu: {
                items: fechadas.map((dados, i) => ({
                    text: Ext.util.Format.htmlEncode(dados.title || dados.url) +
                          (i === 0 && config.atalhos.reabrir ? `&nbsp;&nbsp;<span style="color:#999">${nomeAtalho(config.atalhos.reabrir)}</span>` : ''),
                    handler: () => reabrirFechada(i)
                }))
            }
        })];
    }

    function itensGerais() {
        return [
            item('Configurações...', 'configuracoes', () => abrirConfiguracoes()),
            ...itemMenuTema(),
            ...itemMenuFonte(),
            item('Notificação de fluxos...', 'sino', abrirConfigFluxos),
            item('Ajuda e aviso', 'ajuda', () => mostrarBoasVindas(true))
        ];
    }

    // Alinha o título do menu com o texto dos itens (o recuo muda de tema para tema)
    function alinharTituloMenu(menu) {
        const titulo = menu.getEl().dom.querySelector('.barraTarefasMenuTitulo');
        const texto = menu.getEl().dom.querySelector('.x-menu-item-text');
        if (!titulo || !texto) return;
        titulo.style.paddingLeft = '0px';
        const recuo = texto.getBoundingClientRect().left - titulo.getBoundingClientRect().left;
        titulo.style.paddingLeft = `${Math.max(0, Math.round(recuo))}px`;
    }

    function mostrarMenu(evento, itens) {
        if (menuContexto) menuContexto.destroy();
        menuContexto = new Ext.menu.Menu({ items: itens });

        // Mostra acima do cursor (a barra fica no rodapé); o ExtJS corrige se não couber na tela
        menuContexto.render(Ext.getBody());
        const altura = menuContexto.getEl().getHeight();
        menuContexto.showAt(menuContexto.getEl().adjustForConstraints([evento.clientX, evento.clientY - altura]));
        alinharTituloMenu(menuContexto);
    }

    function exibirMenuJanela(evento, janela) {
        const titulo = Ext.util.Format.htmlEncode(janela.title || 'Sem título');
        mostrarMenu(evento, [
            `<span class="barraTarefasMenuTitulo">${titulo}</span>`,
            estaMinimizada(janela) ?
                item('Restaurar', 'restaurar', () => focarJanela(janela)) :
                item('Minimizar', 'minimizar', () => minimizarJanela(janela)),
            item('Voltar para o início', 'inicio', () => irParaInicio(janela)),
            item('Duplicar', 'duplicar', () => duplicarJanela(janela)),
            '-',
            item('Fechar', 'fechar', () => fecharJanela(janela)),
            '-',
            ...itensReabrir(),
            item('Configurações...', 'configuracoes', () => abrirConfiguracoes())
        ]);
    }

    function exibirMenuBarra(evento) {
        mostrarMenu(evento, [...itensReabrir(), '-', ...itensGerais()]);
    }

    // Botões do Dealer/Fluxo (ficam visíveis mesmo sem janelas abertas): a engrenagem na barra de status e o
    // sino na barra do alto, logo à direita do botão "Minimiza todas janelas"
    let botaoFluxos = null;

    function posicaoDoSino() {
        const barra = oW5Portal.toolbar;
        if (!barra || !barra.items) return null;
        const indice = barra.items.findIndexBy(i => (i.initialConfig && i.initialConfig.cls === 'minimizeAll') ||
                                                    i.tooltip === 'Minimiza todas janelas');
        return indice >= 0 ? { barra, indice: indice + 1 } : null;
    }

    function adicionarBotoesStatusbar() {
        const barra = oW5Portal.statusbar;
        const indiceMinimizadas = barra.items.findIndex('id', 'W5-minimized-menu');
        const posicao = indiceMinimizadas >= 0 ? indiceMinimizadas + 1 : barra.items.length;

        const menuGeral = new Ext.menu.Menu({
            listeners: {
                beforeshow: (m) => {
                    m.removeAll();
                    m.add(...itensReabrir(), '-', ...itensGerais());
                }
            }
        });

        // A dica do sino (lista dos fluxos) abriria por cima do próprio menu, que desce logo abaixo dele:
        // fica desligada enquanto o menu está aberto
        const dicas = () => (Ext.QuickTips && Ext.QuickTips.getQuickTip && Ext.QuickTips.getQuickTip()) || null;
        const menuFluxos = new Ext.menu.Menu({
            listeners: {
                beforeshow: (m) => preencherMenuFluxos(m),
                show: () => { const q = dicas(); if (q) { q.hide(); q.disable(); } },
                hide: () => { const q = dicas(); if (q) q.enable(); }
            }
        });

        const sino = {
            id: 'barraTarefasBotaoFluxos',
            cls: 'barraTarefasBotaoStatus',
            text: '<i class="fa fa-bell"></i>',
            tooltip: 'Fluxos pendentes',
            hidden: !config.fluxos.ativo,
            menu: menuFluxos
        };
        const engrenagem = {
            id: 'barraTarefasBotaoStatus',
            cls: 'barraTarefasBotaoStatus',
            text: '<i class="fa fa-cog"></i>',
            tooltip: `${NOME_EXIBICAO}: reabrir janelas fechadas e configurações`,
            menu: menuGeral
        };
        const noAlto = posicaoDoSino();
        if (noAlto) {
            noAlto.barra.insertButton(noAlto.indice, sino);
            noAlto.barra.doLayout();
            barra.insertButton(posicao, engrenagem);
        } else {
            // Barra do alto diferente do esperado: os dois ficam juntos na barra de status
            barra.insertButton(posicao, [sino, engrenagem]);
        }
        barra.doLayout();
        botaoFluxos = Ext.getCmp('barraTarefasBotaoFluxos');
    }

    // ---------------------------------------------------------------------------------------------
    // Tutoriais e aviso
    // ---------------------------------------------------------------------------------------------

    // Janelas do script (tutoriais e configurações) crescem com o conteúdo. Em telas pequenas (ex.: 720p)
    // ficariam maiores que a tela e os botões sumiriam: limita ao tamanho da área visível, com rolagem
    // no corpo, e reajusta quando o navegador muda de tamanho.
    function encaixarNaTela(janela) {
        const ajustar = () => {
            if (!janela.rendered || janela.isDestroyed) return;
            const area = Ext.getBody().getViewSize();
            const margem = 8;
            if (!janela.__alturaNatural) janela.__alturaNatural = janela.getHeight();
            const altura = Math.min(janela.__alturaNatural, area.height - 2 * margem);
            if (altura !== janela.getHeight()) {
                janela.autoHeight = false;
                janela.body.setStyle('overflow-y', 'auto');
                janela.setHeight(altura);
            }
            if (janela.getWidth() > area.width - 2 * margem) janela.setWidth(area.width - 2 * margem);
            janela.center();
        };
        ajustar();
        Ext.EventManager.onWindowResize(ajustar);
        janela.on('destroy', () => Ext.EventManager.removeResizeListener(ajustar));
    }

    // Mostra uma janela de tutorial com "Não mostrar novamente". Retorna false se estava oculto.
    function mostrarTutorial(chave, titulo, html, forcar = false) {
        if (!forcar && config.tutoriaisOcultos[chave]) return false;

        const idCaixa = `dbtNaoMostrar_${chave}`;
        const janela = new Ext.Window({
            title: titulo,
            width: 520,
            autoHeight: true,
            modal: true,
            resizable: false,
            cls: 'barraTarefasJanela',
            bodyStyle: 'padding: 12px 14px; background: #fff;',
            html: `<div class="barraTarefasTutorial">${html}</div>`,
            buttonAlign: 'left',
            fbar: [
                {
                    xtype: 'box',
                    autoEl: {
                        tag: 'label',
                        style: 'cursor:pointer; font: 12px arial;',
                        // Marcado por padrão; quem desmarcou (false gravado) continua vendo e a caixa vem desmarcada
                        html: `<input type="checkbox" id="${idCaixa}" style="vertical-align:-2px" ${config.tutoriaisOcultos[chave] !== false ? 'checked' : ''}> Não mostrar novamente`
                    }
                },
                '->',
                { text: 'Entendi', handler: () => janela.close() }
            ],
            listeners: {
                beforeclose: () => {
                    const caixa = document.getElementById(idCaixa);
                    const ocultar = !!(caixa && caixa.checked);
                    if (ocultar !== config.tutoriaisOcultos[chave]) {
                        const novo = copiar(config);
                        novo.tutoriaisOcultos[chave] = ocultar;   // false = quer continuar vendo
                        salvarConfig(novo);
                    }
                }
            }
        });
        janela.show();
        encaixarNaTela(janela);
        return true;
    }

    function mostrarBoasVindas(forcar = false) {
        const atalho = (nome) => config.atalhos[nome] ? `<kbd>${nomeAtalho(config.atalhos[nome], nome === 'numero')}</kbd>` : '(sem atalho)';
        mostrarTutorial('boasVindas', `Bem-vindo ao ${NOME_EXIBICAO}`, `
            <div class="dbtAviso">
                <b>Aviso:</b> o ${NOME_EXIBICAO} não é oficial e não tem relação com a DealerNet. Ele modifica o
                funcionamento do DealerNet e pode causar comportamentos estranhos.<br><br>
                <b>Antes de abrir um chamado com a DealerNet</b>, desative o ${NOME_EXIBICAO} (na página
                de extensões do navegador), recarregue a página e tente fazer a mesma coisa de novo. Se o problema sumir,
                ele é causado pelo ${NOME_EXIBICAO}, e não pelo DealerNet.
            </div>
            <h3>O que ele faz</h3>
            <ul>
                <li>Barra de tarefas no rodapé com as janelas abertas: clique para alternar, arraste para reordenar,
                    botão do meio do mouse fecha.</li>
                <li>Clique direito num botão da barra: minimizar, <i class="fa fa-home"></i> voltar para o início da tela,
                    duplicar, fechar e reabrir janelas fechadas.</li>
                <li>Os avisos em vermelho que o DealerNet mostra no topo das telas aparecem também no meio da tela,
                    com botões para copiar o texto e fechar. Depois de alguns segundos (ou ao fechar) eles vão para
                    um botão "Aviso" no canto da tela; clique nele para ver o aviso de novo.</li>
                <li>Temas de cores (inclusive escuros), fonte e tamanho do texto em <b>Configurações &gt; Tema</b> (versão alfa,
                    desligada por padrão). Depois de aceitar os avisos, dá para trocar direto pela engrenagem, em <b>Tema</b> e <b>Fonte</b>.</li>
                <li>Para abrir uma tela sem passar pelos submenus, clique na lupa <i class="fa fa-search"></i> (na barra de status ou, com
                    janelas abertas, no começo da barra de tarefas) ou use ${atalho('buscaMenu')}, e digite parte do nome, ex.: <b>O.S.</b> ou <b>nota fiscal</b>. Cada resultado mostra
                    onde ele fica no menu, com o módulo em negrito; Enter ou clique abre a tela.</li>
                <li>Listas de opções com muitos itens ganham uma busca: clique em <b>Buscar na lista</b> no alto da lista aberta,
                    no botão &#128269; ao lado da seta ou use ${atalho('buscaLista')}, e digite parte do nome (pode ser mais de uma
                    palavra, e erros de digitação são tolerados). Digitar o começo da opção funciona como antes.</li>
                <li>Na impressão da OS, os documentos marcados (termos, comprovantes) abrem cada um numa janela, prontos para
                    imprimir, em vez de baixar um ZIP (dá para desligar em <b>Configurações &gt; Janelas e telas</b>).</li>
                <li>Indicador de carregamento no botão enquanto uma consulta roda, e um <span style="color:#3c9a46">&#10004;</span>
                    quando ela termina em segundo plano.</li>
                <li>Aviso de novos fluxos na Caixa de Entrada, pelo sino <i class="fa fa-bell"></i> no alto da tela, à direita dos botões
                    das janelas. Vem desligado: ligue pela engrenagem, em <b>Notificação de fluxos...</b></li>
            </ul>
            <h3>Como mudar as configurações</h3>
            <ul>
                <li>Clique na engrenagem <i class="fa fa-cog"></i> na barra de status (canto inferior direito, ao lado de
                    "Minimizadas") e escolha <b>Configurações...</b> ou <b>Notificação de fluxos...</b></li>
                <li>Ou clique com o botão direito numa parte vazia da barra de tarefas.</li>
                <li>Em <b>Configurações</b>, para trocar um atalho clique no campo dele e pressione as teclas desejadas.</li>
            </ul>
            <h3>Atalhos principais</h3>
            <ul>
                <li>Janela da esquerda / direita: ${atalho('anterior')} / ${atalho('proxima')}</li>
                <li>Ir direto para a janela 1 a 9: ${atalho('numero')}</li>
                <li>Minimizar: ${atalho('minimizar')} &nbsp; Voltar para o início: ${atalho('inicio')}</li>
                <li>Reabrir a última janela fechada: ${atalho('reabrir')}</li>
            </ul>
            <p style="margin-top:8px;color:#777">Este aviso pode ser aberto de novo pela engrenagem, em "Ajuda e aviso".</p>
        `, forcar);
    }

    function mostrarTutorialFluxos(forcar = false) {
        return mostrarTutorial('fluxos', 'Como funciona a notificação de fluxos', `
            <ul>
                <li>O ${NOME_EXIBICAO} lê a lista de fluxos da <b>Caixa de Entrada</b> (a tela que aparece logo depois do login, atrás das janelas) e
                    avisa no canto superior direito da tela quando a quantidade de um fluxo aumenta.</li>
                <li>Só os fluxos são considerados. As tarefas dentro deles (ex.: "Confirmar (76)") são ignoradas.</li>
                <li>A Caixa de Entrada é atualizada automaticamente no intervalo configurado. Se ela estiver mostrando outra
                    aba (Definições, Tarefas...), a leitura fica pausada até você voltar para ela.</li>
                <li>O sino <i class="fa fa-bell"></i> no alto da tela (à direita do botão de minimizar todas as janelas) mostra quantos fluxos têm itens pendentes e fica
                    vermelho quando chega algo novo. Clicar num fluxo (no sino ou no aviso) mostra a Caixa de Entrada com
                    esse fluxo marcado.</li>
                <li>Também dá para tocar um som quando chegam fluxos novos, escolhendo entre vários sons e o volume:
                    ative em <b>Configurar notificação de fluxos...</b> (no menu do sino).</li>
                <li>Para fechar o aviso antes do tempo, clique no X, no espaço em branco dele ou, em qualquer lugar,
                    com o botão do meio do mouse.</li>
                <li>Mudar os filtros da Caixa de Entrada (período, assunto, "Visualizar Todos os Fluxos") não gera aviso.</li>
            </ul>
            <h3>Escolhendo os fluxos</h3>
            <ul>
                <li>Na lista <b>Fluxos</b> (no fim da aba), todos vêm marcados. Use <b>Desmarcar todos</b> e marque só os que te interessam.</li>
                <li>Use o filtro para encontrar um fluxo pelo nome ou pelo código (ex.: FLX_Agendamento). Os botões
                    Marcar/Desmarcar todos agem só sobre os fluxos que aparecem no filtro.</li>
                <li>Fluxos que estão na sua Caixa de Entrada agora aparecem primeiro, com a quantidade.</li>
                <li><b>Fluxos personalizados</b>: se o DealerNet ganhar um fluxo novo que não está na lista, digite o
                    código do processo (como aparece em Definições, ex.: FLX_NovoFluxo) ou o nome exatamente como aparece
                    na Caixa de Entrada (sem a quantidade) e clique em Adicionar.</li>
            </ul>
        `, forcar);
    }

    // ---------------------------------------------------------------------------------------------
    // Tema de cores (Dealer/Tema): o motor é uma biblioteca separada (window.DealerTema, carregada antes deste
    // script); aqui fica só a aba "Tema" das configurações. Em alfa: desligado por padrão ("Original").
    // A escolha fica no localStorage do site (chave DealerTema.config), gravada pelo próprio motor.
    // ---------------------------------------------------------------------------------------------

    // Pergunta Sim/Não em português (o Ext.Msg.confirm do portal vem com Yes/No)
    function confirmar(titulo, texto, depois) {
        Ext.Msg.show({ title: titulo, msg: texto, buttons: { yes: 'Sim', no: 'Não' }, icon: Ext.MessageBox.QUESTION, fn: depois });
    }

    function apiTema() {
        const T = window.DealerTema;
        return T && typeof T.definir === 'function' && typeof T.esquemas === 'function' ? T : null;
    }

    // Quem já usava o Dealer/Tema separado (tema, fonte ou tamanho gravados) conta como quem aceitou o aviso
    function temaLiberado() {
        if (config.temaAlfaAceito) return true;
        const T = apiTema();
        return !!T && T.config().tema !== 'off';
    }

    function fontesDisponiveis() {
        const T = apiTema();
        return !!T && typeof T.fontes === 'function' && typeof T.tamanhos === 'function';
    }

    function fonteLiberada() {
        if (!fontesDisponiveis()) return false;
        if (config.temaFonteAceita) return true;
        const c = apiTema().config();
        return (c.fonte && c.fonte !== 'original') || (c.tamanho && c.tamanho !== 100);
    }

    // Tamanhos oferecidos: os sugeridos pela biblioteca, os limites e o atual
    function tamanhosFonte() {
        const T = apiTema(), t = T.tamanhos(), atual = T.config().tamanho;
        return [...new Set([...t.sugeridos, t.min, t.max, atual])].filter(n => n >= t.min && n <= t.max).sort((a, b) => a - b);
    }
    const nomeTamanho = (n) => n + '%' + (n === 100 ? ' (original)' : '');

    function htmlConfigTema() {
        const T = apiTema();
        if (!T) return '';
        const c = T.config(), esquemas = T.esquemas();
        const html = Ext.util.Format.htmlEncode;
        const op = (id, nome, sel) => `<option value="${html(id)}"${id === sel ? ' selected' : ''}>${html(nome)}</option>`;
        const escuros = esquemas.filter(e => e.escuro), claros = esquemas.filter(e => !e.escuro);
        const grupo = (titulo, lista, sel) => lista.length ? `<optgroup label="${titulo}">${lista.map(e => op(e.id, e.nome, sel)).join('')}</optgroup>` : '';
        const caixa = (nome, marcado) => `<input type="checkbox" name="${nome}" ${marcado ? 'checked' : ''}>`;
        const liberado = temaLiberado();
        const depuracao = !!config.temaDepuracaoAceita;
        let htmlFontes = '';
        if (fontesDisponiveis()) {
            const fontes = T.fontes();
            htmlFontes = `
                <fieldset>
                    <legend>Fonte</legend>
                    <div class="dbtAvisoAlfa">&#9888; <b>Pode desarrumar as telas.</b> O DealerNet foi feito para a fonte e o tamanho
                        originais. Outra fonte, ou um tamanho maior, pode cortar textos (em botões, títulos e colunas estreitas)
                        e desarrumar o layout de algumas telas. Se algo ficar ruim, volte para "Original do site" e 100%.
                        <label class="dbtAceite"><input type="checkbox" name="temaFonteAceita" ${fonteLiberada() ? 'checked' : ''}>
                            Entendi, liberar a troca de fonte e tamanho</label></div>
                    <table>
                        <tr><td>Fonte do texto</td>
                            <td><select name="temaFonte" class="dbtSelectTema">${op('original', 'Original do site', c.fonte)}
                                ${grupo('Do sistema', fontes.filter(f => f.tipo === 'sistema'), c.fonte)}${grupo('Da internet', fontes.filter(f => f.tipo === 'web'), c.fonte)}</select></td></tr>
                        <tr><td>Tamanho do texto</td>
                            <td><select name="temaTamanho">${tamanhosFonte().map(n => op(String(n), nomeTamanho(n), String(c.tamanho))).join('')}</select></td></tr>
                    </table>
                    <div class="dbtDica">Valem também com o tema de cores "Original". As fontes "da internet" são baixadas uma vez
                        (Bunny Fonts) e ficam guardadas no navegador.</div>
                </fieldset>`;
        }
        return `
                <div class="dbtAbaPainel" data-painel="tema">
                <div class="dbtAvisoAlfa">&#9888; <b>Versão alfa.</b> O tema ainda está em testes: alguns ícones podem faltar
                    ou estar errados, e algumas telas podem ficar com cores estranhas ou difíceis de ler. Pode demorar até
                    ficar estável. Se algo atrapalhar, volte para "Original (sem tema)".
                    <label class="dbtAceite"><input type="checkbox" name="temaAlfaAceito" ${liberado ? 'checked' : ''}>
                        Entendi, quero usar o tema mesmo assim</label></div>
                <fieldset class="dbtTemaBloqueavel">
                    <legend>Tema de cores</legend>
                    <table>
                        <tr><td>Tema</td>
                            <td><select name="temaEsquema" class="dbtSelectTema">${op('off', 'Original (sem tema)', c.tema)}${op('auto', 'Automático (segue o sistema)', c.tema)}
                                ${grupo('Escuros', escuros, c.tema)}${grupo('Claros', claros, c.tema)}</select></td></tr>
                        <tr class="dbtTemaAuto"><td>... tema claro no automático</td>
                            <td><select name="temaClaro" class="dbtSelectTema">${claros.map(e => op(e.id, e.nome, c.claro)).join('')}</select></td></tr>
                        <tr class="dbtTemaAuto"><td>... tema escuro no automático</td>
                            <td><select name="temaEscuro" class="dbtSelectTema">${escuros.map(e => op(e.id, e.nome, c.escuro)).join('')}</select></td></tr>
                        <tr><td>Trocar as imagens do site por botões e ícones</td>
                            <td>${caixa('temaImagens', c.imagens)}</td></tr>
                        <tr><td>Enviar automaticamente as imagens sem ícone, para ajudar a completar o tema (opcional; só com as
                                estatísticas de uso ligadas, na aba Privacidade)<span class="dbtSemIconeFirefox"></span></td>
                            <td>${caixa('telemetriaSemIcone', config.telemetriaSemIcone)}</td></tr>
                    </table>
                    <button type="button" class="dbtBotao" data-tema-semicone>Imagens sem ícone...</button>
                    <div class="dbtDica">As mudanças valem na hora; Cancelar volta ao que estava antes. "Imagens sem ícone": imagens do site
                        que o tema ainda não sabe trocar, para copiar e enviar a quem mantém o tema.</div>
                </fieldset>
                ${htmlFontes}
                <fieldset class="dbtTemaBloqueavel">
                    <legend>Depuração</legend>
                    <div class="dbtAvisoDepuracao">&#9888; <b>Para desenvolvedores.</b> Estas opções servem para encontrar problemas no
                        tema, não para o uso do dia a dia. Só use se souber o que está fazendo: os botões que o site esconde
                        <b>funcionam</b> ao clicar e podem fazer ações que o sistema não permite naquela situação (por exemplo,
                        alterar ou excluir registros).
                        <label class="dbtAceite"><input type="checkbox" name="temaDepuracaoAceita" ${depuracao ? 'checked' : ''}>
                            Sei o que estou fazendo, liberar as opções de depuração</label></div>
                    <table>
                        <tr><td>Mostrar a imagem original ao passar o mouse num botão trocado</td>
                            <td>${caixa('temaDebug', c.debug)}</td></tr>
                        ${'ocultos' in c ? `<tr><td>Mostrar os botões que o site esconde (tracejados e esmaecidos)</td>
                            <td>${caixa('temaOcultos', c.ocultos)}</td></tr>` : ''}
                    </table>
                    <div class="dbtDica">Só valem com um tema de cores ligado. Dealer/Tema ${html(T.versao || '')}.</div>
                </fieldset>
                </div>`;
    }

    // Liga os campos da aba. Cada mudança vale na hora (o usuário vê o resultado enquanto escolhe); Cancelar ou
    // fechar a janela sem salvar volta ao que estava. As caixas de aceite liberam os campos; desmarcar volta ao
    // padrão. Devolve { ler, reverter, aceites } (ou null se o motor não carregou).
    function configurarFormTema(raiz) {
        const T = apiTema();
        if (!T || !raiz.querySelector('[data-painel="tema"]')) return null;
        const original = T.config();
        const campo = (nome) => raiz.querySelector(`[name="${nome}"]`);
        const aceiteAlfa = campo('temaAlfaAceito'), aceiteDepuracao = campo('temaDepuracaoAceita'), aceiteFonte = campo('temaFonteAceita');
        const depuracao = ['temaDebug', 'temaOcultos'].map(campo).filter(Boolean);
        const camposFonte = ['temaFonte', 'temaTamanho'].map(campo).filter(Boolean);

        const ler = () => {
            const escolha = {
                tema: campo('temaEsquema').value,
                claro: campo('temaClaro').value,
                escuro: campo('temaEscuro').value,
                imagens: campo('temaImagens').checked,
                debug: campo('temaDebug').checked
            };
            if (campo('temaOcultos')) escolha.ocultos = campo('temaOcultos').checked;
            if (campo('temaFonte')) {
                escolha.fonte = campo('temaFonte').value;
                escolha.tamanho = Number(campo('temaTamanho').value);
            }
            return escolha;
        };
        const aplicarAgora = () => aplicarEscolhaTema(ler());
        const mostrarAuto = () => raiz.querySelectorAll('.dbtTemaAuto').forEach(l => {
            l.style.display = campo('temaEsquema').value === 'auto' ? '' : 'none';
        });
        const bloquear = () => {
            raiz.querySelectorAll('[data-painel="tema"] fieldset.dbtTemaBloqueavel').forEach(f => { f.disabled = !aceiteAlfa.checked; });
            depuracao.forEach(c => { c.disabled = !aceiteAlfa.checked || !aceiteDepuracao.checked; });
            camposFonte.forEach(c => { c.disabled = !aceiteFonte.checked; });
        };

        aceiteAlfa.addEventListener('change', () => {
            if (!aceiteAlfa.checked) {                      // desistiu: volta tudo ao visual original do site
                campo('temaEsquema').value = 'off';
                aceiteDepuracao.checked = false;
                depuracao.forEach(c => { c.checked = false; });
                mostrarAuto();
                aplicarAgora();
            }
            bloquear();
        });
        if (aceiteFonte) {
            aceiteFonte.addEventListener('change', () => {
                if (!aceiteFonte.checked) {                 // desistiu: fonte e tamanho originais
                    campo('temaFonte').value = 'original';
                    campo('temaTamanho').value = '100';
                    aplicarAgora();
                }
                bloquear();
            });
        }
        aceiteDepuracao.addEventListener('change', () => {
            if (!aceiteDepuracao.checked && depuracao.some(c => c.checked)) {
                depuracao.forEach(c => { c.checked = false; });
                aplicarAgora();
            }
            bloquear();
        });
        campo('temaEsquema').addEventListener('change', () => { mostrarAuto(); aplicarAgora(); });
        ['temaClaro', 'temaEscuro', 'temaImagens', 'temaFonte', 'temaTamanho', 'temaDebug', 'temaOcultos']
            .map(campo).filter(Boolean).forEach(c => c.addEventListener('change', aplicarAgora));

        mostrarAuto();
        bloquear();
        raiz.querySelector('[data-tema-semicone]').addEventListener('click', abrirSemIcone);
        return {
            ler,
            mudancas: () => {
                const e = ler();
                return { tema: e.tema !== original.tema, fonte: 'fonte' in e && (e.fonte !== original.fonte || e.tamanho !== original.tamanho) };
            },
            reverter: () => aplicarEscolhaTema(original),
            aceites: () => ({ temaAlfaAceito: aceiteAlfa.checked, temaDepuracaoAceita: aceiteAlfa.checked && aceiteDepuracao.checked,
                              temaFonteAceita: !!(aceiteFonte && aceiteFonte.checked) })
        };
    }

    // Submenu "Tema" da engrenagem (só depois de aceitar o aviso de versão alfa): troca o tema na hora
    function itemMenuTema() {
        const T = apiTema();
        if (!T || !temaLiberado()) return [];
        const atual = T.config().tema, esquemas = T.esquemas();
        const opcao = (id, nome) => new Ext.menu.CheckItem({
            text: nome, checked: atual === id, group: 'dbtTema', itemId: `dbtTema-${id}`,
            handler: () => { if (id !== atual) contarTelemetria('temaMenu'); aplicarEscolhaTema({ tema: id }); }
        });
        const grupo = (titulo) => new Ext.menu.TextItem({ text: titulo, cls: 'dbtMenuGrupo' });
        return [{
            text: 'Tema',
            iconCls: 'dbt-ico dbt-ico-tema',
            hideOnClick: false,
            menu: {
                items: [
                    opcao('off', 'Original (sem tema)'),
                    opcao('auto', 'Automático (segue o sistema)'),
                    '-', grupo('Escuros'), ...esquemas.filter(e => e.escuro).map(e => opcao(e.id, e.nome)),
                    '-', grupo('Claros'), ...esquemas.filter(e => !e.escuro).map(e => opcao(e.id, e.nome)),
                    '-', item('Opções do tema...', 'configuracoes', () => abrirConfiguracoes('tema'))
                ]
            }
        }];
    }

    // Submenu "Fonte" da engrenagem (só depois de aceitar o aviso de fonte): fonte e tamanho na hora
    function itemMenuFonte() {
        if (!fonteLiberada()) return [];
        const T = apiTema(), c = T.config(), fontes = T.fontes();
        const opcao = (id, nome) => new Ext.menu.CheckItem({
            text: nome, checked: c.fonte === id, group: 'dbtFonte', handler: () => { if (id !== c.fonte) contarTelemetria('fonteMenu'); aplicarEscolhaTema({ fonte: id }); }
        });
        const grupo = (titulo, tipo) => {
            const lista = fontes.filter(f => f.tipo === tipo);
            return lista.length ? ['-', new Ext.menu.TextItem({ text: titulo, cls: 'dbtMenuGrupo' }), ...lista.map(f => opcao(f.id, f.nome))] : [];
        };
        const tamanhos = tamanhosFonte().map(n => new Ext.menu.CheckItem({
            text: nomeTamanho(n), checked: c.tamanho === n, group: 'dbtTamanho', handler: () => { if (n !== c.tamanho) contarTelemetria('fonteMenu'); aplicarEscolhaTema({ tamanho: n }); }
        }));
        return [{
            text: 'Fonte',
            iconCls: 'dbt-ico dbt-ico-fonte',
            hideOnClick: false,
            menu: {
                items: [
                    { text: 'Tamanho do texto', hideOnClick: false, menu: { items: tamanhos } },
                    '-',
                    opcao('original', 'Original do site'),
                    ...grupo('Do sistema', 'sistema'),
                    ...grupo('Da internet', 'web'),
                    '-', item('Opções de fonte...', 'configuracoes', () => abrirConfiguracoes('tema'))
                ]
            }
        }];
    }

    // Aplica na hora, em todas as janelas e telas (o motor cuida disso); só chama se algo mudou
    function aplicarEscolhaTema(escolha) {
        const T = apiTema();
        if (!T || !escolha) return;
        const atual = T.config();
        if (Object.keys(escolha).some(k => atual[k] !== escolha[k])) T.definir(escolha);
    }

    function abrirSemIcone() {
        const T = apiTema();
        if (!T) return;
        const texto = T.semIconeTexto() || '';
        const quantidade = texto ? texto.split('\n').length : 0;
        const html = Ext.util.Format.htmlEncode;
        const janela = new Ext.Window({
            title: 'Imagens sem ícone (Dealer/Tema)',
            width: 640,
            autoHeight: true,
            modal: true,
            resizable: false,
            cls: 'barraTarefasJanela',
            bodyStyle: 'padding: 10px; background: #fff;',
            html: `<div class="barraTarefasConfig">
                       <div class="dbtDica" style="margin: 0 0 6px">${quantidade ?
                           `${quantidade} ${quantidade === 1 ? 'imagem' : 'imagens'}, uma por linha: arquivo | dica | tela | situação. Copie e envie para quem mantém o tema.` :
                           'Nenhuma imagem anotada ainda. Navegue pelas telas com um tema ligado e volte aqui.'}</div>
                       <textarea class="dbtSemIcone" readonly wrap="off">${html(texto)}</textarea>
                   </div>`,
            buttonAlign: 'right',
            buttons: [
                {
                    text: 'Copiar',
                    disabled: !quantidade,
                    handler: (botao) => {
                        copiarTexto(document, texto).then(() => botao.setText('Copiado!'), () => botao.setText('Não consegui copiar'));
                        setTimeout(() => { if (!botao.isDestroyed) botao.setText('Copiar'); }, 1800);
                    }
                },
                {
                    text: 'Limpar lista',
                    disabled: !quantidade,
                    handler: () => confirmar('Limpar lista', 'Apagar a lista de imagens sem ícone?', (resposta) => {
                        if (resposta === 'yes') {
                            T.limparSemIcone();
                            janela.close();
                        }
                    })
                },
                { text: 'Fechar', handler: () => janela.close() }
            ]
        });
        janela.show();
        encaixarNaTela(janela);
    }

    // ---------------------------------------------------------------------------------------------
    // Telemetria: estatísticas de uso anônimas, no máximo um envio por dia, feito pelo fundo da extensão
    // (extensao/src/background.js). Daqui só saem as configurações combinadas (tema, fonte, altura da barra,
    // faixa da largura da tela, domínio padrão ou não) e quantas vezes o tema/a fonte foram trocados; o fundo
    // filtra de novo por uma lista fixa de campos. A página fala com o fundo por eventos no document, que a
    // ponte (telemetria-ponte.js, mundo isolado) repassa. Sem a extensão (testes rápidos) nada é enviado.
    // ---------------------------------------------------------------------------------------------

    const ENDERECO_PRIVACIDADE = 'https://dealer-fluxo-ping.igorslime.workers.dev/privacidade';

    // ---------------------------------------------------------------------------------------------
    // Aba "Sobre": versões, autor, contato e doação opcional por Pix (QR code e "copia e cola"). Só aparece nessa aba:
    // nada é cobrado, nada depende disso e nenhum aviso pede doação.
    // ---------------------------------------------------------------------------------------------
    // ==== Pix (gerado por extensao/gerar_pix.py, não editar aqui) ====
    const PIX_COPIA_E_COLA = '00020126580014BR.GOV.BCB.PIX01367cd8e5d6-030c-487a-b111-ea27ee04777e5204000053039865802BR5918Igor Lima Sant Ana6009SAO PAULO621405104XrDyyVUOS6304A637';
    const PIX_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAOQAAADkAQAAAACgLLUgAAACX0lEQVR42u2ZS24DMQxDeQPd/5a6gSqSns6ki+4YoEWCAjPx80LRl3Yxv3waH/r3KYBCo7uAruG3KS6Gae1fVc/u4Ap3o7iYpvteejZfl62BfHsDXWesPUW81qyJb6K7ON3rDhCdxTQdrdAFxdXdVvMSowxVsH9+XnIyQ1VPGwcGYbTYNOpRgxla7ex2xoGRn7ZbolSF7RBUqb6ZDcCEqbzA377ZZnvADV1pSgPAXKN9LLPiA2kK9ZTmEuSK0mPydF2w/YQvG3ztpGUTpqXFZpJrYLDE0ZdVQTpqYfwuy5x5XWkqa5jn7TxQkWtLlmLUSPitWNuaHNyfpjhCoLmT6ce0R5wy7vrxtklIjTVM1TsZeXYVQN1l8N29Y1TxL8BZBzmi7i4ao1Rd9rqGBtrWXd0sRllPFEGn4Ni4p+5pFaPQeGxVNceUsv2ushiV6GnZ4hc1uDrRz1ErHkZDBvbR149sD1FNjaNIlOZVD62So64pPyiwR9O50pRx0NnpjEfgtNYwbU8mtxEpIKmCW/WF6Ck1677LSFwgR+Fji2e0hqSa6nfPSVGtc1UqxCeLUTcPU0kCT0eJH57RmQ5hqtjLBVbadENZDEYprD3avQw61UiahKkdQEWiWwEJQKddljoAOApM3lFCVJpCPVRDi/FXyk/FKXvIfdHjMwUep6cUnTk3XCccSgM6I0x9qybp4wPbSGK/3LklqFsI00xRV3Er8dPUB1NcKW/Z+x4KX1zyYg1OwX4LbZ3/eWqDDud9d+8c1QWab0Cqj8yshwoKUd2qSeSqwpR8uuwK089/Af4x/QIu/YZ7lsr5mQAAAABJRU5ErkJggg==';   // versão 8, correção M
    const PIX_QR_TAMANHO = 228;   // px, mostrado sem redimensionar
    // ==== fim do Pix ====

    function htmlConfigSobre() {
        const T = apiTema();
        return `
                <div class="dbtAbaPainel" data-painel="sobre">
                <div class="dbtSobre">
                    <div class="dbtSobreNome">${NOME_EXIBICAO}</div>
                    <div class="dbtSobreVersoes">Versão ${VERSAO_FLUXO}${T && T.versao ? ` &nbsp;·&nbsp; Dealer/Tema ${T.versao}` : ''}</div>
                    <p>Esta janela é do <b>${NOME_EXIBICAO}</b>, uma extensão gratuita e não oficial para o DealerNet Workflow,
                        desenvolvida por <b>Igor Lima</b>. Ela não tem relação com a DealerNet.</p>
                    <p>Dúvidas, sugestões ou problemas: <a href="mailto:${CONTATO}">${CONTATO}</a></p>
                    <p class="dbtDica">Código sob a licença GPL-3.0. <a href="${ENDERECO_PRIVACIDADE}" target="_blank" rel="noopener">Política de privacidade</a>.</p>
                </div>
                <fieldset class="dbtDoacoes">
                    <legend>Doações</legend>
                    <p>Se o ${NOME_EXIBICAO} facilita o seu dia, considere fazer uma doação. É totalmente opcional e pode ser de
                        qualquer valor. <b>Nenhum recurso vai ficar bloqueado por doação:</b> tudo o que existe hoje, e o que vier
                        depois, continua gratuito para todos.</p>
                    <img class="dbtPixQr" alt="QR code do Pix" width="${PIX_QR_TAMANHO}" height="${PIX_QR_TAMANHO}">
                    <p class="dbtCentro">Aponte a câmera do celular (ou o app do banco) para o QR code, ou use o Pix copia e cola:</p>
                    <div class="dbtPixCopia">
                        <input type="text" readonly class="dbtPixCodigo" aria-label="Pix copia e cola">
                        <button type="button" class="dbtBotao" data-copiar-pix>Copiar</button>
                    </div>
                    <p class="dbtDica dbtCentro">Obrigado! &#128578;</p>
                </fieldset>
                </div>`;
    }

    function configurarSobre(raiz) {
        const qr = raiz.querySelector('.dbtPixQr');
        const codigo = raiz.querySelector('.dbtPixCodigo');
        const botao = raiz.querySelector('[data-copiar-pix]');
        if (!qr || !codigo || !botao) return;
        qr.src = PIX_QR;
        codigo.value = PIX_COPIA_E_COLA;
        codigo.addEventListener('focus', () => codigo.select());
        botao.addEventListener('click', () => {
            copiarTexto(document, PIX_COPIA_E_COLA).then(() => { botao.textContent = 'Copiado!'; },
                                                          () => { botao.textContent = 'Não consegui copiar'; });
            setTimeout(() => { botao.textContent = 'Copiar'; }, 1800);
        });
    }

    function mensagemTelemetria(dados) {
        try {
            document.dispatchEvent(new CustomEvent('dealerfluxo:telemetria', { detail: JSON.stringify(dados) }));
        } catch (e) { /* sem a ponte: nada a fazer */ }
    }

    // Pergunta ao fundo da extensão; responde null se ele não responder (sem a extensão, por exemplo)
    function pedirTelemetria(tipo, extra = {}, limite = 2500) {
        return new Promise((resolver) => {
            const id = `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
            const ouvir = (evento) => {
                let r;
                try { r = JSON.parse(evento.detail); } catch (e) { return; }
                if (!r || r.id !== id) return;
                document.removeEventListener('dealerfluxo:telemetria-resposta', ouvir);
                clearTimeout(timer);
                resolver(r.resposta);
            };
            const timer = setTimeout(() => {
                document.removeEventListener('dealerfluxo:telemetria-resposta', ouvir);
                resolver(null);
            }, limite);
            document.addEventListener('dealerfluxo:telemetria-resposta', ouvir);
            mensagemTelemetria({ tipo, id, ...extra });
        });
    }

    function faixaTela() {
        const largura = (window.screen && window.screen.width) || window.innerWidth;
        return largura <= 1366 ? '1366' : largura <= 1680 ? '1600' : largura <= 1920 ? '1920' : 'maior';
    }

    function estadoTelemetria() {
        const T = apiTema();
        const dados = {
            tela: faixaTela(),
            dominio: /(^|\.)dealernetworkflow\.com\.br$/i.test(location.hostname) ? 'padrao' : 'outro',
            alturaBarra: config.alturaBarra
        };
        let versaoTema, semIconeItens;
        if (T) {
            const c = T.config();
            Object.assign(dados, { tema: c.tema, imagens: c.imagens !== false });
            if ('fonte' in c) Object.assign(dados, { fonte: c.fonte, tamanho: c.tamanho });
            versaoTema = T.versao;
            if (config.telemetria && config.telemetriaSemIcone && typeof T.semIcone === 'function') {
                semIconeItens = T.semIcone().map(e => [e.arquivo, e.dica, e.tela, e.situacao]);
            }
        }
        return { tipo: 'estado', ativo: !!config.telemetria, semIcone: !!(config.telemetria && config.telemetriaSemIcone),
                 dados, versaoTema, semIconeItens };
    }

    let timerEstadoTelemetria = 0;
    function enviarEstadoTelemetria() {
        clearTimeout(timerEstadoTelemetria);
        timerEstadoTelemetria = setTimeout(() => mensagemTelemetria(estadoTelemetria()), 1000);
    }

    function contarTelemetria(nome) {
        if (config.telemetria) mensagemTelemetria({ tipo: 'contar', nome });
    }

    function iniciarTelemetria() {
        enviarEstadoTelemetria();
        setInterval(enviarEstadoTelemetria, 10 * 60 * 1000);   // a lista de imagens sem ícone cresce enquanto navega
        const T = apiTema();
        if (T && typeof T.aoMudar === 'function') T.aoMudar(enviarEstadoTelemetria);
    }

    // Texto curto do que vai e do que não vai (aviso, aba Privacidade)
    const TEXTO_TELEMETRIA = `
        <p>Uma vez por dia, o ${NOME_EXIBICAO} envia estatísticas de uso <b>anônimas</b>: versão, navegador, sistema,
            faixa da largura da tela, se o DealerNet está no endereço padrão, altura da barra e as escolhas de tema e fonte.
            Servem para saber quantas pessoas usam e como melhorar a extensão.</p>
        <p><b>Nunca</b> são enviados: usuário, empresa, endereço do DealerNet, conteúdo das telas, mensagens, buscas,
            nenhum identificador nem o IP.</p>`;

    // Aviso de uma vez só (novos usuários e quem atualizou), com a opção ali mesmo
    // forcar (menu Tutoriais das configurações): só o texto; a opção fica na aba Privacidade da própria janela
    function mostrarAvisoTelemetria(forcar = false) {
        if (forcar === true) {
            const janela = new Ext.Window({
                title: 'Estatísticas de uso anônimas', width: 520, autoHeight: true, modal: true, resizable: false,
                cls: 'barraTarefasJanela', bodyStyle: 'padding: 12px 14px; background: #fff;',
                html: `<div class="barraTarefasTutorial">${TEXTO_TELEMETRIA}
                           <p style="color:#777">Para ligar ou desligar, use a aba Privacidade das configurações.
                               <a href="${ENDERECO_PRIVACIDADE}" target="_blank" rel="noopener">Política de privacidade</a></p></div>`,
                buttonAlign: 'right',
                buttons: [{ text: 'OK', handler: () => janela.close() }]
            });
            janela.show();
            encaixarNaTela(janela);
            return;
        }
        if (config.tutoriaisOcultos.privacidade) return;
        const janela = new Ext.Window({
            title: 'Estatísticas de uso anônimas',
            width: 520,
            autoHeight: true,
            modal: true,
            resizable: false,
            cls: 'barraTarefasJanela',
            bodyStyle: 'padding: 12px 14px; background: #fff;',
            html: `<div class="barraTarefasTutorial">${TEXTO_TELEMETRIA}
                       <label class="dbtAceiteTelemetria"><input type="checkbox" id="dbtAvisoTelemetria" ${config.telemetria ? 'checked' : ''}>
                           Enviar estatísticas de uso anônimas</label>
                       <p style="color:#777">Dá para mudar depois em ⚙ &gt; Configurações &gt; Privacidade.
                           <a href="${ENDERECO_PRIVACIDADE}" target="_blank" rel="noopener">Política de privacidade</a></p></div>`,
            buttonAlign: 'right',
            buttons: [{ text: 'OK', handler: () => janela.close() }],
            listeners: {
                beforeclose: () => {
                    const caixa = document.getElementById('dbtAvisoTelemetria');
                    const novo = copiar(config);
                    novo.telemetria = !!(caixa && caixa.checked);
                    novo.tutoriaisOcultos.privacidade = true;
                    salvarConfig(novo);
                }
            }
        });
        janela.show();
        encaixarNaTela(janela);
    }

    // Mostra quando nenhuma outra janela do Dealer/Fluxo (boas-vindas, configurações) estiver aberta
    function quandoSemJanelas(fn) {
        const timer = setInterval(() => {
            if (document.querySelector('.x-window.barraTarefasJanela')) return;
            clearInterval(timer);
            fn();
        }, 1000);
    }

    function htmlConfigPrivacidade() {
        return `
                <div class="dbtAbaPainel" data-painel="privacidade">
                <fieldset>
                    <legend>Estatísticas de uso anônimas</legend>
                    <div class="dbtTextoPrivacidade">${TEXTO_TELEMETRIA}</div>
                    <table>
                        <tr><td>Enviar estatísticas de uso anônimas (uma vez por dia)</td>
                            <td><input type="checkbox" name="telemetria" ${config.telemetria ? 'checked' : ''}></td></tr>
                    </table>
                    <div class="dbtSituacaoTelemetria dbtDica"></div>
                    <button type="button" class="dbtBotao" data-telemetria-previa>Ver o que será enviado</button>
                    <a href="${ENDERECO_PRIVACIDADE}" target="_blank" rel="noopener">Política de privacidade</a>
                    <div class="dbtDica">O que é de hoje só é enviado a partir de amanhã. Desligar apaga o que ainda não foi enviado.
                        A opção de enviar as imagens sem ícone do tema fica na aba Tema.</div>
                </fieldset>
                </div>`;
    }

    // Situação vinda do fundo da extensão: empresa desligou, Firefox não permite, sem a extensão
    function configurarPrivacidade(raiz) {
        const situacao = raiz.querySelector('.dbtSituacaoTelemetria');
        const caixa = raiz.querySelector('[name="telemetria"]');
        const semIconeNota = raiz.querySelector('.dbtSemIconeFirefox');
        pedirTelemetria('situacao').then((c) => {
            if (!situacao || !raiz.isConnected) return;
            if (!c) {
                situacao.textContent = 'Sem a extensão do navegador, nada é enviado.';
                return;
            }
            if (c.bloqueadoEmpresa) {
                situacao.textContent = 'Desligado pela empresa (política do navegador).';
                if (caixa) caixa.disabled = true;
            } else if (c.firefox && !c.uso) {
                situacao.textContent = 'O Firefox não está permitindo o envio (about:addons > Dealer/Fluxo > Permissões).';
            }
            if (semIconeNota && c.firefox && !c.semIcone && !c.bloqueadoEmpresa) {
                semIconeNota.innerHTML = ' No Firefox, também é preciso permitir: <a href="#" data-abrir-opcoes>abrir as opções da extensão</a>.';
            }
        });
        raiz.addEventListener('click', (e) => {
            if (e.target.closest('[data-abrir-opcoes]')) {
                e.preventDefault();
                mensagemTelemetria({ tipo: 'abrirOpcoes' });
            }
        });
        const previa = raiz.querySelector('[data-telemetria-previa]');
        if (previa) previa.addEventListener('click', mostrarPreviaTelemetria);
    }

    async function mostrarPreviaTelemetria() {
        mensagemTelemetria(estadoTelemetria());                    // o fundo guarda o estado de agora antes
        await new Promise(r => setTimeout(r, 300));
        const previa = await pedirTelemetria('previa');
        const html = Ext.util.Format.htmlEncode;
        let corpo;
        if (!previa) {
            corpo = '<p>Sem a extensão do navegador, nada é enviado.</p>';
        } else if (!previa.ativo) {
            corpo = '<p>As estatísticas de uso estão desligadas: nada será enviado.</p>';
        } else {
            const partes = { estatisticas: previa.ping, imagensSemIcone: previa.semIcone || undefined };
            corpo = `<p class="dbtDica" style="margin:0 0 6px">Para <b>${html(previa.endereco)}</b>, um envio por dia
                         (os dados de hoje vão a partir de amanhã). Exatamente isto:</p>
                     <textarea class="dbtSemIcone" readonly wrap="off">${html(JSON.stringify(partes, null, 2))}</textarea>`;
        }
        const janela = new Ext.Window({
            title: 'O que será enviado',
            width: 640,
            autoHeight: true,
            modal: true,
            resizable: false,
            cls: 'barraTarefasJanela',
            bodyStyle: 'padding: 10px; background: #fff;',
            html: `<div class="barraTarefasConfig">${corpo}</div>`,
            buttonAlign: 'right',
            buttons: [{ text: 'Fechar', handler: () => janela.close() }]
        });
        janela.show();
        encaixarNaTela(janela);
    }

    // ---------------------------------------------------------------------------------------------
    // Janela de configurações
    // ---------------------------------------------------------------------------------------------

    // Aba Barra: aparência dos botões, com uma barra de exemplo que muda na hora (a barra de verdade também)
    function htmlAparenciaBotoes() {
        const opcoes = (mapa, atual) => Object.entries(mapa).map(([valor, nome]) =>
            `<option value="${valor}" ${valor === atual ? 'selected' : ''}>${nome}</option>`).join('');
        const linha = (titulo, nome, mapa) => `<tr><td>${titulo}</td>
            <td><select name="${nome}" class="dbtSelectAparencia">${opcoes(mapa, config[nome])}</select></td></tr>`;
        const prontos = Object.fromEntries(Object.entries(PREDEFINICOES_BOTAO).map(([k, v]) => [k, v[0]]));
        const exemplo = [['Cadastro de Pessoas', 'ativo'], ['Pesquisas', ''], ['Títulos Emitidos a Receber', 'carregando'],
                         ['Empresa', 'concluido'], ['Ordem de Serviço', 'botaoMinimizado']];
        return `
                <fieldset>
                    <legend>Aparência dos botões</legend>
                    <table>
                        <tr><td>Estilo pronto</td>
                            <td><select name="botaoPronto" class="dbtSelectAparencia">
                                <option value="">Personalizado</option>${opcoes(prontos, predefinicaoAtual(config))}</select></td></tr>
                        ${linha('Formato', 'botaoFormato', FORMATOS_BOTAO)}
                        ${linha('Preenchimento', 'botaoEstilo', ESTILOS_BOTAO)}
                        ${linha('Janela ativa', 'botaoAtivo', ATIVOS_BOTAO)}
                        ${linha('Ao passar o mouse', 'botaoPassarMouse', PASSAR_MOUSE_BOTAO)}
                        ${linha('Ao abrir uma janela', 'botaoAbertura', ABERTURAS_BOTAO)}
                    </table>
                    <div class="dbtPreviaFundo"><div class="dbtPreviaBarra"><button type="button" class="dbtIniciar" title="Buscar no menu"><i class="fa fa-search"></i></button>${exemplo.map(([titulo, classe]) =>
                        `<button type="button" class="${classe}" data-iniciais="${iniciaisTitulo(titulo)}" title="${titulo}">${titulo}</button>`).join('')}</div></div>
                    <div class="dbtDica">Exemplo: clique num botão para ele virar o ativo. As mudanças aparecem na hora também na barra;
                        Cancelar volta ao que estava antes.</div>
                </fieldset>`;
    }

    // Chave de PREDEFINICOES_BOTAO que bate com a escolha atual, ou '' (personalizado)
    function predefinicaoAtual(escolha) {
        const campos = CAMPOS_APARENCIA.map(([nome]) => nome);
        const achada = Object.entries(PREDEFINICOES_BOTAO).find(([, v]) => campos.every((nome, i) => escolha[nome] === v[i + 1]));
        return achada ? achada[0] : '';
    }

    function configurarAparenciaBotoes(raiz) {
        const previa = raiz.querySelector('.dbtPreviaBarra');
        if (!previa) return;
        const campo = (nome) => raiz.querySelector(`select[name="${nome}"]`);
        const ler = () => Object.fromEntries(CAMPOS_APARENCIA.map(([nome]) => [nome, campo(nome).value]));
        // O fundo da prévia imita a barra de status do portal
        try {
            const estilo = getComputedStyle(oW5Portal.statusbar.getEl().dom);
            // Já é a cor final (com o Dealer/Tema, a cor do tema): marcado para o tema não traduzi-la de novo
            previa.parentNode.setAttribute('data-dealer-tema', '');
            previa.parentNode.style.backgroundColor = estilo.backgroundColor;
            previa.parentNode.style.backgroundImage = estilo.backgroundImage;
        } catch (e) { /* sem barra de status: fica o fundo branco */ }
        const aplicar = (animar) => {
            const escolha = ler();
            aplicarAparenciaBotoes(previa, escolha);
            aplicarAparenciaBotoes(containerBotoes, escolha);
            campo('botaoPronto').value = predefinicaoAtual(escolha);
            if (animar) previa.querySelectorAll('button:not(.dbtIniciar)').forEach((b, i) => setTimeout(() => marcarBotaoNovo(b), i * 70));
        };
        CAMPOS_APARENCIA.forEach(([nome]) => campo(nome).addEventListener('change', () => aplicar(nome === 'botaoAbertura')));
        campo('botaoPronto').addEventListener('change', () => {
            const pronto = PREDEFINICOES_BOTAO[campo('botaoPronto').value];
            if (!pronto) return;
            CAMPOS_APARENCIA.forEach(([nome], i) => { campo(nome).value = pronto[i + 1]; });
            aplicar(true);
        });
        // O botão Iniciar (busca no menu) aparece na prévia quando a posição escolhida é a barra de tarefas
        const posicao = raiz.querySelector('select[name="buscaMenuPosicao"]');
        const mostrarIniciar = () => {
            const comIniciar = !posicao || posicao.value === 'barra';
            previa.classList.toggle('dbtComIniciar', comIniciar);
            previa.querySelector('.dbtIniciar').hidden = !comIniciar;
        };
        if (posicao) posicao.addEventListener('change', mostrarIniciar);
        mostrarIniciar();
        previa.querySelectorAll('button:not(.dbtIniciar)').forEach(b => b.addEventListener('click', () => {
            previa.querySelectorAll('button:not(.dbtIniciar)').forEach(x => x.classList.toggle('ativo', x === b));
            b.classList.remove('botaoMinimizado', 'concluido');
        }));
        aplicarAparenciaBotoes(previa, config);
    }

    function htmlConfiguracoes() {
        const linhasAtalhos = Object.keys(DESCRICAO_ATALHOS).map(nome => `
            <tr>
                <td>${DESCRICAO_ATALHOS[nome]}</td>
                <td>
                    <input type="text" readonly class="dbtAtalho" data-acao="${nome}"
                           data-valor="${config.atalhos[nome] || ''}"
                           value="${nomeAtalho(config.atalhos[nome], nome === 'numero')}"
                           placeholder="(nenhum)">
                    <span class="dbtLimpar" data-limpar="${nome}" title="Remover atalho">&#10006;</span>
                </td>
            </tr>`).join('');

        const aba = (id, titulo, icone) =>
            `<button type="button" class="dbtAba" role="tab" data-aba="${id}"><span class="dbtAbaIco dbt-ico-${icone}"></span>${titulo}</button>`;
        return `
            <div class="barraTarefasConfig">
                <div class="dbtBuscaConfig">
                    <input type="search" class="dbtCampoBuscaConfig" placeholder="Buscar nas configurações..." aria-label="Buscar nas configurações" autocomplete="off" spellcheck="false">
                </div>
                <div class="dbtAbas" role="tablist">
                    ${aba('barra', 'Barra', 'barra')}${aba('telas', 'Janelas e telas', 'janelas')}${aba('fluxos', 'Notificação de fluxos', 'sino')}${aba('atalhos', 'Atalhos', 'teclado')}${apiTema() ? aba('tema', 'Tema', 'tema') : ''}${aba('privacidade', 'Privacidade', 'cadeado')}${aba('sobre', 'Sobre', 'sobre')}
                </div>
                <div class="dbtPaineis">
                <div class="dbtSemResultado">Nenhuma configuração encontrada.</div>
                <div class="dbtAbaPainel" data-painel="barra">
                <fieldset>
                    <legend>Barra</legend>
                    <table>
                        <tr><td>Altura da barra (px)</td>
                            <td><input type="number" name="alturaBarra" min="22" max="60" value="${config.alturaBarra}"></td></tr>
                        <tr><td>Largura máxima dos botões (px)</td>
                            <td><input type="number" name="larguraMaxBotao" min="80" max="600" value="${config.larguraMaxBotao}"></td></tr>
                        <tr><td>Clicar no botão da janela ativa minimiza ela</td>
                            <td><input type="checkbox" name="cliqueAtivaMinimiza" ${config.cliqueAtivaMinimiza ? 'checked' : ''}></td></tr>
                        <tr><td>Botão do meio do mouse fecha a janela</td>
                            <td><input type="checkbox" name="botaoMeioFecha" ${config.botaoMeioFecha ? 'checked' : ''}></td></tr>
                        <tr><td>Texto adicionado ao título das janelas duplicadas</td>
                            <td><input type="text" name="sufixoCopia" value="${Ext.util.Format.htmlEncode(config.sufixoCopia)}"></td></tr>
                    </table>
                </fieldset>
                ${htmlAparenciaBotoes()}
                <fieldset>
                    <legend>Carregamento</legend>
                    <table>
                        <tr><td>Mostrar indicador enquanto a tela está carregando</td>
                            <td><input type="checkbox" name="indicadorCarregamento" ${config.indicadorCarregamento ? 'checked' : ''}></td></tr>
                        <tr><td>Destacar o botão quando uma janela em segundo plano terminar de carregar</td>
                            <td><input type="checkbox" name="avisarConclusao" ${config.avisarConclusao ? 'checked' : ''}></td></tr>
                        <tr><td>... só se demorou pelo menos (segundos)</td>
                            <td><input type="number" name="avisarAposSegundos" min="0" max="120" step="0.5" value="${config.avisarAposSegundos}"></td></tr>
                    </table>
                </fieldset>
                </div>
                <div class="dbtAbaPainel" data-painel="telas">
                <fieldset>
                    <legend>Janelas</legend>
                    <table>
                        <tr><td>Mostrar o botão <i class="fa fa-home"></i> "Voltar para o início" no título das janelas</td>
                            <td><input type="checkbox" name="botaoInicio" ${config.botaoInicio ? 'checked' : ''}></td></tr>
                    </table>
                </fieldset>
                <fieldset>
                    <legend>Avisos das telas</legend>
                    <table>
                        <tr><td>Destacar os avisos das telas (mensagens em vermelho no topo) no meio da tela</td>
                            <td><input type="checkbox" name="avisosTela" ${config.avisosTela ? 'checked' : ''}></td></tr>
                        <tr><td>... tempo no meio da tela antes de ir para o botão "Aviso" (segundos)</td>
                            <td><input type="number" name="avisosTelaSegundos" min="1" max="60" step="0.5" value="${config.avisosTelaSegundos}"></td></tr>
                    </table>
                </fieldset>
                <fieldset>
                    <legend>Busca no menu</legend>
                    <table>
                        <tr><td>Botão da busca (lupa), para achar uma tela do menu pelo nome sem passar pelos submenus. O atalho (Alt+M por padrão) funciona em qualquer opção</td>
                            <td><select name="buscaMenuPosicao" class="dbtSelectAparencia">${Object.entries(POSICOES_BUSCA_MENU).map(([v, t]) =>
                                `<option value="${v}" ${config.buscaMenuPosicao === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>
                    </table>
                </fieldset>
                <fieldset>
                    <legend>Listas de opções</legend>
                    <table>
                        <tr><td>Busca nas listas de opções das telas: lista com "Buscar na lista", botão &#128269; e atalho (Alt+F por padrão). Desmarcado: a lista normal do navegador</td>
                            <td><input type="checkbox" name="buscaListas" ${config.buscaListas ? 'checked' : ''}></td></tr>
                        <tr><td>... só nas listas com mais de (opções)</td>
                            <td><input type="number" name="buscaListasMinimo" min="0" max="1000" value="${config.buscaListasMinimo}"></td></tr>
                    </table>
                </fieldset>
                <fieldset>
                    <legend>Impressão da OS</legend>
                    <table>
                        <tr><td>Abrir os documentos marcados (termos, comprovantes) cada um numa janela, pronto para imprimir, em vez de baixar um ZIP</td>
                            <td><input type="checkbox" name="documentosOSJanelas" ${config.documentosOSJanelas ? 'checked' : ''}></td></tr>
                    </table>
                    <div class="dbtDica">Oficina &gt; Ordem de Serviço &gt; Imprimir: ao marcar documentos e imprimir, eles abrem sozinhos quando
                        aparece "Download Documento(s)". Também dá para ligar e desligar pela caixa embaixo da lista de documentos.</div>
                </fieldset>
                </div>
                ${htmlConfigFluxos()}
                <div class="dbtAbaPainel" data-painel="atalhos">
                <fieldset>
                    <legend>Atalhos de teclado</legend>
                    <table>${linhasAtalhos}</table>
                    <div class="dbtDica">Clique no campo e pressione a combinação desejada (precisa usar Ctrl, Alt ou uma tecla F1-F12).
                        Esc cancela, Backspace remove. Os atalhos funcionam mesmo com o cursor dentro das telas.</div>
                </fieldset>
                </div>
                ${htmlConfigTema()}
                ${htmlConfigPrivacidade()}
                ${htmlConfigSobre()}
                </div>
            </div>`;
    }

    function configurarCamposAtalho(raiz) {
        raiz.querySelectorAll('input.dbtAtalho').forEach(campo => {
            const ehNumero = campo.dataset.acao === 'numero';
            const mostrar = () => { campo.value = nomeAtalho(campo.dataset.valor, ehNumero); };

            campo.addEventListener('focus', () => {
                campo.classList.add('gravando');
                campo.value = '';
                campo.placeholder = ehNumero ? 'Pressione modificadores + um número' : 'Pressione as teclas...';
            });
            campo.addEventListener('blur', () => {
                campo.classList.remove('gravando');
                campo.placeholder = '(nenhum)';
                mostrar();
            });
            campo.addEventListener('keydown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') { campo.blur(); return; }
                if ((e.key === 'Backspace' || e.key === 'Delete') && !modificadoresDoEvento(e)) {
                    campo.dataset.valor = '';
                    campo.blur();
                    return;
                }
                const mods = modificadoresDoEvento(e);
                if (TECLAS_MODIFICADORAS.includes(e.key)) {
                    campo.value = mods ? `${nomeAtalho(mods)}+...` : '';
                    return;
                }
                const ehTeclaF = /^F([1-9]|1[0-2])$/.test(e.code);
                const temModificadorForte = e.ctrlKey || e.altKey || e.metaKey;
                if (!temModificadorForte && !ehTeclaF) {
                    campo.value = 'Use Ctrl ou Alt...';
                    return;
                }
                if (ehNumero) {
                    if (!digitoDoEvento(e)) {
                        campo.value = 'Termine com um número...';
                        return;
                    }
                    campo.dataset.valor = mods;
                } else {
                    campo.dataset.valor = comboDoEvento(e);
                }
                campo.blur();
            });
        });

        raiz.querySelectorAll('[data-limpar]').forEach(x => {
            x.addEventListener('click', () => {
                const campo = raiz.querySelector(`input.dbtAtalho[data-acao="${x.dataset.limpar}"]`);
                campo.dataset.valor = '';
                campo.value = '';
            });
        });
    }

    function lerFormulario(raiz) {
        const valor = (nome) => raiz.querySelector(`[name="${nome}"]`);
        const numero = (nome, min, max) => {
            const n = parseFloat(valor(nome).value);
            return isNaN(n) ? PADRAO[nome] : Math.min(max, Math.max(min, n));
        };
        const atalhos = {};
        raiz.querySelectorAll('input.dbtAtalho').forEach(c => { atalhos[c.dataset.acao] = c.dataset.valor || ''; });

        // Parte do formulário; o restante (fluxos, tutoriais) é mantido como está
        return {
            ...copiar(config),
            alturaBarra: Math.round(numero('alturaBarra', 22, 60)),
            larguraMaxBotao: Math.round(numero('larguraMaxBotao', 80, 600)),
            ...Object.fromEntries(CAMPOS_APARENCIA.map(([nome, , opcoes]) =>
                [nome, opcoes[valor(nome).value] ? valor(nome).value : PADRAO[nome]])),
            cliqueAtivaMinimiza: valor('cliqueAtivaMinimiza').checked,
            botaoMeioFecha: valor('botaoMeioFecha').checked,
            sufixoCopia: valor('sufixoCopia').value,
            indicadorCarregamento: valor('indicadorCarregamento').checked,
            avisarConclusao: valor('avisarConclusao').checked,
            avisarAposSegundos: numero('avisarAposSegundos', 0, 120),
            botaoInicio: valor('botaoInicio').checked,
            avisosTela: valor('avisosTela').checked,
            avisosTelaSegundos: numero('avisosTelaSegundos', 1, 60),
            buscaListas: valor('buscaListas').checked,
            telemetria: valor('telemetria') ? valor('telemetria').checked : config.telemetria,
            telemetriaSemIcone: valor('telemetriaSemIcone') ? valor('telemetriaSemIcone').checked : config.telemetriaSemIcone,
            buscaListasMinimo: Math.round(numero('buscaListasMinimo', 0, 1000)),
            buscaMenuPosicao: POSICOES_BUSCA_MENU[valor('buscaMenuPosicao').value] ? valor('buscaMenuPosicao').value : config.buscaMenuPosicao,
            documentosOSJanelas: valor('documentosOSJanelas').checked,
            fluxos: copiar(config.fluxos),     // substituído pelo que está nas abas de fluxos, em abrirConfiguracoes
            atalhos
        };
    }

    // Retorna a descrição do primeiro conflito entre atalhos, ou null
    function conflitoAtalhos(atalhos) {
        const usados = {};
        for (const nome of Object.keys(atalhos)) {
            const combo = atalhos[nome];
            if (!combo) continue;
            if (nome === 'numero') {
                for (let d = 1; d <= 9; d++) usados[`${combo}+Digit${d}`] = nome;
                continue;
            }
            if (usados[combo]) {
                return `"${DESCRICAO_ATALHOS[nome]}" e "${DESCRICAO_ATALHOS[usados[combo]]}" usam o mesmo atalho (${nomeAtalho(combo)}).`;
            }
            usados[combo] = nome;
        }
        return null;
    }

    // Botão "?" no título das janelas de configuração
    function ferramentaAjuda(acao) {
        return [{ id: 'help', qtip: 'Como usar', handler: acao }];
    }

    let abaConfig = 'barra';            // última aba aberta (nesta página)

    function abrirConfiguracoes(aba) {
        if (typeof aba !== 'string') aba = null;
        if (janelaConfig) {
            if (aba) janelaConfig.mostrarAba(aba);
            janelaConfig.toFront();
            return;
        }
        let lerFluxos = null, formTema = null, salvou = false;
        const area = Ext.getBody().getViewSize();
        janelaConfig = new Ext.Window({
            title: `Configurações do ${NOME_EXIBICAO}`,
            width: Math.max(560, Math.min(LARGURA_MAX_CONFIG, area.width - 40)),
            autoHeight: true,
            modal: true,
            resizable: false,
            cls: 'barraTarefasJanela',
            bodyStyle: 'padding: 10px; background: #fff;',
            html: htmlConfiguracoes(),
            tools: ferramentaAjuda(() => {
                if (abaConfig === 'fluxos') mostrarTutorialFluxos(true);
                else mostrarBoasVindas(true);
            }),
            buttonAlign: 'right',
            buttons: [
                {
                    text: 'Tutoriais',
                    tooltip: 'Ver de novo as explicações que aparecem na primeira vez',
                    menu: {
                        items: [
                            { text: 'Boas-vindas e aviso', handler: () => mostrarBoasVindas(true) },
                            { text: 'Notificação de fluxos', handler: () => mostrarTutorialFluxos(true) },
                            { text: 'Estatísticas de uso (privacidade)', handler: () => mostrarAvisoTelemetria(true) }
                        ]
                    }
                },
                {
                    text: 'Restaurar padrões',
                    handler: () => {
                        confirmar('Restaurar padrões', `Voltar as configurações da barra, das telas e dos atalhos para o padrão, e o tema para "Original"?<br>(A notificação e a escolha de fluxos não são alteradas.)`, (resposta) => {
                            if (resposta === 'yes') {
                                const T = apiTema();
                                if (T) {
                                    const c = T.config();
                                    aplicarEscolhaTema({ tema: 'off', imagens: true, debug: false, ...('ocultos' in c ? { ocultos: false } : {}),
                                                         ...('fonte' in c ? { fonte: 'original', tamanho: 100 } : {}) });
                                }
                                salvou = true;
                                const padrao = copiar(PADRAO);
                                // Privacidade não volta ao padrão: restaurar nunca religa o envio de estatísticas
                                salvarConfig({ ...padrao, fluxos: copiar(config.fluxos), tutoriaisOcultos: copiar(config.tutoriaisOcultos),
                                               telemetria: config.telemetria, telemetriaSemIcone: config.telemetriaSemIcone });
                                janelaConfig.close();
                            }
                        });
                    }
                },
                {
                    text: 'Salvar',
                    cls: 'dbtPrimario',
                    handler: () => {
                        const novo = lerFormulario(janelaConfig.body.dom);
                        novo.fluxos = lerFluxos();
                        if (formTema) Object.assign(novo, formTema.aceites());
                        const conflito = conflitoAtalhos(novo.atalhos);
                        if (conflito) {
                            janelaConfig.mostrarAba('atalhos');
                            Ext.Msg.alert('Atalho repetido', conflito);
                            return;
                        }
                        // Mudanças na escolha de fluxos não devem gerar um aviso de "novos fluxos"
                        estadoFluxos.silenciarProxima = true;
                        salvarConfig(novo);
                        if (formTema) {
                            const mudou = formTema.mudancas();
                            if (mudou.tema) contarTelemetria('temaConfig');
                            if (mudou.fonte) contarTelemetria('fonteConfig');
                            aplicarEscolhaTema(formTema.ler());
                        }
                        salvou = true;
                        verificarFluxos();
                        janelaConfig.close();
                    }
                },
                { text: 'Cancelar', handler: () => janelaConfig.close() }
            ],
            listeners: {
                afterrender: (w) => {
                    const raiz = w.body.dom;
                    configurarCamposAtalho(raiz);
                    configurarPrivacidade(raiz);
                    configurarSobre(raiz);
                    configurarAparenciaBotoes(raiz);
                    lerFluxos = configurarFormFluxos(raiz);
                    formTema = configurarFormTema(raiz);
                    const busca = configurarBuscaConfig(raiz);
                    w.mostrarAba = (nome) => {
                        busca.limpar();
                        if (!raiz.querySelector(`[data-painel="${nome}"]`)) nome = 'barra';
                        abaConfig = nome;
                        raiz.querySelectorAll('.dbtAba').forEach(b => b.classList.toggle('ativa', b.dataset.aba === nome));
                        raiz.querySelectorAll('.dbtAbaPainel').forEach(p => p.classList.toggle('ativa', p.dataset.painel === nome));
                        if (nome === 'fluxos') mostrarTutorialFluxos();
                    };
                    raiz.querySelectorAll('.dbtAba').forEach(b => b.addEventListener('click', () => w.mostrarAba(b.dataset.aba)));
                },
                show: (w) => w.mostrarAba(aba || abaConfig),
                close: () => {
                    janelaConfig = null;
                    if (!salvou) aplicarAparenciaBotoes(containerBotoes, config);   // a aparência muda na hora; sem salvar, volta
                    if (!salvou && formTema) formTema.reverter();   // o tema muda na hora; sem salvar, volta
                }
            }
        });
        janelaConfig.show();
        dimensionarConfig(janelaConfig);
        encaixarNaTela(janelaConfig);
    }

    // Busca nas configurações: com algo digitado, todas as abas aparecem uma embaixo da outra (com o nome da aba
    // em cima) e só ficam as linhas que têm todas as palavras (sem diferenciar maiúsculas e acentos), contando
    // também o nome da aba e do grupo da linha ("volume som" acha o Volume do grupo Som). Os campos
    // são os de verdade: dá para mudar ali mesmo, e o Salvar/Cancelar de sempre vale para eles.
    function configurarBuscaConfig(raiz) {
        const raizConfig = raiz.querySelector('.barraTarefasConfig');
        const campo = raiz.querySelector('.dbtCampoBuscaConfig');
        const paineis = [...raiz.querySelectorAll('.dbtAbaPainel')];
        paineis.forEach(p => {
            const aba = raiz.querySelector(`.dbtAba[data-aba="${p.dataset.painel}"]`);
            p.dataset.titulo = aba ? aba.textContent.trim() : '';
        });
        const texto = (el) => {
            if (!el) return '';
            const copia = el.cloneNode(true);
            copia.querySelectorAll('.dbtListaFluxos, .dbtPersonalizados, .dbtPreviaFundo, select, script, style').forEach(x => x.remove());
            return normalizarBusca(copia.textContent.replace(/\s+/g, ' '));
        };
        const realce = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
        const realcar = (termos) => {
            if (!realce) return;
            CSS.highlights.delete('dbt-busca-config');
            if (!termos.length) return;
            const destaque = new Highlight();
            paineis.forEach(p => {
                const andar = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => n.parentElement && !n.parentElement.closest('.dbtFora, .dbtListaFluxos, option, script, style') ?
                        NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
                });
                let n;
                while ((n = andar.nextNode())) {
                    const normal = normalizarBusca(n.nodeValue);
                    termos.forEach(t => {
                        let i = normal.indexOf(t);
                        while (i >= 0) {
                            const faixa = new Range();
                            faixa.setStart(n, i);
                            faixa.setEnd(n, i + t.length);
                            destaque.add(faixa);
                            i = normal.indexOf(t, i + t.length);
                        }
                    });
                }
            });
            CSS.highlights.set('dbt-busca-config', destaque);
        };
        const filtrar = () => {
            const termos = normalizarBusca(campo.value).split(/\s+/).filter(Boolean);
            raiz.querySelectorAll('.dbtFora').forEach(el => el.classList.remove('dbtFora'));
            raizConfig.classList.toggle('dbtBuscando', termos.length > 0);
            if (!termos.length) { realcar([]); raizConfig.classList.remove('dbtNada'); return; }
            const bate = (t) => termos.every(x => t.includes(x));
            let algum = false;
            paineis.forEach(p => {
                // O nome da aba bate: a aba inteira
                const titulo = normalizarBusca(p.dataset.titulo);
                if (bate(titulo)) { algum = true; return; }
                let noPainel = false;
                [...p.children].forEach(bloco => {
                    if (bloco.tagName !== 'FIELDSET') {
                        const ok = bate(`${titulo} ${texto(bloco)}`);
                        if (!ok) bloco.classList.add('dbtFora');
                        noPainel = noPainel || ok;
                        return;
                    }
                    const legenda = bloco.querySelector(':scope > legend');
                    const contexto = `${titulo} ${texto(legenda)}`;
                    if (bate(contexto)) { noPainel = true; return; }                     // o grupo inteiro
                    const linhas = [...bloco.querySelectorAll('tr')];
                    let noGrupo = false;
                    if (linhas.length) {
                        linhas.forEach(tr => {
                            const ok = bate(`${contexto} ${texto(tr)}`);
                            if (!ok) tr.classList.add('dbtFora');
                            noGrupo = noGrupo || ok;
                        });
                        // Sem nenhuma linha: o grupo some; com alguma, o resto do grupo (dicas, prévia) fica
                    } else {
                        noGrupo = bate(`${titulo} ${texto(bloco)}`);
                    }
                    if (!noGrupo) bloco.classList.add('dbtFora');
                    noPainel = noPainel || noGrupo;
                });
                if (!noPainel) p.classList.add('dbtFora');
                algum = algum || noPainel;
            });
            raizConfig.classList.toggle('dbtNada', !algum);
            raiz.querySelector('.dbtPaineis').scrollTop = 0;
            realcar(termos);
        };
        campo.addEventListener('input', filtrar);
        campo.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && campo.value) { e.preventDefault(); e.stopPropagation(); campo.value = ''; filtrar(); }
        });
        return {
            limpar: () => { if (campo.value) { campo.value = ''; filtrar(); } }
        };
    }

    // A janela de configurações ocupa a tela: as abas ficam com a altura que sobra depois do título, das abas e
    // dos botões (até ALTURA_MAX_PAINEL), e a lista de fluxos cresce junto. Mede o que não é aba depois de abrir.
    const LARGURA_MAX_CONFIG = 860;
    const ALTURA_MAX_PAINEL = 640;
    function dimensionarConfig(janela) {
        const raiz = janela.body.dom;
        const painel = raiz.querySelector('.dbtAbaPainel.ativa');
        if (!painel) return;
        const area = Ext.getBody().getViewSize();
        const resto = janela.getHeight() - painel.offsetHeight;
        const altura = Math.max(260, Math.min(ALTURA_MAX_PAINEL, area.height - 16 - resto));
        raiz.querySelectorAll('.dbtAbaPainel').forEach(p => { p.style.height = `${altura}px`; });
        raiz.querySelector('.dbtPaineis').style.height = `${altura}px`;      // na busca, todas as abas rolam juntas aqui
        const lista = raiz.querySelector('.dbtListaFluxos');
        if (lista) lista.style.height = `${Math.max(200, Math.min(420, altura - 150))}px`;
        janela.doLayout();
        if (janela.syncShadow) janela.syncShadow();
        janela.center();
    }

    // Aplica as configurações sem precisar recarregar a página
    function aplicarConfig() {
        aplicarEstilos();
        aplicarAparenciaBotoes(containerBotoes, config);
        if (barraVisivel) atualizarVisibilidadeBarra(true);
        registro.forEach(({ janela, botao }) => {
            const ferramenta = janela.tools && janela.tools['dbt-inicio'];
            if (ferramenta) ferramenta.setDisplayed(config.botaoInicio);
            if (!config.indicadorCarregamento) botao.classList.remove('carregando');
            if (!config.avisarConclusao) botao.classList.remove('concluido');
        });
        if (botaoFluxos) botaoFluxos.setVisible(config.fluxos.ativo);
        reiniciarMonitorFluxos();
        atualizarAvisosTela();
        if (buscaAberta && !config.buscaListas) buscaAberta.fechar(false);
        posicionarBotaoBuscaMenu();
        enviarEstadoTelemetria();
    }

    // ---------------------------------------------------------------------------------------------
    // Avisos das telas: o GeneXus mostra mensagens (ex.: "Atenção!! ...") em vermelho no topo da tela, em
    // <span id="gxErrorViewer">, uma <div> por mensagem. Quem rolou a tela não vê. Aqui elas aparecem num
    // cartão no meio da tela por config.avisosTelaSegundos (o mouse em cima pausa); clicar nele ou o tempo
    // acabar faz o cartão "voar" para uma pílula "Aviso" no canto superior direito (o movimento já mostra onde
    // o aviso foi parar), que pisca; clicar nela mostra o aviso de novo. O cartão tem os botões "Copiar erro" e "Fechar".
    // Roda em cada tela (iframe), chamado por instrumentarIframe. As cores ficam direto nas propriedades
    // (sem variáveis CSS) para o Dealer/Tema conseguir traduzi-las para o tema dele.
    // ---------------------------------------------------------------------------------------------

    const CSS_AVISO_FLUTUANTE = `
/* a mensagem original, no topo da tela */
span.ErrorViewer>div{display:block!important;margin:4px 0!important;padding:6px 10px;border-radius:6px;
  background-color:#fbe9ea;border-left:3px solid #cf222e;color:#1f2328!important}
/* cartão no meio da tela: clicar fecha (vira a pílula) */
#dnf-aviso{position:fixed;left:50%;top:40%;z-index:2147483000;display:flex;gap:12px;align-items:flex-start;
  box-sizing:border-box;max-width:min(640px,90vw);padding:14px 14px 14px 18px;border-radius:10px;
  background-color:#ffffff;border:1px solid #e3b5b8;border-left:4px solid #cf222e;
  box-shadow:0 14px 40px rgba(0,0,0,.22);color:#1f2328;cursor:pointer;
  font:600 13px/1.45 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
  pointer-events:none;opacity:0;transform:translate(-50%,-50%) translateY(10px);transition:opacity .35s,transform .35s}
#dnf-aviso.dnf-visivel{pointer-events:auto;opacity:.97;transform:translate(-50%,-50%)}
#dnf-aviso.dnf-voando{pointer-events:none;transition:opacity .45s ease-in,transform .45s cubic-bezier(.5,0,.75,0)}
#dnf-aviso svg{flex:none;width:22px;height:22px;margin-top:1px;color:#cf222e}
#dnf-aviso .dnf-msgs{flex:1 1 auto;min-width:0}
#dnf-aviso .dnf-msgs div+div{margin-top:6px}
#dnf-aviso .dnf-acoes{flex:none;display:flex;flex-direction:column;gap:6px;align-self:center;
  margin-left:6px;padding-left:12px;border-left:1px solid #eaeef2}
#dnf-aviso .dnf-acoes button{padding:3px 10px;border:1px solid #d0d7de;border-radius:4px;background-color:#f6f8fa;
  color:#1f2328;font:600 11px "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;cursor:pointer;white-space:nowrap}
#dnf-aviso .dnf-acoes button:hover{background-color:#eaeef2}
/* pílula no canto (essa pega clique); right:22px para não cobrir a barra de rolagem */
#dnf-aviso-pilula{position:fixed;top:8px;right:22px;z-index:2147483000;display:flex;gap:6px;align-items:center;
  padding:4px 11px 4px 8px;border-radius:999px;background-color:#fbe9ea;
  border:1px solid #cf222e;color:#1f2328;cursor:pointer;white-space:nowrap;
  font:600 11px "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.22);
  opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s}
#dnf-aviso-pilula.dnf-visivel{opacity:1;transform:none}
#dnf-aviso-pilula.dnf-pulsar{animation:dnf-pulsar .9s ease-out 2}
#dnf-aviso-pilula:hover{filter:brightness(.97)}
#dnf-aviso-pilula svg{width:14px;height:14px;color:#cf222e}
@keyframes dnf-pulsar{0%{box-shadow:0 0 0 0 rgba(207,34,46,.55)}100%{box-shadow:0 0 0 12px rgba(207,34,46,0)}}
`;
    // Ícone de alerta (triângulo), criado direto no documento da tela
    function svgAviso(doc) {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = doc.createElementNS(NS, 'svg');
        const atributos = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
                            'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
        for (const [k, v] of Object.entries(atributos)) svg.setAttribute(k, v);
        ['M12 3L2 20h20z', 'M12 10v4M12 17v.01'].forEach(d => {
            const caminho = doc.createElementNS(NS, 'path');
            caminho.setAttribute('d', d);
            svg.appendChild(caminho);
        });
        return svg;
    }
    const TEMPO_VOO_AVISO = 450;        // ms da animação do cartão indo para a pílula
    const telasComAviso = new Set();   // { doc, atualizar } de cada tela, para ligar/desligar pela configuração

    function atualizarAvisosTela() {
        telasComAviso.forEach(tela => {
            if (!tela.doc.defaultView) telasComAviso.delete(tela);   // tela fechada ou que navegou
            else tela.atualizar();
        });
    }

    // Copia texto a partir de uma tela (iframe); usa o jeito antigo se a API nova não estiver disponível
    function copiarTexto(doc, texto) {
        const win = doc.defaultView;
        const antigo = () => {
            const area = doc.createElement('textarea');
            area.value = texto;
            area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            doc.body.appendChild(area);
            area.select();
            let ok = false;
            try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
            area.remove();
            return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
        };
        try {
            if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
                return win.navigator.clipboard.writeText(texto).catch(antigo);
            }
        } catch (e) { /* cai no jeito antigo */ }
        return antigo();
    }

    function instalarAvisoFlutuante(doc) {
        if (!doc || doc.__avisoFlutuante) return;   // marca o document: a window do iframe é reaproveitada
        doc.__avisoFlutuante = true;
        const win = doc.defaultView;
        let ultimo = '', msgsAtuais = [], timer = 0, timerVoo = 0, agenda = 0;
        let card = null, pilula = null, estilo = null;

        function mensagens() {
            const ev = doc.getElementById('gxErrorViewer');
            if (!ev) return [];
            let m = [...ev.children].map(d => d.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
            if (!m.length) {
                const texto = ev.textContent.replace(/\s+/g, ' ').trim();
                if (texto) m = [texto];
            }
            return m;
        }
        function tempoNoMeio() {
            const s = Number(config.avisosTelaSegundos);
            return (isFinite(s) && s > 0 ? s : PADRAO.avisosTelaSegundos) * 1000;
        }
        function limparTimers() {
            win.clearTimeout(timer);
            win.clearTimeout(timerVoo);
        }
        function remover() {
            limparTimers();
            if (card) card.remove();
            if (pilula) pilula.remove();
            ultimo = '';
        }
        function criarCard() {
            card = doc.createElement('div');
            card.id = 'dnf-aviso';
            card.setAttribute('role', 'alert');
            card.title = 'Clique para fechar';
            card.addEventListener('click', (e) => {
                if (e.target.closest('.dnf-acoes')) return;
                recolher(true);
            });
            card.addEventListener('mouseenter', () => win.clearTimeout(timer));     // lendo: não some
            card.addEventListener('mouseleave', () => {
                if (!card.classList.contains('dnf-visivel')) return;
                win.clearTimeout(timer);
                timer = win.setTimeout(() => recolher(true), tempoNoMeio());
            });
        }
        function mostrar(forcar) {
            if (!doc.body) return;
            if (!config.avisosTela) { remover(); return; }
            const msgs = mensagens(), chave = msgs.join('\n');
            if (!chave) { remover(); return; }
            if (chave === ultimo && !forcar) return;
            ultimo = chave;
            msgsAtuais = msgs;
            limparTimers();
            if (!card) criarCard();
            card.replaceChildren(svgAviso(doc));
            const lista = doc.createElement('div');
            lista.className = 'dnf-msgs';
            msgs.forEach(texto => {
                const d = doc.createElement('div');
                d.textContent = texto;
                lista.appendChild(d);
            });
            const acoes = doc.createElement('div');
            acoes.className = 'dnf-acoes';
            const copiar = doc.createElement('button');
            copiar.type = 'button';
            copiar.className = 'dnf-copiar';
            const rotuloCopiar = msgs.length > 1 ? 'Copiar erros' : 'Copiar erro';
            copiar.textContent = rotuloCopiar;
            copiar.title = 'Copiar o texto para colar num chamado, e-mail, etc.';
            copiar.addEventListener('click', (e) => {
                e.stopPropagation();
                copiarTexto(doc, msgsAtuais.join('\n')).then(
                    () => { copiar.textContent = 'Copiado!'; },
                    () => { copiar.textContent = 'Não consegui copiar'; });
                win.setTimeout(() => { copiar.textContent = rotuloCopiar; }, 1800);
            });
            const fechar = doc.createElement('button');
            fechar.type = 'button';
            fechar.className = 'dnf-fechar';
            fechar.textContent = 'Fechar';
            fechar.title = 'Fechar (o aviso continua no botão "Aviso", no canto da tela)';
            fechar.addEventListener('click', (e) => {
                e.stopPropagation();
                recolher(true);
            });
            acoes.append(copiar, fechar);
            card.append(lista, acoes);
            if (card.parentNode !== doc.body) doc.body.appendChild(card);
            if (pilula) pilula.classList.remove('dnf-visivel', 'dnf-pulsar');
            card.classList.remove('dnf-visivel', 'dnf-voando');
            card.style.transform = '';
            card.style.opacity = '';
            void card.offsetWidth;                 // reinicia a transição
            card.classList.add('dnf-visivel');
            timer = win.setTimeout(() => recolher(true), tempoNoMeio());
        }
        function prepararPilula(n) {
            if (!pilula) {
                pilula = doc.createElement('div');
                pilula.id = 'dnf-aviso-pilula';
                pilula.title = 'Mostrar o aviso de novo';
                pilula.addEventListener('click', () => {
                    const ev = doc.getElementById('gxErrorViewer');
                    if (ev) ev.scrollIntoView({ block: 'center' });
                    mostrar(true);
                });
            }
            pilula.replaceChildren(svgAviso(doc));
            const rotulo = doc.createElement('span');
            rotulo.textContent = n > 1 ? `${n} avisos` : 'Aviso';
            pilula.appendChild(rotulo);
            if (pilula.parentNode !== doc.body) doc.body.appendChild(pilula);
        }
        // O cartão encolhe indo até a pílula; depois a pílula aparece e pisca
        function recolher(animar) {
            if (!card || !card.classList.contains('dnf-visivel')) return;
            limparTimers();
            prepararPilula(msgsAtuais.length);
            const exibirPilula = () => {
                card.classList.remove('dnf-visivel', 'dnf-voando');
                card.style.transform = '';
                card.style.opacity = '';
                pilula.classList.remove('dnf-pulsar');
                void pilula.offsetWidth;
                pilula.classList.add('dnf-visivel', 'dnf-pulsar');
            };
            if (!animar) { exibirPilula(); return; }
            const de = card.getBoundingClientRect(), para = pilula.getBoundingClientRect();
            const dx = (para.left + para.width / 2) - (de.left + de.width / 2);
            const dy = (para.top + para.height / 2) - (de.top + de.height / 2);
            card.classList.add('dnf-voando');
            card.style.transform = `translate(-50%,-50%) translate(${dx}px,${dy}px) scale(.08)`;
            card.style.opacity = '0';
            timerVoo = win.setTimeout(exibirPilula, TEMPO_VOO_AVISO);
        }
        function agendar() {                       // várias mutações seguidas -> uma checagem só
            if (agenda) return;
            agenda = win.setTimeout(() => { agenda = 0; mostrar(false); }, 120);
        }

        const tela = {
            doc,
            atualizar() {
                if (estilo) estilo.disabled = !config.avisosTela;
                if (!config.avisosTela) remover();
                else mostrar(false);
            }
        };
        telasComAviso.add(tela);

        // Observa só mudanças dentro do #gxErrorViewer (ele pode ser recriado, então observa o body)
        const iniciar = () => {
            estilo = doc.createElement('style');
            estilo.id = 'dnf-aviso-css';
            estilo.textContent = CSS_AVISO_FLUTUANTE;
            (doc.head || doc.documentElement).appendChild(estilo);
            estilo.disabled = !config.avisosTela;
            new win.MutationObserver(registros => {
                for (const r of registros) {
                    const alvo = r.target.nodeType === 1 ? r.target : r.target.parentElement;
                    if (alvo && (alvo.id === 'gxErrorViewer' || alvo.closest('#gxErrorViewer'))) { agendar(); return; }
                    for (const n of r.addedNodes) {
                        if (n.nodeType === 1 && (n.id === 'gxErrorViewer' || (n.querySelector && n.querySelector('#gxErrorViewer')))) {
                            agendar();
                            return;
                        }
                    }
                }
            }).observe(doc.body, { childList: true, subtree: true, characterData: true });
            agendar();                             // mensagem que já veio no carregamento da tela
        };
        if (doc.body) iniciar();
        else doc.addEventListener('DOMContentLoaded', iniciar);
    }

    // ---------------------------------------------------------------------------------------------
    // Busca nas listas: muitas telas têm listas (<select>) com dezenas ou centenas de opções. Nas listas com mais
    // de config.buscaListasMinimo opções, abrir a lista (clique, F4, Alt+Seta, Espaço) mostra a nossa no lugar da do
    // navegador, com o mesmo teclado (digitar o começo da opção, "AA" para a segunda com A, setas, Enter/Tab
    // escolhem, Esc fecha). Ela existe porque, com a lista do navegador aberta, nenhuma tecla chega à página: na
    // nossa, a barra "Buscar na lista" do alto ou o atalho config.atalhos.buscaLista (Alt+F) passam para a busca,
    // com a lista aberta ou fechada. Com a lista em foco ou o mouse em cima, um botão de lupa colado à seta abre a
    // busca direto. Na busca, cada palavra digitada precisa aparecer na opção, ignorando maiúsculas e acentos e
    // tolerando erros de digitação (1 erro a partir de 4 letras, 2 a partir de 8). Escolher uma opção muda o
    // <select> e dispara o "change", como na lista normal. Desligado (config.buscaListas), é a lista do navegador.
    // As cores ficam direto nas propriedades (sem variáveis CSS), como no aviso flutuante, por causa do Dealer/Tema.
    // ---------------------------------------------------------------------------------------------

    const CSS_BUSCA_LISTA = `
#dnf-busca{position:fixed;z-index:2147483001;display:flex;flex-direction:column;box-sizing:border-box;
  width:max-content;background-color:#ffffff;border:1px solid #8a9bb0;border-radius:4px;
  box-shadow:0 8px 24px rgba(0,0,0,.25);color:#1f2328;font:12px/1.35 Tahoma,"Segoe UI",Arial,sans-serif;overflow:hidden}
#dnf-busca input{flex:none;margin:6px;padding:4px 6px;border:1px solid #8a9bb0;border-radius:3px;
  background-color:#ffffff;color:#1f2328;font:inherit;outline:none}
#dnf-busca input:focus{border-color:#3b73b9;box-shadow:0 0 0 2px rgba(59,115,185,.25)}
#dnf-busca ul{position:relative;flex:1 1 auto;min-height:0;margin:0;padding:0 0 4px;list-style:none;overflow-y:auto}
#dnf-busca li{padding:3px 8px;cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dnf-busca li.dnf-atual{font-weight:bold}
#dnf-busca li.dnf-desativada{color:#8c959f}
#dnf-busca li.dnf-marcada{background-color:#3b73b9;color:#ffffff}
#dnf-busca li.dnf-vazio{color:#57606a;font-style:italic}
#dnf-busca mark{padding:0;border-radius:2px;background-color:#ffe58a;color:inherit}
#dnf-busca li.dnf-marcada mark{background-color:#6e98cf}
#dnf-lupa{position:absolute;z-index:2147483000;box-sizing:border-box;width:24px;height:18px;margin:0;padding:0;
  border:0;border-left:1px solid #2c5d99;border-radius:0;background-color:#3b73b9;color:#ffffff;cursor:pointer;
  display:flex;align-items:center;justify-content:center;animation:dnfLupaEntra .15s ease-out}
#dnf-lupa:hover{background-color:#2c5d99}
#dnf-lupa svg{width:11px;height:11px;display:block}
@keyframes dnfLupaEntra{from{opacity:0;transform:scaleX(.4)}}
#dnf-busca .dnf-barra-busca{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;
  background-color:#eef3fa;color:#3b73b9;border-bottom:1px solid #d0d7de}
#dnf-busca .dnf-barra-busca:hover{background-color:#dde8f6}
#dnf-busca .dnf-barra-busca svg{width:12px;height:12px;flex:none}
#dnf-busca .dnf-barra-busca b{flex:1;font-weight:bold}
#dnf-busca .dnf-barra-busca kbd{font:10px Tahoma,Arial,sans-serif;color:#57606a;border:1px solid #c5ccd6;border-radius:3px;
  padding:0 4px;background-color:#ffffff}
#dnf-busca.dnf-modo-lista input,#dnf-busca.dnf-modo-lista .dnf-rodape{display:none}
#dnf-busca.dnf-modo-busca .dnf-barra-busca{display:none}
#dnf-busca.dnf-modo-lista ul{padding:0}
#dnf-busca.dnf-modo-lista li{padding:2px 8px}
#dnf-busca .dnf-rodape{flex:none;padding:3px 8px;border-top:1px solid #d0d7de;background-color:#f6f8fa;color:#57606a;font-size:11px}
`;
    const LARGURA_SETA_LISTA = 18;     // px da seta da lista do navegador (o botão de busca fica colado nela)
    const MAX_ITENS_BUSCA = 500;       // itens desenhados de uma vez (a contagem no rodapé mostra o total)
    let buscaAberta = null;            // painel aberto (um só, em qualquer tela): { select, fechar(devolverFoco) }

    // Minúsculas e sem acentos, um caractere para cada caractere do original (para o realce bater)
    function normalizarBusca(texto) {
        let r = '';
        for (let i = 0; i < texto.length; i++) {
            const n = texto[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            r += n.length === 1 ? n : texto[i];
        }
        return r;
    }

    function toleranciaBusca(tamanho) {
        return tamanho >= 8 ? 2 : tamanho >= 4 ? 1 : 0;
    }

    // Menor número de erros (letra trocada, a mais, a menos ou duas invertidas) para o termo aparecer em
    // algum lugar do texto. Retorna { erros, inicio, fim } ou null se precisar de mais que maxErros.
    function buscarAproximado(termo, texto, maxErros) {
        const m = termo.length, n = texto.length;
        let ant2 = null, ini2 = null;
        let ant = new Array(n + 1).fill(0);                   // linha 0: o termo pode começar em qualquer posição
        let ini = Array.from({ length: n + 1 }, (_, j) => j);
        for (let i = 1; i <= m; i++) {
            const lin = new Array(n + 1), linIni = new Array(n + 1);
            lin[0] = i;
            linIni[0] = 0;
            let menor = i;
            for (let j = 1; j <= n; j++) {
                let v = ant[j - 1] + (termo[i - 1] === texto[j - 1] ? 0 : 1), s = ini[j - 1];
                if (ant[j] + 1 < v) { v = ant[j] + 1; s = ini[j]; }
                if (lin[j - 1] + 1 < v) { v = lin[j - 1] + 1; s = linIni[j - 1]; }
                if (i > 1 && j > 1 && termo[i - 1] === texto[j - 2] && termo[i - 2] === texto[j - 1] && ant2[j - 2] + 1 < v) {
                    v = ant2[j - 2] + 1;
                    s = ini2[j - 2];
                }
                lin[j] = v;
                linIni[j] = s;
                if (v < menor) menor = v;
            }
            if (menor > maxErros) return null;
            ant2 = ant; ini2 = ini; ant = lin; ini = linIni;
        }
        let melhor = null;
        for (let j = 1; j <= n; j++) {
            if (ant[j] <= maxErros && (!melhor || ant[j] < melhor.erros)) melhor = { erros: ant[j], inicio: ini[j], fim: j };
        }
        return melhor;
    }

    // Todos os termos precisam aparecer. Pontos menores = melhor: termo exato no começo de uma palavra vale 0,
    // no meio de uma palavra 1, com erros de digitação 10 por erro.
    function compararOpcaoBusca(termos, texto) {
        let pontos = 0;
        const trechos = [];
        for (const termo of termos) {
            const i = texto.indexOf(termo);
            if (i >= 0) {
                if (i > 0 && /[a-z0-9]/.test(texto[i - 1])) pontos += 1;
                trechos.push([i, i + termo.length]);
                continue;
            }
            const tolerancia = toleranciaBusca(termo.length);
            const aproximado = tolerancia ? buscarAproximado(termo, texto, tolerancia) : null;
            if (!aproximado) return null;
            pontos += 10 * aproximado.erros;
            trechos.push([aproximado.inicio, aproximado.fim]);
        }
        return { pontos, trechos };
    }

    function preencherComRealce(el, texto, trechos) {
        const doc = el.ownerDocument;
        if (!texto) { el.textContent = ' '; return; }
        const ordenados = trechos.filter(t => t[1] > t[0]).sort((a, b) => a[0] - b[0]);
        let pos = 0;
        for (const [inicio, fim] of ordenados) {
            const de = Math.max(inicio, pos);
            if (fim <= de) continue;
            if (de > pos) el.appendChild(doc.createTextNode(texto.slice(pos, de)));
            const marca = doc.createElement('mark');
            marca.textContent = texto.slice(de, fim);
            el.appendChild(marca);
            pos = fim;
        }
        if (pos < texto.length) el.appendChild(doc.createTextNode(texto.slice(pos)));
    }

    function listaComBusca(el) {
        return !!(config.buscaListas && el && el.tagName === 'SELECT' && !el.multiple && !(el.size > 1) && !el.disabled &&
                  el.options.length > config.buscaListasMinimo);
    }

    function cssBuscaLista(doc) {
        if (doc.getElementById('dnf-busca-css')) return;
        const estilo = doc.createElement('style');
        estilo.id = 'dnf-busca-css';
        estilo.textContent = CSS_BUSCA_LISTA;
        (doc.head || doc.documentElement).appendChild(estilo);
    }

    function instalarBuscaListas(doc) {
        if (!doc || doc.__buscaListas) return;
        doc.__buscaListas = true;
        const win = doc.defaultView;
        let botao = null, alvo = null, sobre = false, esconder = null, seguir = null;

        const criarBotao = () => {
            cssBuscaLista(doc);
            botao = doc.createElement('button');
            botao.type = 'button';
            botao.id = 'dnf-lupa';
            botao.tabIndex = -1;
            botao.appendChild(svgLupa(doc));
            // mousedown sem padrão: a lista não perde o foco antes da hora (o GeneXus valida o campo no blur)
            botao.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
            botao.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const lista = alvo;
                ocultar();
                if (listaComBusca(lista)) abrirBuscaLista(lista, 'busca');
            });
            botao.addEventListener('mouseenter', () => { sobre = true; clearTimeout(esconder); });
            botao.addEventListener('mouseleave', () => { sobre = false; agendarOcultar(); });
        };

        const mostrar = (lista) => {
            clearTimeout(esconder);
            if (buscaAberta && buscaAberta.select === lista) return;
            if (!botao) criarBotao();
            alvo = lista;
            botao.title = config.atalhos.buscaLista ? `Buscar na lista (${nomeAtalho(config.atalhos.buscaLista)})` : 'Buscar na lista';
            if (!botao.isConnected) doc.body.appendChild(botao);
            // A tela pode mudar de lugar com o botão na tela (tema, GeneXus redesenhando): acompanha a lista
            if (!seguir) seguir = setInterval(() => { if (alvo && alvo.isConnected && alvo.offsetParent) posicionar(alvo); else ocultar(); }, 250);
            posicionar(lista);
        };
        const posicionar = (lista) => {
            // Segmento dentro da própria lista, colado à esquerda da seta, da altura dela (fora da lista, nas grades
            // do GeneXus, cobriria outro campo; maior que ela, cobriria as linhas de cima e de baixo)
            const caixa = lista.getBoundingClientRect();
            const alto = Math.max(12, Math.round(caixa.height) - 2);
            const largo = Math.min(24, Math.max(16, Math.round(caixa.width) - 60));
            const icone = Math.max(9, Math.min(13, Math.round(alto * 0.62)));
            botao.style.width = `${largo}px`;
            botao.style.height = `${alto}px`;
            botao.firstChild.style.width = botao.firstChild.style.height = `${icone}px`;
            botao.style.left = `${Math.max(caixa.left + 1, caixa.right - 1 - LARGURA_SETA_LISTA - largo) + win.scrollX}px`;
            botao.style.top = `${caixa.top + 1 + win.scrollY}px`;
        };
        const ocultar = () => {
            clearTimeout(esconder);
            clearInterval(seguir);
            seguir = null;
            if (botao) botao.remove();
            alvo = null;
            sobre = false;
        };
        const agendarOcultar = () => {
            clearTimeout(esconder);
            esconder = setTimeout(() => {
                if (!alvo || sobre) return;
                if (doc.activeElement === alvo || alvo.matches(':hover')) return;
                ocultar();
            }, 350);
        };
        doc.__dnfLupa = { mostrar, ocultar, alvo: () => alvo };

        // Clique numa lista longa: a nossa lista no lugar da do navegador (mesmo teclado; ver abrirBuscaLista).
        // O mousedown é quando o navegador abre a dele; cancelando, só a nossa aparece. O foco vai para a lista,
        // como no clique normal.
        doc.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !e.target || !e.target.closest) return;
            const lista = e.target.closest('select');
            if (!listaComBusca(lista)) return;
            e.preventDefault();
            if (buscaAberta && buscaAberta.select === lista) {       // segundo clique fecha, como na lista normal
                buscaAberta.fechar(true);
                return;
            }
            lista.focus();
            abrirBuscaLista(lista, 'lista');
        }, true);
        // Teclas que abrem a lista do navegador (F4, Alt+Seta, Espaço) abrem a nossa. Digitar e as setas com a
        // lista fechada continuam como no navegador (mudam a opção direto).
        doc.addEventListener('keydown', (e) => {
            const lista = e.target;
            if (!listaComBusca(lista) || (buscaAberta && buscaAberta.select === lista)) return;
            const abre = e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) ||
                         (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey);
            if (!abre) return;
            e.preventDefault();
            e.stopPropagation();
            abrirBuscaLista(lista, 'lista');
        }, true);

        doc.addEventListener('focusin', (e) => { if (listaComBusca(e.target)) mostrar(e.target); }, true);
        doc.addEventListener('focusout', (e) => { if (e.target === alvo) agendarOcultar(); }, true);
        doc.addEventListener('mouseover', (e) => {
            const lista = e.target && e.target.closest ? e.target.closest('select') : null;
            if (listaComBusca(lista)) mostrar(lista);
        }, true);
        doc.addEventListener('mouseout', (e) => {
            if (alvo && e.target && e.target.closest && e.target.closest('select') === alvo) agendarOcultar();
        }, true);
        win.addEventListener('scroll', () => { if (alvo) mostrar(alvo); }, true);
        win.addEventListener('resize', () => { if (alvo) mostrar(alvo); });
    }

    // Lupa em SVG (botão das listas e barra "Buscar na lista")
    function svgLupa(doc) {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        const c = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', '6.5'); c.setAttribute('cy', '6.5'); c.setAttribute('r', '4.5');
        const l = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        l.setAttribute('d', 'M10 10l4.5 4.5');
        svg.append(c, l);
        return svg;
    }

    // Abre o painel de uma lista longa. modo 'lista': no lugar da lista do navegador, com o mesmo teclado dela
    // (digitar o começo, a mesma letra de novo passa para a próxima, setas, Enter/Tab escolhem, Esc fecha) e o
    // foco continua na própria lista; a barra "Buscar na lista" no alto (ou o atalho) passa para o modo 'busca'.
    // modo 'busca': campo de busca no alto (o foco vai para ele), filtrando por palavras com erros tolerados.
    function abrirBuscaLista(lista, modo = 'busca') {
        if (buscaAberta && buscaAberta.select === lista) {      // já aberta nesta lista: só troca para a busca
            if (modo === 'busca') buscaAberta.buscar();
            return;
        }
        if (buscaAberta) buscaAberta.fechar(false);
        const doc = lista.ownerDocument, win = doc.defaultView;
        if (!doc.body) return;
        cssBuscaLista(doc);
        if (doc.__dnfLupa) doc.__dnfLupa.ocultar();

        const itens = [];
        [...lista.options].forEach((opcao, indice) => {
            if (opcao.hidden) return;
            const texto = (opcao.label || opcao.text || '').replace(/\s+/g, ' ').trim();
            itens.push({ opcao, indice, texto, normal: normalizarBusca(texto) });
        });

        const painel = doc.createElement('div');
        painel.id = 'dnf-busca';
        const barra = doc.createElement('div');
        barra.className = 'dnf-barra-busca';
        barra.title = 'Buscar por parte do nome, em qualquer ordem, sem acentos';
        const tituloBarra = doc.createElement('b');
        tituloBarra.textContent = 'Buscar na lista';
        barra.append(svgLupa(doc), tituloBarra);
        if (config.atalhos.buscaLista) {
            const kbd = doc.createElement('kbd');
            kbd.textContent = nomeAtalho(config.atalhos.buscaLista);
            barra.appendChild(kbd);
        }
        const campo = doc.createElement('input');
        campo.type = 'text';
        campo.autocomplete = 'off';
        campo.spellcheck = false;
        campo.placeholder = 'Digite para buscar...';
        campo.setAttribute('aria-label', 'Buscar na lista');
        const ul = doc.createElement('ul');
        ul.setAttribute('role', 'listbox');
        const rodape = doc.createElement('div');
        rodape.className = 'dnf-rodape';
        painel.append(barra, campo, ul, rodape);
        let visiveis = [], marcada = -1, modoAtual = modo;
        let digitado = '', ultimaTecla = 0;
        painel.className = `dnf-modo-${modo}`;

        function marcar(n, rolar) {
            const anterior = ul.querySelector('li.dnf-marcada');
            if (anterior) anterior.classList.remove('dnf-marcada');
            marcada = n;
            const li = n >= 0 ? ul.children[n] : null;
            if (!li || li.classList.contains('dnf-vazio')) { marcada = -1; return; }
            li.classList.add('dnf-marcada');
            if (rolar) {
                if (li.offsetTop < ul.scrollTop) ul.scrollTop = li.offsetTop;
                else if (li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = li.offsetTop + li.offsetHeight - ul.clientHeight;
            }
        }

        function desenhar() {
            const termos = modoAtual === 'busca' ? normalizarBusca(campo.value).split(/\s+/).filter(Boolean) : [];
            if (!termos.length) {
                visiveis = itens.map(item => ({ item, trechos: [] }));
            } else {
                visiveis = [];
                itens.forEach(item => {
                    const r = compararOpcaoBusca(termos, item.normal);
                    if (r) visiveis.push({ item, trechos: r.trechos, pontos: r.pontos });
                });
                visiveis.sort((a, b) => a.pontos - b.pontos || a.item.indice - b.item.indice);
            }
            // No modo lista vão todas (como a lista do navegador); na busca, até MAX_ITENS_BUSCA
            const limite = modoAtual === 'lista' ? 5000 : MAX_ITENS_BUSCA;
            const desenhados = visiveis.slice(0, limite);
            const fragmento = doc.createDocumentFragment();
            desenhados.forEach(({ item, trechos }) => {
                const li = doc.createElement('li');
                li.setAttribute('role', 'option');
                li.title = item.texto;
                preencherComRealce(li, item.texto || ' ', trechos);
                if (item.indice === lista.selectedIndex) li.classList.add('dnf-atual');
                if (item.opcao.disabled) li.classList.add('dnf-desativada');
                fragmento.appendChild(li);
            });
            if (!desenhados.length) {
                const li = doc.createElement('li');
                li.className = 'dnf-vazio';
                li.textContent = 'Nenhuma opção encontrada';
                fragmento.appendChild(li);
            }
            ul.textContent = '';
            ul.appendChild(fragmento);
            ul.scrollTop = 0;
            rodape.textContent = (termos.length ? `${visiveis.length} de ${itens.length} opções` : `${itens.length} opções`) +
                                 (visiveis.length > limite ? ` (mostrando ${limite}; digite mais para filtrar)` : '');
            // Sem busca, começa na opção atual; com busca, na melhor
            const atual = termos.length ? -1 : desenhados.findIndex(v => v.item.indice === lista.selectedIndex);
            marcar(atual >= 0 ? atual : (desenhados.length ? 0 : -1), true);
        }

        // devolverFoco: false quando o foco segue sozinho (Tab)
        function escolher(n, devolverFoco = true) {
            const v = visiveis[n];
            if (!v || v.item.opcao.disabled) { fechar(devolverFoco); return; }
            const mudou = lista.selectedIndex !== v.item.indice;
            fechar(devolverFoco);
            if (mudou) {
                lista.selectedIndex = v.item.indice;
                lista.dispatchEvent(new win.Event('input', { bubbles: true }));
                lista.dispatchEvent(new win.Event('change', { bubbles: true }));
            }
        }

        function fechar(devolverFoco) {
            if (buscaAberta !== controle) return;
            buscaAberta = null;
            painel.remove();
            lista.removeEventListener('keydown', teclaLista, true);
            lista.removeEventListener('blur', saiuDaLista);
            doc.removeEventListener('mousedown', cliqueFora, true);
            doc.removeEventListener('scroll', rolagemFora, true);
            win.removeEventListener('resize', fecharSemFoco);
            win.removeEventListener('blur', fecharSemFoco);
            if (devolverFoco && lista.isConnected) {
                if (doc.activeElement !== lista) lista.focus();
                if (doc.__dnfLupa) doc.__dnfLupa.mostrar(lista);
            }
        }
        const fecharSemFoco = () => fechar(false);
        const cliqueFora = (e) => {
            if (!painel.contains(e.target) && e.target !== lista) fechar(false);
        };
        const rolagemFora = (e) => { if (e.target !== ul) fechar(false); };
        const saiuDaLista = () => { if (modoAtual === 'lista') fechar(false); };

        // Passa do modo lista para a busca (barra do alto ou atalho)
        function buscar() {
            if (modoAtual === 'busca') { campo.focus(); return; }
            modoAtual = 'busca';
            painel.className = 'dnf-modo-busca';
            campo.focus();
            desenhar();
        }

        const totalDesenhado = () => Math.min(visiveis.length, modoAtual === 'lista' ? 5000 : MAX_ITENS_BUSCA);
        const mover = (n) => { const total = totalDesenhado(); if (total) marcar(Math.max(0, Math.min(total - 1, n)), true); };
        const passo = () => Math.max(1, Math.floor(ul.clientHeight / 20) - 1);

        // Digitar com a lista aberta, como no navegador: o começo da opção; a mesma letra repetida vai para a
        // próxima opção com ela ("AA" = a segunda com A); depois de 1 s sem digitar, recomeça
        function digitar(letra) {
            const agora = Date.now();
            if (agora - ultimaTecla > 1000) digitado = '';
            ultimaTecla = agora;
            digitado += normalizarBusca(letra);
            const total = totalDesenhado();
            if (!total) return;
            const repetida = [...digitado].every(c => c === digitado[0]);
            const procura = repetida ? digitado[0] : digitado;
            const inicio = repetida ? marcada + 1 : Math.max(0, marcada);
            for (let k = 0; k < total; k++) {
                const n = (inicio + k + total) % total;
                const v = visiveis[n].item;
                if (!v.opcao.disabled && v.normal.startsWith(procura)) { marcar(n, true); return; }
            }
        }

        // Teclado do modo lista (o foco está na própria lista; o atalho da busca é tratado em tratarTecla)
        function teclaLista(e) {
            if (modoAtual !== 'lista') return;
            switch (e.key) {
                case 'ArrowDown': if (e.altKey) escolher(marcada); else mover(marcada + 1); break;
                case 'ArrowUp': if (e.altKey) escolher(marcada); else mover(marcada - 1); break;
                case 'PageDown': mover(marcada + passo()); break;
                case 'PageUp': mover(marcada - passo()); break;
                case 'Home': mover(0); break;
                case 'End': mover(totalDesenhado() - 1); break;
                case 'Enter': case 'F4': escolher(marcada); break;
                case 'Escape': fechar(true); break;
                case 'Tab': escolher(marcada, false); return;     // escolhe e deixa o Tab seguir para o próximo campo
                default:
                    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
                    if (e.key === ' ' && !digitado) { escolher(marcada); break; }
                    digitar(e.key);
            }
            e.preventDefault();
            e.stopPropagation();
        }

        campo.addEventListener('input', desenhar);
        campo.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'ArrowDown': mover(marcada + 1); break;
                case 'ArrowUp': mover(marcada - 1); break;
                case 'PageDown': mover(marcada + passo()); break;
                case 'PageUp': mover(marcada - passo()); break;
                case 'Enter': escolher(marcada); break;
                case 'Escape': case 'Tab': case 'F4': fechar(true); break;
                default: return;
            }
            e.preventDefault();
            e.stopPropagation();
        });
        barra.addEventListener('mousedown', (e) => e.preventDefault());
        barra.addEventListener('click', buscar);
        ul.addEventListener('mousedown', (e) => e.preventDefault());   // o foco fica onde está (lista ou campo)
        ul.addEventListener('mousemove', (e) => {
            const li = e.target.closest('li');
            const n = li ? [...ul.children].indexOf(li) : -1;
            if (n >= 0 && n !== marcada) marcar(n, false);
        });
        ul.addEventListener('click', (e) => {
            const li = e.target.closest('li');
            if (li) escolher([...ul.children].indexOf(li));
        });

        const controle = { select: lista, fechar, buscar, modo: () => modoAtual };
        buscaAberta = controle;

        // Posição: logo abaixo da lista (ou acima, se embaixo não couber), sem sair da tela
        doc.body.appendChild(painel);
        const caixa = lista.getBoundingClientRect();
        const larguraTela = doc.documentElement.clientWidth || win.innerWidth;
        const alturaTela = doc.documentElement.clientHeight || win.innerHeight;
        const abaixo = alturaTela - caixa.bottom - 6, acima = caixa.top - 6;
        const paraCima = abaixo < 220 && acima > abaixo;
        painel.style.minWidth = `${Math.min(Math.max(caixa.width, 240), larguraTela - 8)}px`;
        painel.style.maxWidth = `${Math.max(160, Math.min(620, larguraTela - 8))}px`;
        painel.style.maxHeight = `${Math.max(140, Math.min(380, paraCima ? acima : abaixo))}px`;
        desenhar();
        painel.style.width = `${painel.offsetWidth}px`;           // não muda de largura enquanto filtra
        painel.style.left = `${Math.max(4, Math.min(caixa.left, larguraTela - painel.offsetWidth - 4))}px`;
        if (paraCima) painel.style.bottom = `${alturaTela - caixa.top + 2}px`;
        else painel.style.top = `${caixa.bottom + 1}px`;
        marcar(marcada, true);
        if (modo === 'busca') campo.focus();
        else if (doc.activeElement !== lista) lista.focus();

        lista.addEventListener('keydown', teclaLista, true);
        lista.addEventListener('blur', saiuDaLista);
        doc.addEventListener('mousedown', cliqueFora, true);
        doc.addEventListener('scroll', rolagemFora, true);
        win.addEventListener('resize', fecharSemFoco);
        win.addEventListener('blur', fecharSemFoco);
    }

    // ---------------------------------------------------------------------------------------------
    // Documentos da OS em janelas. Na impressão da OS (wp_osimpressao.aspx: Oficina > Ordem de Serviço >
    // alterar > Imprimir), com documentos marcados (termos, comprovantes), o DealerNet abre a OS numa janela,
    // recarrega a tela e mostra "Download Documento(s)" (evento E'BAIXARDOC'.), que baixa um ZIP (2 ou mais
    // documentos; ZIP64, nomes em CP850) ou o PDF (1 documento). Aqui: quando o link aparece depois de Imprimir,
    // ele é disparado sozinho e, em vez de baixar, o arquivo é lido, o ZIP é aberto no navegador e cada PDF vai para
    // uma janela do portal, pronta para imprimir (clicar no link depois faz o mesmo). O servidor só entrega o
    // arquivo uma vez. Se algo falhar, cai no download normal. Ligar/desligar: config.documentosOSJanelas (aba
    // Janelas e telas, ou a caixa que aparece embaixo da lista de documentos da própria tela).
    // As chaves e o id da caixa são os mesmos do userscript avulso "termos-os.user.js": com os dois instalados,
    // só um age.
    // ---------------------------------------------------------------------------------------------
    const MARCA_DOCUMENTOS_OS = 'dnfDocumentosOS';     // sessionStorage: acabou de mandar imprimir com documentos
    const VALIDADE_MARCA_DOCUMENTOS = 2 * 60 * 1000;
    const EVENTO_BAIXAR_DOCUMENTOS = "E'BAIXARDOC'.";
    const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

    function textoCp850(bytes) {
        let s = '';
        for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP850[b - 128];
        return s;
    }

    async function descomprimirDeflate(bytes) {
        const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(fluxo).arrayBuffer());
    }

    // Leitor de ZIP simples (guardado ou deflate), com ZIP64 (campos 0xFFFFFFFF + campo extra 0x0001)
    async function lerZip(buffer) {
        const v = new DataView(buffer), u8 = new Uint8Array(buffer);
        let fim = -1;
        for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
            if (v.getUint32(i, true) === 0x06054b50) { fim = i; break; }
        }
        if (fim < 0) throw new Error('ZIP inválido (fim do diretório não encontrado)');
        const total = v.getUint16(fim + 10, true);
        let p = v.getUint32(fim + 16, true);
        const arquivos = [];
        for (let k = 0; k < total; k++) {
            if (v.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP inválido (diretório)');
            const flags = v.getUint16(p + 8, true), metodo = v.getUint16(p + 10, true);
            let tamanho = v.getUint32(p + 20, true), original = v.getUint32(p + 24, true);
            const tamNome = v.getUint16(p + 28, true), tamExtra = v.getUint16(p + 30, true), tamComentario = v.getUint16(p + 32, true);
            let local = v.getUint32(p + 42, true);
            if (tamanho === 0xFFFFFFFF || original === 0xFFFFFFFF || local === 0xFFFFFFFF) {
                for (let e = p + 46 + tamNome; e + 4 <= p + 46 + tamNome + tamExtra;) {
                    const id = v.getUint16(e, true), tam = v.getUint16(e + 2, true);
                    if (id === 0x0001) {
                        let q = e + 4;
                        const ler64 = () => { const n = Number(v.getBigUint64(q, true)); q += 8; return n; };
                        if (original === 0xFFFFFFFF) original = ler64();
                        if (tamanho === 0xFFFFFFFF) tamanho = ler64();
                        if (local === 0xFFFFFFFF) local = ler64();
                        break;
                    }
                    e += 4 + tam;
                }
            }
            const bytesNome = u8.subarray(p + 46, p + 46 + tamNome);
            const nome = (flags & 0x800) ? new TextDecoder('utf-8').decode(bytesNome) : textoCp850(bytesNome);
            p += 46 + tamNome + tamExtra + tamComentario;
            if (nome.endsWith('/')) continue;
            const inicio = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
            const dados = u8.subarray(inicio, inicio + tamanho);
            if (metodo === 0) arquivos.push({ nome, dados });
            else if (metodo === 8) arquivos.push({ nome, dados: await descomprimirDeflate(dados) });
            else throw new Error(`ZIP com compressão não suportada (${metodo}) em ${nome}`);
        }
        return arquivos;
    }

    // Janela do portal mostrando um PDF (blob desta página: vale enquanto o portal estiver aberto). O portal só
    // carrega endereços dele (tudo passa pelo redirect.asp), então a janela abre num endereço único qualquer e o
    // quadro dela passa a mostrar o blob. A janela guarda o documento para Duplicar e Reabrir.
    let contadorDocumentos = 0;
    function abrirJanelaDocumento(titulo, url, deslocamento = 0) {
        const antes = new Set(oW5Portal.windows.map(w => w.id));
        oW5Portal.createWindow({ windows: [{
            title: titulo,
            url: `about:blank#documento-os-${Date.now()}-${++contadorDocumentos}`,
            width: 800, height: 500, maximized: false
        }] });
        const janela = oW5Portal.windows.find(w => !antes.has(w.id));
        if (!janela) { window.open(url, '_blank'); return null; }
        janela.__dnfDocumento = { url, titulo };
        let tentativas = 0;
        const apontar = () => {
            const quadro = janela.el && janela.el.dom.querySelector('iframe');
            if (quadro) { quadro.src = url; return; }
            if (++tentativas < 50) setTimeout(apontar, 100);
        };
        apontar();
        if (deslocamento) {
            try {                                  // em cascata, para não ficarem uma em cima da outra
                const [x, y] = janela.getPosition();
                janela.setPosition(x + 28 * deslocamento, y + 28 * deslocamento);
            } catch (e) { /* posição é só conforto */ }
        }
        return janela;
    }

    // "aprc_download.aspx?C:\...\ARQUIVO.ZIP,ARQUIVO.ZIP,zip" -> { nome, tipo }
    function infoDownloadOS(url) {
        const partes = (url.split('?')[1] || '').split(',');
        const decod = (s) => { try { return decodeURIComponent((s || '').replace(/\+/g, ' ')); } catch (e) { return s || ''; } };
        return { nome: decod(partes[partes.length - 2]), tipo: decod(partes[partes.length - 1]).toLowerCase() };
    }

    async function abrirDocumentosOS(win, doc, url) {
        const resposta = await fetch(new URL(url, win.location.href).href, { credentials: 'same-origin' });
        if (!resposta.ok) throw new Error(`download respondeu ${resposta.status}`);
        const buffer = await resposta.arrayBuffer();
        const inicio = new Uint8Array(buffer, 0, 4);
        let documentos;
        if (inicio[0] === 0x50 && inicio[1] === 0x4b) {
            documentos = (await lerZip(buffer)).filter(a => /\.pdf$/i.test(a.nome));
        } else if (String.fromCharCode(...inicio) === '%PDF') {
            documentos = [{ nome: infoDownloadOS(url).nome, dados: new Uint8Array(buffer) }];
        } else {
            throw new Error('o arquivo não é ZIP nem PDF');
        }
        if (!documentos.length) throw new Error('nenhum PDF no arquivo');
        // Na ordem da lista de documentos da tela; título "<documento> - OS <número>"
        const linhas = [...doc.querySelectorAll('input[type=checkbox][name^="vSEL_"]')]
            .map(c => (c.closest('tr') ? c.closest('tr').innerText : '').replace(/\s+/g, ' ').trim().toUpperCase());
        const posicao = (nome) => { const i = linhas.findIndex(l => l.includes(nome.toUpperCase())); return i < 0 ? 999 : i; };
        documentos.forEach(d => { d.titulo = d.nome.replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '').trim(); });
        documentos.sort((a, b) => posicao(a.titulo) - posicao(b.titulo));
        const campoOS = doc.getElementById('vOS_NUMEROPRINT');
        const os = (campoOS && campoOS.value ? campoOS.value.trim() : '') ||
                   (((doc.title || '') + ' ' + doc.body.innerText).match(/Impress[aã]o da OS\s+(\d+)/i) || [])[1] || '';
        documentos.forEach((d, i) => {
            const blob = URL.createObjectURL(new Blob([d.dados], { type: 'application/pdf' }));
            abrirJanelaDocumento(os ? `${d.titulo} - OS ${os}` : d.titulo, blob, i);
        });
        return documentos.length;
    }

    function avisoDocumentosOS(doc, texto, duracao) {
        let caixa = doc.getElementById('dnfDocumentosOSAviso');
        if (!caixa) {
            caixa = elemento(doc, 'div', { id: 'dnfDocumentosOSAviso' });
            caixa.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:8px 12px;' +
                'background-color:#1f2328;color:#ffffff;border-radius:6px;font:12px Tahoma,Arial,sans-serif;' +
                'box-shadow:0 4px 14px rgba(0,0,0,.3)';
            doc.body.appendChild(caixa);
        }
        caixa.textContent = texto;
        caixa.style.display = '';
        clearTimeout(caixa.__timer);
        if (duracao) caixa.__timer = setTimeout(() => { caixa.style.display = 'none'; }, duracao);
    }

    // Corrida do portal: Imprimir faz a tela de impressão se recarregar e, ao mesmo tempo, abre a janela do PDF da
    // OS (aprc_oficinahtml.aspx). A recarga passa por notauthorizedscreen.aspx, que manda a tela para o último
    // endereço que o servidor registrou na sessão: se o pedido da janela do PDF chegar antes, a tela de impressão
    // vira o PDF e o link "Download Documento(s)" se perde. Sem a extensão a recarga costuma ganhar; com ela, nem
    // sempre. Então, logo depois de Imprimir, a janela do PDF espera a tela de impressão terminar de recarregar
    // (no máximo ESPERA_JANELA_IMPRESSAO).
    const ESPERA_JANELA_IMPRESSAO = 8000;
    let impressaoOS = null;                   // { fila: [abrir...] } enquanto a tela de impressão recarrega

    function envolverCreateWindowOS() {
        if (oW5Portal.createWindow.__documentosOS) return;
        const original = oW5Portal.createWindow;
        const novo = function (source) {
            const w = source && source.windows && source.windows[0];
            if (impressaoOS && w && /aprc_oficinahtml\.aspx/i.test(w.url || '')) {
                const self = this, args = arguments;
                impressaoOS.fila.push(() => original.apply(self, args));
                return undefined;
            }
            return original.apply(this, arguments);
        };
        novo.__documentosOS = true;
        oW5Portal.createWindow = novo;
    }

    function liberarJanelasImpressaoOS() {
        if (!impressaoOS) return;
        const { fila, timer } = impressaoOS;
        impressaoOS = null;
        clearTimeout(timer);
        fila.forEach(abrir => { try { abrir(); } catch (e) { console.warn(`[${NOME_SCRIPT}] Impressão da OS`, e); } });
    }

    // Chamado por instrumentarIframe em cada carga de wp_osimpressao.aspx
    function instalarDocumentosOS(win, doc) {
        if (!/wp_osimpressao\.aspx/i.test(win.location.pathname) || doc.__documentosOS) return;
        doc.__documentosOS = true;
        envolverCreateWindowOS();
        if (impressaoOS) setTimeout(liberarJanelasImpressaoOS, 300);     // recarregou depois de Imprimir
        let tentativas = 0;
        const preparar = () => {
            const gx = win.gx;
            if (!gx || !gx.http || typeof gx.http.redirect !== 'function' || !doc.body) {
                if (++tentativas < 40) setTimeout(preparar, 250);
                return;
            }
            // 1. O fim do link (gx.http.redirect para aprc_download.aspx): abre as janelas em vez de baixar
            if (!gx.http.redirect.__documentosOS) {
                const original = gx.http.redirect;
                const novo = function (url) {
                    const info = config.documentosOSJanelas && typeof url === 'string' && /aprc_download\.aspx\?/i.test(url) ? infoDownloadOS(url) : null;
                    if (!info || (info.tipo !== 'zip' && info.tipo !== 'pdf')) return original.apply(this, arguments);
                    const self = this, args = arguments;
                    const liberar = () => {
                        try { if (gx.evt && gx.evt.setProcessing) gx.evt.setProcessing(false); } catch (e) { /* nada */ }
                        try { if (gx.ajax && gx.ajax.enableForm) gx.ajax.enableForm(); } catch (e) { /* nada */ }
                    };
                    avisoDocumentosOS(doc, 'Abrindo os documentos...');
                    abrirDocumentosOS(win, doc, url).then((n) => {
                        liberar();
                        avisoDocumentosOS(doc, n === 1 ? 'Documento aberto numa janela.' : `${n} documentos abertos, um em cada janela.`, 3000);
                    }, (erro) => {
                        console.warn(`[${NOME_SCRIPT}] Documentos da OS: não consegui abrir; baixando como antes`, erro);
                        liberar();
                        avisoDocumentosOS(doc, 'Não consegui abrir os documentos; baixando o arquivo.', 4000);
                        original.apply(self, args);
                    });
                };
                novo.__documentosOS = true;
                gx.http.redirect = novo;
            }
            // 2. Caixa de ligar/desligar embaixo da lista de documentos (muda a mesma configuração da aba Janelas e telas)
            const marcador = doc.querySelector('input[type=checkbox][name^="vSEL_"]');
            const grade = doc.getElementById('GriddocContainerDiv') || (marcador && marcador.closest('table'));
            if (grade && grade.parentNode && !doc.getElementById('dnfDocumentosOSOpcao')) {
                const caixa = elemento(doc, 'input', { type: 'checkbox', checked: !!config.documentosOSJanelas });
                caixa.style.verticalAlign = '-2px';
                caixa.addEventListener('change', () => {
                    const novo = copiar(config);
                    novo.documentosOSJanelas = caixa.checked;
                    salvarConfig(novo);
                });
                const linha = elemento(doc, 'div', { id: 'dnfDocumentosOSOpcao' },
                    elemento(doc, 'label', { title: `${NOME_EXIBICAO}: ao imprimir com documentos marcados, abre cada documento numa ` +
                        'janela, pronto para imprimir, em vez de baixar um ZIP. Também em Configurações > Janelas e telas.' },
                        caixa, ' Abrir os documentos em janelas (em vez de baixar)'));
                linha.style.cssText = 'margin:6px 0;font:12px Tahoma,Arial,sans-serif;cursor:pointer';
                grade.parentNode.insertBefore(linha, grade.nextSibling);
            }
            // 3. Logo depois de Imprimir com documentos marcados: dispara o link quando ele aparecer
            let quando = 0;
            try { quando = Number(sessionStorage.getItem(MARCA_DOCUMENTOS_OS)) || 0; } catch (e) { /* sem sessionStorage */ }
            if (config.documentosOSJanelas && quando && Date.now() - quando < VALIDADE_MARCA_DOCUMENTOS) {
                let vezes = 0;
                const tentar = () => {
                    const link = [...doc.querySelectorAll('a[href*="BAIXARDOC"]')].find(a => a.offsetParent);
                    if (link && gx.evt) {
                        try { sessionStorage.removeItem(MARCA_DOCUMENTOS_OS); } catch (e) { /* nada */ }
                        gx.evt.execEvt(EVENTO_BAIXAR_DOCUMENTOS, link);
                        return;
                    }
                    if (++vezes < 40) setTimeout(tentar, 250);
                };
                setTimeout(tentar, 300);
            }
        };
        // Imprimir: segura a janela do PDF até a tela recarregar; com algum documento marcado, lembra de abrir os
        // documentos (a tela recarrega antes do link aparecer)
        doc.addEventListener('click', (e) => {
            if (!e.target.closest || !e.target.closest('#IMGCONFIRMA')) return;
            if (!impressaoOS) impressaoOS = { fila: [], timer: setTimeout(liberarJanelasImpressaoOS, ESPERA_JANELA_IMPRESSAO) };
            if (!config.documentosOSJanelas) return;
            const algum = [...doc.querySelectorAll('input[type=checkbox][name^="vSEL_"]')].some(c => c.checked);
            try {
                if (algum) sessionStorage.setItem(MARCA_DOCUMENTOS_OS, String(Date.now()));
                else sessionStorage.removeItem(MARCA_DOCUMENTOS_OS);
            } catch (err) { /* nada */ }
        }, true);
        preparar();
    }

    // ---------------------------------------------------------------------------------------------
    // Notificação de fluxos
    // ---------------------------------------------------------------------------------------------

    // Fluxos conhecidos: lista da tela "Definições" + os que já apareceram na Caixa de Entrada
    function carregarFluxosVistos() {
        try {
            return JSON.parse(localStorage.getItem(CHAVE_FLUXOS_VISTOS)) || {};
        } catch (e) {
            return {};
        }
    }

    let fluxosVistos = carregarFluxosVistos();   // codigo (minúsculo) -> { codigo, nome }
    const fluxosConhecidos = new Map();          // codigo (minúsculo) -> { codigo, nome }
    listaFluxosPadrao().forEach(([nome, codigo]) => fluxosConhecidos.set(codigo.toLowerCase(), { codigo, nome }));

    function todosOsFluxos() {
        const todos = new Map(fluxosConhecidos);
        Object.entries(fluxosVistos).forEach(([chave, dados]) => {
            if (!todos.has(chave)) todos.set(chave, dados);
        });
        return todos;
    }

    const estadoFluxos = {
        contagens: null,         // Map codigo -> quantidade da última leitura (null = ainda não leu)
        atuais: [],              // fluxos habilitados com itens, da última leitura
        novidade: false,         // chegou algo novo que o usuário ainda não viu
        silenciarProxima: false, // próxima leitura só registra (ex.: depois de mudar as configurações)
        vazioPendente: false,    // última leitura veio vazia; aguardando confirmação
        filtro: null,            // filtros da Caixa de Entrada na última leitura (período, assunto, "Visualizar Todos")
        assinatura: null,        // lista da última leitura, para saber se mudou
        absorverAte: 0,          // até quando a próxima mudança da lista é atribuída a uma troca de filtro
        timerLeitura: null,
        timerAtualizacao: null,
        timerEmBreve: null
    };

    function iframeTelaInicial() {
        return [...document.querySelectorAll('iframe.W5Portal_Window_Frame')].find(f => !f.closest('.x-window'));
    }

    // Lê a lista de fluxos da Caixa de Entrada. Retorna null se ela não está visível (outra aba, carregando...)
    function lerFluxosDaTela() {
        const iframe = iframeTelaInicial();
        let doc;
        try {
            doc = iframe && iframe.contentDocument;
        } catch (e) {
            return null;
        }
        if (!doc || doc.readyState !== 'complete') return null;
        if (iframe.contentWindow.__barraTarefasPendentes > 0 || iframe.contentWindow.__barraTarefasSaindo) return null;

        const spans = [...doc.querySelectorAll('span[id*="vTMPFLUXOPROCESSO_DESCRICAO_"]')];
        if (!spans.length) {
            // Grade de fluxos existe mas está vazia: nenhum fluxo pendente
            return doc.querySelector('[id$="GridfluxoContainerTbl"]') ?
                { prefixo: null, fluxos: [], filtro: filtroDaTela(doc), win: iframe.contentWindow } : null;
        }

        let prefixo = null;
        const fluxos = [];
        for (const span of spans) {
            const m = span.id.match(/^span_(\w*?)vTMPFLUXOPROCESSO_DESCRICAO_(\d{4})$/);
            if (!m) continue;   // tarefas dentro do fluxo (ex.: "Confirmar (76)") têm outros ids
            prefixo = m[1];
            const campoCodigo = doc.getElementById(`${m[1]}vTMPFLUXOPROCESSO_ID_${m[2]}`);
            const texto = span.textContent.trim();
            const partes = texto.match(/^(.*?)\s*\((\d+)\)\s*$/);
            const nome = partes ? partes[1] : texto;
            const codigo = (campoCodigo && campoCodigo.value.trim()) || nome;
            fluxos.push({ codigo, chave: codigo.toLowerCase(), nome, quantidade: partes ? Number(partes[2]) : 1, linha: m[2] });
        }
        return { prefixo, fluxos, filtro: filtroDaTela(doc), win: iframe.contentWindow };
    }

    // Estado dos filtros da Caixa de Entrada. Quando o usuário muda um deles (ex.: marca "Visualizar Todos os
    // Fluxos", que esvazia a lista, ou muda o período), a lista muda sem que tenha chegado fluxo novo.
    function filtroDaTela(doc) {
        const valor = (seletor, atributo) => {
            const el = doc.querySelector(seletor);
            if (!el) return '';
            return atributo ? (el.getAttribute(atributo) || '').split('/').pop() : el.value;
        };
        return [
            valor('[id$="IMGMOSTRAFLUXO"]', 'src'),
            valor('[id$="vDATA_INICIAL"]'),
            valor('[id$="vDATA_FINAL"]'),
            valor('[id$="vWORKFLOWSUBJECTF"]')
        ].join('|');
    }

    function fluxoHabilitado(fluxo) {
        const f = config.fluxos;
        const personalizado = f.personalizados.some(p => {
            const alvo = p.trim().toLowerCase();
            return alvo && (alvo === fluxo.chave || alvo === fluxo.nome.toLowerCase());
        });
        if (personalizado) return true;
        if (fluxosConhecidos.has(fluxo.chave) || fluxosVistos[fluxo.chave]) {
            return !f.desativados.includes(fluxo.chave);
        }
        return f.notificarDesconhecidos;
    }

    function registrarFluxosVistos(fluxos) {
        let mudou = false;
        fluxos.forEach(f => {
            if (!fluxosConhecidos.has(f.chave) && !fluxosVistos[f.chave]) {
                // Novo fluxo: entra na lista; se "avisar desconhecidos" está desligado, já vem desmarcado
                fluxosVistos[f.chave] = { codigo: f.codigo, nome: f.nome };
                if (!config.fluxos.notificarDesconhecidos && !config.fluxos.desativados.includes(f.chave)) {
                    const novo = copiar(config);
                    novo.fluxos.desativados.push(f.chave);
                    config = novo;
                    try {
                        localStorage.setItem(CHAVE_CONFIG, JSON.stringify(novo));
                    } catch (e) { /* ignora */ }
                }
                mudou = true;
            }
        });
        if (mudou) {
            try {
                localStorage.setItem(CHAVE_FLUXOS_VISTOS, JSON.stringify(fluxosVistos));
            } catch (e) { /* ignora */ }
        }
    }

    function verificarFluxos() {
        if (!config.fluxos.ativo) return;
        const lido = lerFluxosDaTela();
        if (!lido) return;

        // Mudou um filtro: a próxima mudança da lista (que pode vir na hora ou só na próxima atualização)
        // é consequência do filtro, não de fluxos novos. Se a lista não mudar em 2 minutos, volta ao normal.
        if (estadoFluxos.filtro !== null && lido.filtro !== estadoFluxos.filtro) {
            estadoFluxos.absorverAte = Date.now() + 120000;
        }
        estadoFluxos.filtro = lido.filtro;

        // A grade aparece vazia por um instante enquanto o GeneXus a redesenha. Uma lista vazia só vale
        // se duas leituras seguidas concordarem; senão a próxima leitura acharia que tudo é novo.
        const tinhaFluxos = estadoFluxos.contagens === null || estadoFluxos.contagens.size > 0;
        if (!lido.fluxos.length && tinhaFluxos && !estadoFluxos.vazioPendente) {
            estadoFluxos.vazioPendente = true;
            return;
        }
        estadoFluxos.vazioPendente = false;

        registrarFluxosVistos(lido.fluxos);

        const assinatura = lido.fluxos.map(f => `${f.chave}:${f.quantidade}`).join('|');
        const listaMudou = assinatura !== estadoFluxos.assinatura;
        estadoFluxos.assinatura = assinatura;
        let silencioso = estadoFluxos.silenciarProxima;
        if (estadoFluxos.absorverAte) {
            if (listaMudou) {
                silencioso = true;
                estadoFluxos.absorverAte = 0;
            } else if (Date.now() > estadoFluxos.absorverAte) {
                estadoFluxos.absorverAte = 0;
            }
        }

        const habilitados = lido.fluxos.filter(fluxoHabilitado);
        const atuais = new Map(habilitados.map(f => [f.chave, f.quantidade]));

        if (estadoFluxos.contagens === null) {
            if (config.fluxos.notificarAoAbrir && habilitados.length && !silencioso) {
                notificar('Fluxos pendentes', habilitados.map(f => ({ texto: `${f.nome} (${f.quantidade})`, chave: f.chave })));
            }
        } else if (!silencioso) {
            const novos = habilitados.filter(f => f.quantidade > (estadoFluxos.contagens.get(f.chave) || 0));
            if (novos.length) {
                estadoFluxos.novidade = true;
                notificar('Novos fluxos', novos.map(f => {
                    const anterior = estadoFluxos.contagens.get(f.chave) || 0;
                    return { texto: `${f.nome} (${f.quantidade})  +${f.quantidade - anterior}`, chave: f.chave };
                }));
                if (config.fluxos.som) tocarSom();
            }
        }
        estadoFluxos.silenciarProxima = false;
        estadoFluxos.contagens = atuais;
        estadoFluxos.atuais = habilitados;
        atualizarBotaoFluxos();
    }

    // Lê a tela inicial logo depois que ela recarrega
    function verificarFluxosEmBreve() {
        clearTimeout(estadoFluxos.timerEmBreve);
        estadoFluxos.timerEmBreve = setTimeout(verificarFluxos, 800);
    }

    // Pede para a Caixa de Entrada atualizar a lista (mesmo evento do botão de atualizar dela)
    function atualizarTelaInicial() {
        if (!config.fluxos.ativo) return;
        const lido = lerFluxosDaTela();
        if (!lido || !lido.win || !lido.win.gx) return;
        try {
            // Não atualiza enquanto o usuário está digitando num campo da Caixa de Entrada
            const ativo = lido.win.document.activeElement;
            if (ativo && /^(INPUT|SELECT|TEXTAREA)$/.test(ativo.tagName) && ativo.type !== 'image') return;
            const grade = lido.win.document.querySelector('[id$="GridfluxoContainerTbl"]');
            const prefixo = lido.prefixo !== null ? lido.prefixo : (grade ? grade.id.replace(/GridfluxoContainerTbl$/, '') : '');
            lido.win.gx.evt.execEvt(`${prefixo}E'DOATUALIZAR'.`, null);
            setTimeout(verificarFluxos, 2500);
        } catch (e) {
            console.warn(`[${NOME_SCRIPT}] Não foi possível atualizar a Caixa de Entrada`, e);
        }
    }

    function reiniciarMonitorFluxos() {
        clearInterval(estadoFluxos.timerLeitura);
        clearInterval(estadoFluxos.timerAtualizacao);
        if (!config.fluxos.ativo) {
            estadoFluxos.contagens = null;
            estadoFluxos.atuais = [];
            atualizarBotaoFluxos();
            return;
        }
        estadoFluxos.timerLeitura = setInterval(verificarFluxos, INTERVALO_LEITURA_FLUXOS);
        const intervalo = Math.max(15, Number(config.fluxos.intervaloAtualizacao) || 60) * 1000;
        estadoFluxos.timerAtualizacao = setInterval(atualizarTelaInicial, intervalo);
    }

    // Mostra a Caixa de Entrada com o fluxo marcado (as tarefas dele aparecem logo abaixo)
    function abrirFluxo(chave, tentativas = 0) {
        if (tentativas === 0) mostrarCaixaDeEntrada();
        const iframe = iframeTelaInicial();
        let doc;
        try {
            doc = iframe && iframe.contentDocument;
        } catch (e) {
            return;
        }
        if (!doc) return;

        const lido = lerFluxosDaTela();
        const fluxo = lido && lido.fluxos.find(f => f.chave === chave);
        const linha = fluxo && doc.getElementById(`span_${lido.prefixo}vTMPFLUXOPROCESSO_DESCRICAO_${fluxo.linha}`);
        if (linha) linha.scrollIntoView({ block: 'center' });

        // Outras abas (Definições, Tarefas...) são desenhadas por cima da lista de fluxos, que continua na
        // página. Por isso confere o que está de fato visível na posição do fluxo.
        if (linha && !estaCoberto(doc, linha)) {
            const marcar = doc.getElementById(`${lido.prefixo}IMGFLUXO_${fluxo.linha}`);
            if (marcar && !/IcoMarcado\.gif$/i.test(marcar.getAttribute('src') || '')) marcar.click();
            return;
        }
        if (tentativas >= 30) return;   // desiste depois de ~15 s (servidor lento)
        // Volta para a aba Caixa de Entrada (tenta de novo a cada 2 s, caso o primeiro clique não pegue)
        if (tentativas % 4 === 0) {
            const aba = doc.querySelector('a[href*="DOINBOX"]');
            if (aba) aba.click();
        }
        setTimeout(() => abrirFluxo(chave, tentativas + 1), 500);
    }

    // true se outro elemento está desenhado por cima de "el" (ex.: a tela de Definições sobre a lista de fluxos)
    function estaCoberto(doc, el) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return true;
        const topo = doc.elementFromPoint(r.left + Math.min(5, r.width / 2), r.top + r.height / 2);
        return !topo || !(topo === el || el.contains(topo) || topo.contains(el));
    }

    function atualizarBotaoFluxos() {
        if (!botaoFluxos) return;
        const quantidade = estadoFluxos.atuais.length;
        botaoFluxos.setText(`<i class="fa fa-bell"></i>${quantidade ? `<span class="dbtNumero">${quantidade}</span>` : ''}`);
        botaoFluxos.setTooltip(quantidade ?
            estadoFluxos.atuais.map(f => Ext.util.Format.htmlEncode(`${f.nome} (${f.quantidade})`)).join('<br>') :
            'Nenhum fluxo pendente');
        const el = botaoFluxos.getEl();
        // (o toggleClass do ExtJS 3 não aceita o segundo parâmetro, então adiciona/remove explicitamente)
        if (el) {
            if (estadoFluxos.novidade) el.addClass('dbt-novidade');
            else el.removeClass('dbt-novidade');
        }
    }

    function preencherMenuFluxos(menu) {
        estadoFluxos.novidade = false;
        atualizarBotaoFluxos();
        menu.removeAll();
        const itens = estadoFluxos.atuais.length ?
            estadoFluxos.atuais.map(f => ({
                text: Ext.util.Format.htmlEncode(`${f.nome} (${f.quantidade})`),
                handler: () => abrirFluxo(f.chave)
            })) :
            [{ text: 'Nenhum fluxo pendente', disabled: true }];
        menu.add(
            ...itens,
            '-',
            item('Mostrar a Caixa de Entrada', 'caixa', mostrarCaixaDeEntrada),
            item('Atualizar agora', 'reabrir', atualizarTelaInicial),
            item('Configurar notificação de fluxos...', 'sino', abrirConfigFluxos)
        );
    }

    // Aviso no canto da tela (e notificação do sistema, se o navegador estiver em segundo plano)
    function containerNotificacoes() {
        let container = document.getElementById('barraTarefasNotificacoes');
        if (!container) {
            container = document.createElement('div');
            container.id = 'barraTarefasNotificacoes';
            document.body.appendChild(container);
        }
        // Abaixo da barra do alto e também do título de uma janela maximizada, para não cobrir os botões
        // minimizar/maximizar/fechar dela (com o mouse em cima o aviso pausa e não sairia da frente)
        const barraDoAlto = oW5Portal.toolbar && oW5Portal.toolbar.getEl();
        const titulo = document.querySelector('.x-window .x-window-header');
        const alturaTitulo = titulo && titulo.offsetHeight ? titulo.offsetHeight : (temaEhVolks() ? 40 : 26);
        // + 40: deixa livre a faixa onde fica o botão "Aviso" das telas (8 px abaixo do título, ~24 px de altura)
        container.style.top = `${(barraDoAlto ? barraDoAlto.getBottom() : 0) + alturaTitulo + 40}px`;
        return container;
    }

    // Som de aviso de fluxos novos, gerado pelo navegador (sem arquivo de áudio). Cada som é uma lista de
    // notas: [frequência (Hz), início (s), duração (s), forma da onda, volume no pico (em 100%), frequência final].
    // Tudo passa por um limitador (compressor rápido), para os sons altos e o volume acima de 100% não distorcerem.
    // O navegador só deixa tocar som depois que o usuário clicou ou digitou alguma coisa na página
    // (vale também dentro das telas); no uso normal isso sempre já aconteceu quando chega um fluxo.
    const SONS_FLUXO = {
        duplo:     { nome: 'Dois toques (padrão)', notas: [[880, 0, 0.35, 'sine', 0.75], [1318.5, 0.16, 0.35, 'sine', 0.75]] },
        tres:      { nome: 'Três notas subindo', notas: [[1046.5, 0, 0.3, 'sine', 0.6], [1318.5, 0.12, 0.3, 'sine', 0.6], [1568, 0.24, 0.45, 'sine', 0.6]] },
        campainha: { nome: 'Campainha (ding-dong)', notas: [[784, 0, 0.7, 'triangle', 0.75], [622.3, 0.38, 0.9, 'triangle', 0.75]] },
        sino:      { nome: 'Sino', notas: [[660, 0, 1.5, 'sine', 0.66], [1320, 0, 1.0, 'sine', 0.3], [1993, 0, 0.6, 'sine', 0.18]] },
        suave:     { nome: 'Suave', notas: [[523.3, 0, 0.6, 'sine', 0.54], [659.3, 0.2, 0.8, 'sine', 0.45]] },
        gota:      { nome: 'Gota', notas: [[1400, 0, 0.22, 'sine', 0.84, 500]] },
        moeda:     { nome: 'Moeda', notas: [[987.8, 0, 0.09, 'square', 0.21], [1318.5, 0.08, 0.45, 'square', 0.21]] },
        alerta:    { nome: 'Alerta (três bipes)', notas: [[988, 0, 0.12, 'square', 0.21], [988, 0.18, 0.12, 'square', 0.21], [988, 0.36, 0.12, 'square', 0.21]] }
    };

    let contextoSom = null, saidaSom = null;
    function tocarSom(tipo = config.fluxos.somTipo, volumePorcento = config.fluxos.volume) {
        try {
            const Contexto = window.AudioContext || window.webkitAudioContext;
            if (!Contexto) return;
            const som = SONS_FLUXO[tipo] || SONS_FLUXO[PADRAO.fluxos.somTipo];
            const volume = Math.min(200, Math.max(0, Number(volumePorcento) || 0)) / 100;
            if (!volume) return;
            if (!contextoSom) {
                contextoSom = new Contexto();
                saidaSom = contextoSom.createDynamicsCompressor();
                saidaSom.threshold.value = -6;
                saidaSom.knee.value = 6;
                saidaSom.ratio.value = 20;
                saidaSom.attack.value = 0.002;
                saidaSom.release.value = 0.15;
                saidaSom.connect(contextoSom.destination);
            }
            const tocar = () => {
                const agora = contextoSom.currentTime;
                som.notas.forEach(([frequencia, atraso, duracao, onda, pico, frequenciaFinal]) => {
                    const t = agora + atraso;
                    const osc = contextoSom.createOscillator();
                    const ganho = contextoSom.createGain();
                    osc.type = onda;
                    osc.frequency.setValueAtTime(frequencia, t);
                    if (frequenciaFinal) osc.frequency.exponentialRampToValueAtTime(frequenciaFinal, t + duracao);
                    ganho.gain.setValueAtTime(0.0001, t);
                    ganho.gain.exponentialRampToValueAtTime(pico * volume, t + 0.015);
                    ganho.gain.exponentialRampToValueAtTime(0.0001, t + duracao);
                    osc.connect(ganho).connect(saidaSom);
                    osc.start(t);
                    osc.stop(t + duracao + 0.05);
                });
            };
            if (contextoSom.state === 'suspended') contextoSom.resume().then(tocar, () => {});
            else tocar();
        } catch (e) {
            console.warn(`[${NOME_SCRIPT}] Não foi possível tocar o som`, e);
        }
    }

    // itens: [{ texto, chave }]; clicar numa linha abre o fluxo na Caixa de Entrada
    function notificar(titulo, itens) {
        const opcoes = config.fluxos;
        const linhas = itens.map(i => i.texto);

        if (opcoes.notificacaoSistema && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            try {
                const n = new Notification(`${NOME_EXIBICAO}: ${titulo}`, { body: linhas.join('\n'), tag: 'dealer-fluxo' });
                n.onclick = () => { window.focus(); n.close(); };
            } catch (e) { /* ignora */ }
        }

        const aviso = document.createElement('div');
        aviso.className = 'barraTarefasNotificacao';
        aviso.title = 'Clique para fechar';
        const tempo = elemento(document, 'span', { className: 'dbtTempo', title: 'Fecha sozinho em' });
        const corpo = elemento(document, 'div', { className: 'dbtLinhas' });
        aviso.append(
            elemento(document, 'div', { className: 'dbtCabecalho' },
                elemento(document, 'strong', {}, elemento(document, 'i', { className: 'fa fa-bell' }), ` ${titulo}`),
                tempo,
                elemento(document, 'span', { className: 'dbtFechar', title: 'Fechar' }, '\u2715')),
            corpo,
            opcoes.linksAviso === false ? null : elemento(document, 'div', { className: 'dbtAcoes' },
                elemento(document, 'a', { dataset: { acao: 'caixa' } }, 'Mostrar a Caixa de Entrada')));
        const MAX_LINHAS = 10;
        const visiveis = itens.length > MAX_LINHAS ?
            [...itens.slice(0, MAX_LINHAS - 1), { texto: `... e mais ${itens.length - MAX_LINHAS + 1} (veja no sino, no alto da tela)` }] : itens;
        visiveis.forEach(i => {
            const linha = document.createElement('div');
            const texto = document.createElement('span');
            texto.textContent = i.texto;
            if (i.chave && opcoes.linksAviso !== false) {
                texto.className = 'dbtLinhaFluxo';
                texto.dataset.chave = i.chave;
                texto.title = 'Abrir este fluxo na Caixa de Entrada';
            }
            linha.appendChild(texto);
            corpo.appendChild(linha);
        });
        containerNotificacoes().appendChild(aviso);

        // Contagem regressiva ao lado do X (parada enquanto o mouse está em cima, se configurado)
        let restante = Math.max(2, Number(opcoes.tempoNotificacao) || 8) * 1000;
        let inicio = 0;
        let pausado = false;
        const mostrarTempo = () => {
            const ms = pausado ? restante : restante - (Date.now() - inicio);
            const segundos = Math.max(0, Math.ceil(ms / 1000));
            tempo.replaceChildren(...(pausado ? [elemento(document, 'i', { className: 'fa fa-pause' }), ` ${segundos}s`] : [`${segundos}s`]));
            tempo.title = pausado ? 'Pausado com o mouse em cima' : 'Fecha sozinho em';
            if (!pausado && ms <= 0) fechar();
        };
        let relogio = null;
        const fechar = () => {
            clearInterval(relogio);
            aviso.classList.remove('visivel');
            setTimeout(() => aviso.remove(), 450);
        };
        const iniciar = () => {
            pausado = false;
            inicio = Date.now();
            mostrarTempo();
        };

        // Clique do meio em qualquer lugar (até em cima de um fluxo) só fecha
        aviso.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });  // sem a rolagem automática
        aviso.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            fechar();
        });
        // Clicar num fluxo abre o fluxo; clicar em qualquer outro lugar (ou no X) só fecha
        aviso.addEventListener('click', (e) => {
            const fluxo = e.target.closest('[data-chave]');
            if (e.target.dataset.acao === 'caixa') mostrarCaixaDeEntrada();
            else if (fluxo) abrirFluxo(fluxo.dataset.chave);
            fechar();
        });
        if (opcoes.pausarAoPassarMouse) {
            aviso.addEventListener('mouseenter', () => {
                if (pausado) return;
                restante -= Date.now() - inicio;
                pausado = true;
                mostrarTempo();
            });
            aviso.addEventListener('mouseleave', () => {
                if (restante > 0) iniciar(); else fechar();
            });
        }

        requestAnimationFrame(() => requestAnimationFrame(() => aviso.classList.add('visivel')));
        iniciar();
        relogio = setInterval(mostrarTempo, 250);
    }

    // ---------------------------------------------------------------------------------------------
    // Janela de configuração da notificação de fluxos
    // ---------------------------------------------------------------------------------------------

    function htmlConfigFluxos() {
        const f = config.fluxos;
        return `
                <div class="dbtAbaPainel" data-painel="fluxos">
                <fieldset>
                    <legend>Notificação</legend>
                    <table>
                        <tr><td>Avisar quando chegarem novos fluxos</td>
                            <td><input type="checkbox" name="ativo" ${f.ativo ? 'checked' : ''}></td></tr>
                        <tr><td>Atualizar a Caixa de Entrada a cada (segundos, mínimo 15)</td>
                            <td><input type="number" name="intervaloAtualizacao" min="15" max="3600" value="${f.intervaloAtualizacao}"></td></tr>
                        <tr><td>Tempo que o aviso fica na tela (segundos)</td>
                            <td><input type="number" name="tempoNotificacao" min="2" max="120" value="${f.tempoNotificacao}"></td></tr>
                        <tr><td>Pausar o tempo do aviso com o mouse em cima</td>
                            <td><input type="checkbox" name="pausarAoPassarMouse" ${f.pausarAoPassarMouse ? 'checked' : ''}></td></tr>
                        <tr><td>Clicar num fluxo do aviso abre o fluxo (desmarcado: clicar em qualquer lugar do aviso só fecha)</td>
                            <td><input type="checkbox" name="linksAviso" ${f.linksAviso !== false ? 'checked' : ''}></td></tr>
                        <tr><td>Avisar os fluxos pendentes ao entrar no DealerNet</td>
                            <td><input type="checkbox" name="notificarAoAbrir" ${f.notificarAoAbrir ? 'checked' : ''}></td></tr>
                        <tr><td>Notificação do sistema quando o navegador estiver em segundo plano</td>
                            <td><input type="checkbox" name="notificacaoSistema" ${f.notificacaoSistema ? 'checked' : ''}></td></tr>
                        <tr><td>Avisar também fluxos novos que não estão na lista "Fluxos" abaixo</td>
                            <td><input type="checkbox" name="notificarDesconhecidos" ${f.notificarDesconhecidos ? 'checked' : ''}></td></tr>
                    </table>
                </fieldset>
                <fieldset class="dbtDependeFluxos">
                    <legend>Som</legend>
                    <table>
                        <tr><td>Tocar um som quando chegarem novos fluxos</td>
                            <td><input type="checkbox" name="som" ${f.som ? 'checked' : ''}></td></tr>
                        <tr><td>Som</td>
                            <td><select name="somTipo">${Object.keys(SONS_FLUXO).map(k => `<option value="${k}" ${f.somTipo === k ? 'selected' : ''}>${SONS_FLUXO[k].nome}</option>`).join('')}</select>
                                <button type="button" class="dbtBotao dbtTestarSom" title="Ouvir o som com este volume">&#9654; Testar</button></td></tr>
                        <tr><td>Volume</td>
                            <td><input type="range" name="volume" min="0" max="200" step="5" value="${f.volume}">
                                <span class="dbtVolumeValor"></span></td></tr>
                    </table>
                    <div class="dbtAvisoVolume">&#9888; Volume acima de 100% pode causar danos à audição e aos equipamentos
                        (fones de ouvido e caixas de som). Teste com cuidado.</div>
                </fieldset>
                <fieldset class="dbtDependeFluxos">
                    <legend>Fluxos</legend>
                    <div class="dbtDica" style="margin:0 0 6px">Marque os fluxos que devem gerar aviso.</div>
                    <input type="text" class="dbtFiltro dbtFiltroLista" placeholder="Filtrar por nome ou código...">
                    <button type="button" class="dbtBotao" data-marcar="1">Marcar todos</button>
                    <button type="button" class="dbtBotao" data-marcar="0">Desmarcar todos</button>
                    <div class="dbtListaFluxos"></div>
                    <div class="dbtDica"><span class="dbtContagem"></span></div>
                </fieldset>
                <fieldset class="dbtDependeFluxos">
                    <legend>Fluxos personalizados</legend>
                    <input type="text" class="dbtNovoPersonalizado dbtFiltro" placeholder="Código (FLX_...) ou nome do fluxo">
                    <button type="button" class="dbtBotao" data-adicionar="1">Adicionar</button>
                    <div class="dbtPersonalizados"></div>
                    <div class="dbtDica">Sempre avisados, mesmo que não estejam na lista acima.</div>
                </fieldset>
                </div>`;
    }

    function configurarFormFluxos(raiz) {
        const desativados = new Set(config.fluxos.desativados);
        const personalizados = [...config.fluxos.personalizados];
        const pendentes = new Map(estadoFluxos.atuais.map(f => [f.chave, f.quantidade]));
        const lidos = lerFluxosDaTela();
        if (lidos) lidos.fluxos.forEach(f => pendentes.set(f.chave, f.quantidade));

        // Na Caixa de Entrada agora primeiro, depois em ordem alfabética
        const lista = [...todosOsFluxos().entries()]
            .map(([chave, dados]) => ({ chave, ...dados }))
            .sort((a, b) => (pendentes.has(b.chave) - pendentes.has(a.chave)) || a.nome.localeCompare(b.nome, 'pt-BR'));

        const container = raiz.querySelector('.dbtListaFluxos');
        const filtro = raiz.querySelector('input.dbtFiltroLista');
        const contagem = raiz.querySelector('.dbtContagem');
        container.replaceChildren(...lista.map(f => elemento(document, 'label',
            { dataset: { chave: f.chave, busca: `${f.nome} ${f.codigo}`.toLowerCase() } },
            elemento(document, 'input', { type: 'checkbox', checked: !desativados.has(f.chave) }),
            ` ${f.nome} `,
            pendentes.has(f.chave) ? elemento(document, 'span', { className: 'dbtPendente' }, `(${pendentes.get(f.chave)} na Caixa de Entrada)`) : null,
            pendentes.has(f.chave) ? ' ' : null,
            elemento(document, 'span', { className: 'dbtCodigo' }, f.codigo))));

        const atualizarContagem = () => {
            const total = container.querySelectorAll('input').length;
            const marcados = container.querySelectorAll('input:checked').length;
            contagem.textContent = `${marcados} de ${total} fluxos marcados.`;
        };

        filtro.addEventListener('input', () => {
            const termo = filtro.value.trim().toLowerCase();
            container.querySelectorAll('label').forEach(l => {
                l.style.display = !termo || l.dataset.busca.includes(termo) ? '' : 'none';
            });
        });

        raiz.querySelectorAll('[data-marcar]').forEach(b => b.addEventListener('click', () => {
            const marcar = b.dataset.marcar === '1';
            container.querySelectorAll('label').forEach(l => {
                if (l.style.display !== 'none') l.querySelector('input').checked = marcar;
            });
            atualizarContagem();
        }));
        container.addEventListener('change', atualizarContagem);
        atualizarContagem();

        // Com a notificação desligada, o resto da aba fica apagado (dá para mexer do mesmo jeito)
        const caixaAtivo = raiz.querySelector('[data-painel="fluxos"] [name="ativo"]');
        const apagar = () => raiz.querySelectorAll('.dbtDependeFluxos').forEach(f => f.classList.toggle('dbtApagado', !caixaAtivo.checked));
        caixaAtivo.addEventListener('change', apagar);
        apagar();

        // Notificação do sistema precisa da permissão do navegador
        const caixaSistema = raiz.querySelector('[name="notificacaoSistema"]');
        caixaSistema.addEventListener('change', () => {
            if (caixaSistema.checked && 'Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        });

        // Som: o teste usa o som e o volume escolhidos (ainda não salvos)
        const tipoSom = raiz.querySelector('[name="somTipo"]');
        const volume = raiz.querySelector('[name="volume"]');
        const valorVolume = raiz.querySelector('.dbtVolumeValor');
        const avisoVolume = raiz.querySelector('.dbtAvisoVolume');
        const testarSom = () => tocarSom(tipoSom.value, Number(volume.value));
        const mostrarVolume = () => {
            const alto = Number(volume.value) > 100;
            valorVolume.textContent = `${volume.value}%`;
            valorVolume.classList.toggle('dbtAlto', alto);
            avisoVolume.style.display = alto ? '' : 'none';
        };
        raiz.querySelector('.dbtTestarSom').addEventListener('click', testarSom);
        tipoSom.addEventListener('change', testarSom);
        volume.addEventListener('input', mostrarVolume);
        volume.addEventListener('change', testarSom);
        mostrarVolume();

        // Personalizados
        const listaPersonalizados = raiz.querySelector('.dbtPersonalizados');
        const campoNovo = raiz.querySelector('.dbtNovoPersonalizado');
        const desenharPersonalizados = () => {
            listaPersonalizados.replaceChildren(...(personalizados.length ?
                personalizados.map((p, i) => elemento(document, 'div', {}, `${p} `,
                    elemento(document, 'span', { className: 'dbtLimpar', title: 'Remover', dataset: { remover: String(i) } }, '\u2716'))) :
                [elemento(document, 'div', { className: 'dbtDica' }, 'Nenhum.')]));
        };
        const adicionar = () => {
            const texto = campoNovo.value.replace(/\(\d+\)\s*$/, '').trim();
            if (texto && !personalizados.some(p => p.toLowerCase() === texto.toLowerCase())) personalizados.push(texto);
            campoNovo.value = '';
            desenharPersonalizados();
        };
        raiz.querySelector('[data-adicionar]').addEventListener('click', adicionar);
        campoNovo.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); adicionar(); }
        });
        listaPersonalizados.addEventListener('click', (e) => {
            if (e.target.dataset.remover !== undefined) {
                personalizados.splice(Number(e.target.dataset.remover), 1);
                desenharPersonalizados();
            }
        });
        desenharPersonalizados();

        return () => {
            const valor = (nome) => raiz.querySelector(`[name="${nome}"]`);
            const numero = (nome, min, max) => {
                const n = parseFloat(valor(nome).value);
                return isNaN(n) ? PADRAO.fluxos[nome] : Math.min(max, Math.max(min, n));
            };
            return {
                ativo: valor('ativo').checked,
                intervaloAtualizacao: Math.round(numero('intervaloAtualizacao', 15, 3600)),
                tempoNotificacao: numero('tempoNotificacao', 2, 120),
                pausarAoPassarMouse: valor('pausarAoPassarMouse').checked,
                linksAviso: valor('linksAviso').checked,
                notificarAoAbrir: valor('notificarAoAbrir').checked,
                notificacaoSistema: valor('notificacaoSistema').checked,
                som: valor('som').checked,
                somTipo: SONS_FLUXO[tipoSom.value] ? tipoSom.value : PADRAO.fluxos.somTipo,
                volume: Math.round(numero('volume', 0, 200)),
                notificarDesconhecidos: valor('notificarDesconhecidos').checked,
                desativados: [...container.querySelectorAll('label')]
                    .filter(l => !l.querySelector('input').checked)
                    .map(l => l.dataset.chave),
                personalizados
            };
        };
    }

    // A notificação de fluxos é configurada nas abas da janela de configurações
    function abrirConfigFluxos() {
        abrirConfiguracoes('fluxos');
    }

    // ---------------------------------------------------------------------------------------------
    // Correção do arrastar/redimensionar do portal
    // ---------------------------------------------------------------------------------------------

    // Cada janela tem um iframe com a tela. Se, ao arrastar ou redimensionar rápido, o mouse sai do
    // contorno fantasma e é solto em cima do iframe de outra janela, o iframe "engole" o mouseup e o
    // ExtJS nunca fica sabendo que o arrasto terminou: a janela some (fica em -10000px) ou o
    // redimensionamento é cancelado. Isso acontece no DealerNet mesmo sem o script.
    // Solução: enquanto o botão estiver pressionado num título/alça de janela, os iframes ignoram o mouse.
    const SELETOR_ARRASTO = '.x-window-header, .x-resizable-handle, .x-layout-split, .x-splitbar-h, .x-splitbar-v';

    function protegerArrastoSobreIframes() {
        const soltar = () => document.body.classList.remove('barraTarefasArrastando');

        document.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !e.target.closest) return;
            if (e.target.closest('.x-tool')) return;  // botões do título (fechar, maximizar...)
            if (e.target.closest(SELETOR_ARRASTO)) {
                document.body.classList.add('barraTarefasArrastando');
            }
        }, true);

        document.addEventListener('mouseup', soltar, true);
        window.addEventListener('blur', soltar);
    }

    // ---------------------------------------------------------------------------------------------
    // Inicialização
    // ---------------------------------------------------------------------------------------------

    function configurarContainer() {
        containerBotoes = document.createElement('div');
        containerBotoes.id = 'barraDeTarefas';
        containerBotoes.style.display = 'none';
        aplicarAparenciaBotoes(containerBotoes, config);

        // Coloca a barra dentro da barra de status do portal, acima dos itens dela
        const statusEl = oW5Portal.statusbar.getEl().dom;

        // Alguns temas (ex.: volks) fazem a tabela de itens da barra de status ocupar toda a altura dela.
        // Como a barra de status fica mais alta com a barra de tarefas, fixamos a altura original da tabela.
        const tabela = statusEl.querySelector('table.x-toolbar-ct');
        if (tabela) tabela.style.height = `${tabela.offsetHeight}px`;

        statusEl.insertBefore(containerBotoes, statusEl.firstChild);

        // Rolagem horizontal com a roda do mouse
        containerBotoes.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                containerBotoes.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });

        // Impede o autoscroll do botão do meio
        containerBotoes.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        // Clique direito na parte vazia da barra
        containerBotoes.addEventListener('contextmenu', (e) => {
            if (e.target !== containerBotoes) return;
            e.preventDefault();
            exibirMenuBarra(e);
        });

        new Sortable(containerBotoes, {
            animation: 150,
            direction: 'horizontal',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            filter: '.dbtIniciar',
            preventOnFilter: false,
            onMove: (ev) => !(ev.related && ev.related.classList.contains('dbtIniciar'))
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Busca no menu: botão "Buscar" na barra do alto (logo depois dos módulos) e atalho (Alt+M). Lista as telas do
    // menu do portal pelo nome, com o caminho embaixo e o módulo em negrito; Enter ou clique abre a tela pelo próprio
    // item do menu (o mesmo que clicar nele). Ignora maiúsculas, acentos e pontos ("os" acha "O.S.", "OS" e as
    // iniciais de "Ordem de Serviço"), tolera erros de digitação e também acha pelas pastas do caminho ("O.S." lista
    // tudo o que está dentro de Relatórios > O.S.). Com o campo vazio, mostra as últimas telas abertas pela busca.
    // ---------------------------------------------------------------------------------------------
    const CHAVE_MENU_RECENTES = 'DealerBarraDeTarefas.menuRecentes';
    const MAX_RESULTADOS_MENU = 60;
    const PALAVRAS_VAZIAS_MENU = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'na', 'no', 'para', 'por', 'com']);
    let buscaMenu = null;          // painel aberto: { fechar() }

    // Palavras de um texto, com a posição no original (para o realce). "O.S." vira "o" e "s".
    function palavrasMenu(texto) {
        const norm = normalizarBusca(texto);
        const palavras = [];
        const re = /[a-z0-9]+/g;
        let m;
        while ((m = re.exec(norm))) palavras.push({ p: m[0], ini: m.index, fim: m.index + m[0].length });
        return palavras;
    }

    // Lê o menu do portal (os botões dos módulos na barra do alto) e devolve as folhas com o caminho
    function indiceMenu() {
        const itens = [];
        const barra = oW5Portal.toolbar;
        if (!barra || !barra.items) return itens;
        const andar = (menu, caminho, modulo) => {
            if (!menu || !menu.items) return;
            menu.items.each(it => {
                if (!it.text || it.hidden || it.disabled || typeof it.text !== 'string') return;
                const texto = it.text.replace(/<[^>]*>/g, '').trim();
                if (!texto) return;
                if (it.menu) andar(it.menu, caminho.concat(texto), modulo);
                else if (it.handler) {
                    const pastas = caminho.map(t => ({ texto: t, palavras: palavrasMenu(t) }));
                    itens.push({ item: it, texto, palavras: palavrasMenu(texto), pastas, modulo,
                                 chave: caminho.concat(texto).join(' > ') });
                }
            });
        };
        barra.items.each(b => {
            if (b.menu && typeof b.id === 'string' && b.id.startsWith('W5|') && typeof b.text === 'string') {
                const modulo = b.text.replace(/<[^>]*>/g, '').trim();
                andar(b.menu, [modulo], modulo);
            }
        });
        return itens;
    }

    // Termos da busca: sem acentos/maiúsculas, pontos tirados ("O.S." = "os"); "de", "da"... só contam sozinhos
    function termosBuscaMenu(texto) {
        const termos = normalizarBusca(texto).replace(/\./g, '').split(/[^a-z0-9]+/).filter(Boolean);
        const uteis = termos.filter(t => !PALAVRAS_VAZIAS_MENU.has(t));
        return uteis.length ? uteis : termos;
    }

    // Melhor jeito de um termo aparecer nas palavras de um texto. Pontos menores = melhor.
    // Retorna { pontos, trechos: [[ini, fim], ...] } ou null.
    function casarTermoMenu(termo, palavras, normTexto) {
        let melhor = null;
        const anotar = (pontos, trechos) => { if (!melhor || pontos < melhor.pontos) melhor = { pontos, trechos }; };
        for (let i = 0; i < palavras.length; i++) {
            const w = palavras[i];
            const posicao = Math.min(i, 5) * 0.1;                 // no começo do nome vale um pouco mais
            if (w.p === termo) anotar(0 + posicao, [[w.ini, w.fim]]);
            else if (w.p.startsWith(termo)) anotar(0.5 + posicao, [[w.ini, w.ini + termo.length]]);
            // abreviação com pontos: "o" "s" (de "O.S.") ou "t" "m" "o" (de "T.M.O.")
            if (termo.length >= 2 && w.p.length === 1 && w.p === termo[0]) {
                let k = i, resto = termo;
                const trechos = [];
                while (k < palavras.length && palavras[k].p.length === 1 && resto.startsWith(palavras[k].p)) {
                    trechos.push([palavras[k].ini, palavras[k].fim]);
                    resto = resto.slice(1);
                    k++;
                    if (!resto) break;
                }
                if (!resto) anotar(0 + posicao, trechos);
            }
            // iniciais de palavras seguidas ("os" = "Ordem de Serviço", "nf" = "Nota Fiscal")
            if (termo.length >= 2 && termo.length <= 5 && w.p[0] === termo[0] && w.p.length > 1) {
                let k = i, n = 0;
                const trechos = [];
                while (k < palavras.length && n < termo.length) {
                    const pk = palavras[k];
                    if (n > 0 && PALAVRAS_VAZIAS_MENU.has(pk.p)) { k++; continue; }
                    if (pk.p[0] !== termo[n]) break;
                    trechos.push([pk.ini, pk.ini + 1]);
                    n++;
                    k++;
                }
                if (n === termo.length) anotar(2 + posicao, trechos);
            }
        }
        if (melhor) return melhor;
        // no meio de uma palavra (só com 3 letras ou mais, senão "os" acharia "Postos")
        if (termo.length >= 3) {
            const i = normTexto.indexOf(termo);
            if (i >= 0) return { pontos: 3, trechos: [[i, i + termo.length]] };
        }
        // erros de digitação (1 erro a partir de 4 letras, 2 a partir de 8)
        const tolerancia = toleranciaBusca(termo.length);
        if (tolerancia) {
            const ap = buscarAproximado(termo, normTexto, tolerancia);
            if (ap) return { pontos: 4 + 3 * ap.erros, trechos: [[ap.inicio, ap.fim]] };
        }
        return null;
    }

    // Pontua uma tela do menu: cada termo precisa aparecer no nome (melhor) ou numa pasta do caminho
    function pontuarMenu(termos, entrada) {
        if (!entrada.norm) {
            entrada.norm = normalizarBusca(entrada.texto);
            entrada.pastas.forEach(p => { p.norm = normalizarBusca(p.texto); });
        }
        let pontos = 0;
        const realce = { nome: [], pastas: entrada.pastas.map(() => []) };
        for (const termo of termos) {
            const noNome = casarTermoMenu(termo, entrada.palavras, entrada.norm);
            let naPasta = null, qual = -1;
            entrada.pastas.forEach((p, i) => {
                const r = casarTermoMenu(termo, p.palavras, p.norm);
                if (r && (!naPasta || r.pontos < naPasta.pontos)) { naPasta = r; qual = i; }
            });
            if (noNome && (!naPasta || noNome.pontos <= naPasta.pontos + 4)) {
                pontos += noNome.pontos;
                realce.nome.push(...noNome.trechos);
            } else if (naPasta) {
                pontos += naPasta.pontos + 4;
                realce.pastas[qual].push(...naPasta.trechos);
            } else {
                return null;
            }
        }
        // o nome inteiro é exatamente o que foi digitado
        if (termos.join(' ') === entrada.palavras.map(w => w.p).join(' ') ||
            termos.join('') === entrada.palavras.map(w => w.p).join('')) pontos -= 2;
        return { pontos, realce };
    }

    function buscarNoMenu(texto, indice) {
        const termos = termosBuscaMenu(texto);
        if (!termos.length) return [];
        const achados = [];
        for (const entrada of indice) {
            const r = pontuarMenu(termos, entrada);
            if (r) achados.push({ entrada, ...r });
        }
        achados.sort((a, b) => a.pontos - b.pontos || a.entrada.pastas.length - b.entrada.pastas.length ||
                               a.entrada.texto.localeCompare(b.entrada.texto, 'pt-BR'));
        return achados;
    }

    function lerRecentesMenu() {
        try {
            const r = JSON.parse(localStorage.getItem(CHAVE_MENU_RECENTES) || '[]');
            return Array.isArray(r) ? r.filter(x => typeof x === 'string') : [];
        } catch (e) {
            return [];
        }
    }

    function guardarRecenteMenu(chave) {
        const lista = [chave, ...lerRecentesMenu().filter(c => c !== chave)].slice(0, 8);
        try { localStorage.setItem(CHAVE_MENU_RECENTES, JSON.stringify(lista)); } catch (e) { /* sem storage */ }
    }

    // Abre a tela como se o item do menu tivesse sido clicado
    function abrirItemMenu(entrada) {
        const it = entrada.item;
        guardarRecenteMenu(entrada.chave);
        try {
            if (it.fireEvent('click', it, Ext.EventObject) === false) return;
            it.handler.call(it.scope || it, it, Ext.EventObject);
        } catch (e) {
            console.error(`[${NOME_SCRIPT}] Não foi possível abrir "${entrada.chave}"`, e);
        }
    }

    function fecharBuscaMenu() {
        if (buscaMenu) buscaMenu.fechar();
    }

    function alternarBuscaMenu() {
        if (buscaMenu) fecharBuscaMenu();
        else abrirBuscaMenu();
    }

    function abrirBuscaMenu() {
        if (buscaMenu) { buscaMenu.focar(); return; }
        fecharMenus();
        const indice = indiceMenu();
        const painel = document.createElement('div');
        painel.id = 'dbtBuscaMenu';
        const campo = document.createElement('input');
        campo.type = 'text';
        campo.placeholder = 'Buscar tela no menu (ex.: O.S., nota fiscal, pessoas)';
        campo.setAttribute('autocomplete', 'off');
        campo.setAttribute('spellcheck', 'false');
        const lista = document.createElement('ul');
        const rodape = document.createElement('div');
        rodape.className = 'dbtBuscaMenuRodape';
        painel.append(campo, lista, rodape);
        document.body.appendChild(painel);

        // Junto do botão à vista: para cima se ele estiver embaixo (barra de status, barra de tarefas), para baixo se
        // estiver no alto. Sem botão (escondido), no alto e no meio da tela.
        const ancora = gatilhoBuscaMenuVisivel();
        const caixa = ancora ? ancora.getBoundingClientRect() : null;
        const largura = Math.min(520, window.innerWidth - 16);
        painel.style.width = largura + 'px';
        if (!caixa) {
            painel.style.left = Math.round((window.innerWidth - largura) / 2) + 'px';
            painel.style.top = Math.round(window.innerHeight * 0.12) + 'px';
        } else {
            painel.style.left = Math.max(8, Math.min(caixa.left, window.innerWidth - largura - 8)) + 'px';
            if (caixa.top > window.innerHeight / 2) {
                painel.style.bottom = Math.round(window.innerHeight - caixa.top + 6) + 'px';
                painel.style.maxHeight = Math.max(200, Math.min(560, caixa.top - 16)) + 'px';
            } else {
                painel.style.top = Math.round(caixa.bottom + 4) + 'px';
            }
        }

        let resultados = [], marcado = 0;
        const doc = document;
        const preencher = (el, texto, trechos) => preencherComRealce(el, texto, trechos || []);

        const desenhar = () => {
            lista.replaceChildren();
            const texto = campo.value.trim();
            let titulo = null;
            if (!texto) {
                const porChave = new Map(indice.map(e => [e.chave, e]));
                resultados = lerRecentesMenu().map(c => porChave.get(c)).filter(Boolean)
                    .map(entrada => ({ entrada, realce: { nome: [], pastas: entrada.pastas.map(() => []) } }));
                titulo = resultados.length ? 'Abertas recentemente pela busca' : null;
            } else {
                resultados = buscarNoMenu(texto, indice);
            }
            marcado = Math.min(marcado, Math.max(0, resultados.length - 1));
            if (titulo) {
                const li = doc.createElement('li');
                li.className = 'dbtBuscaMenuTitulo';
                li.textContent = titulo;
                lista.appendChild(li);
            }
            resultados.slice(0, MAX_RESULTADOS_MENU).forEach((r, i) => {
                const li = doc.createElement('li');
                li.className = 'dbtBuscaMenuItem' + (i === marcado ? ' dbtMarcado' : '');
                li.dataset.indice = i;
                const nome = doc.createElement('div');
                nome.className = 'dbtBuscaMenuNome';
                preencher(nome, r.entrada.texto, r.realce.nome);
                const caminho = doc.createElement('div');
                caminho.className = 'dbtBuscaMenuCaminho';
                r.entrada.pastas.forEach((p, k) => {
                    if (k) caminho.appendChild(doc.createTextNode(' › '));
                    const parte = doc.createElement(k === 0 ? 'b' : 'span');
                    preencher(parte, p.texto, r.realce.pastas[k]);
                    caminho.appendChild(parte);
                });
                li.append(nome, caminho);
                li.title = r.entrada.chave;
                lista.appendChild(li);
            });
            if (texto && !resultados.length) {
                const li = doc.createElement('li');
                li.className = 'dbtBuscaMenuVazio';
                li.textContent = 'Nenhuma tela do menu com esse nome.';
                lista.appendChild(li);
            } else if (!texto && !resultados.length) {
                const li = doc.createElement('li');
                li.className = 'dbtBuscaMenuVazio';
                li.textContent = `Digite parte do nome da tela. ${indice.length} telas no seu menu.`;
                lista.appendChild(li);
            }
            const mais = resultados.length > MAX_RESULTADOS_MENU ? ` (mostrando ${MAX_RESULTADOS_MENU})` : '';
            rodape.textContent = (texto ? `${resultados.length} ${resultados.length === 1 ? 'tela' : 'telas'}${mais} · ` : '') +
                                 '↑↓ escolher · Enter abrir · Esc fechar';
        };

        const marcar = (i) => {
            const total = Math.min(resultados.length, MAX_RESULTADOS_MENU);
            if (!total) return;
            marcado = (i + total) % total;
            lista.querySelectorAll('.dbtBuscaMenuItem').forEach(li => li.classList.toggle('dbtMarcado', Number(li.dataset.indice) === marcado));
            const atual = lista.querySelector('.dbtBuscaMenuItem.dbtMarcado');
            if (atual) atual.scrollIntoView({ block: 'nearest' });
        };

        const abrir = (i) => {
            const r = resultados[i];
            if (!r) return;
            fechar();
            abrirItemMenu(r.entrada);
        };

        const foraDoPainel = (e) => {
            if (!painel.contains(e.target) && !(e.target.closest && e.target.closest('.dbtGatilhoBuscaMenu'))) fechar();
        };

        function fechar() {
            if (!buscaMenu) return;
            buscaMenu = null;
            document.removeEventListener('mousedown', foraDoPainel, true);
            window.removeEventListener('resize', fechar);
            painel.remove();
        }

        campo.addEventListener('input', () => { marcado = 0; desenhar(); lista.scrollTop = 0; });
        campo.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); marcar(marcado + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); marcar(marcado - 1); }
            else if (e.key === 'PageDown') { e.preventDefault(); marcar(Math.min(marcado + 8, Math.min(resultados.length, MAX_RESULTADOS_MENU) - 1)); }
            else if (e.key === 'PageUp') { e.preventDefault(); marcar(Math.max(marcado - 8, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); abrir(marcado); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(); }
        });
        lista.addEventListener('mousemove', (e) => {
            const li = e.target.closest && e.target.closest('.dbtBuscaMenuItem');
            if (li && Number(li.dataset.indice) !== marcado) marcar(Number(li.dataset.indice));
        });
        lista.addEventListener('mousedown', (e) => e.preventDefault());   // o foco fica no campo
        lista.addEventListener('click', (e) => {
            const li = e.target.closest && e.target.closest('.dbtBuscaMenuItem');
            if (li) abrir(Number(li.dataset.indice));
        });
        document.addEventListener('mousedown', foraDoPainel, true);
        window.addEventListener('resize', fechar);

        buscaMenu = { fechar, focar: () => { campo.focus(); campo.select(); } };
        desenhar();
        // o foco precisa sair da tela (iframe) para o campo
        setTimeout(() => campo.focus(), 0);
    }

    // Os três lugares do botão da busca: barra de status (antes de Workspaces), alto à esquerda (no lugar do
    // logotipo) e começo da barra de tarefas (botão "Iniciar", sempre o primeiro, não arrasta). Só um aparece por vez,
    // conforme config.buscaMenuPosicao e se a barra de tarefas está à vista (posicionarBotaoBuscaMenu).
    let botaoIniciar = null, logoPortal = null;

    function dicaBuscaMenu() {
        const atalho = config.atalhos.buscaMenu ? ` (${nomeAtalho(config.atalhos.buscaMenu)})` : '';
        return `Buscar uma tela no menu${atalho}`;
    }

    function adicionarBotoesBuscaMenu() {
        const status = oW5Portal.statusbar;
        status.insertButton(0, {
            id: 'barraTarefasBuscaMenuStatus',
            cls: 'barraTarefasBotaoStatus dbtBuscaMenuStatus dbtGatilhoBuscaMenu',
            text: '<i class="fa fa-search"></i>',
            tooltip: dicaBuscaMenu(),
            hidden: true,
            handler: () => alternarBuscaMenu()
        });
        status.doLayout();

        const alto = oW5Portal.toolbar;
        if (alto && alto.items && alto.items.getCount()) {
            const primeiro = alto.items.get(0);
            // o logotipo é o primeiro item (um componente sem texto, antes dos menus)
            if (primeiro && !primeiro.text && !primeiro.menu) logoPortal = primeiro;
            alto.insertButton(0, {
                id: 'barraTarefasBuscaMenuAlto',
                cls: 'barraTarefasBotaoStatus dbtBuscaMenuAlto dbtGatilhoBuscaMenu',
                text: '<i class="fa fa-search"></i>',
                tooltip: dicaBuscaMenu(),
                hidden: true,
                handler: () => alternarBuscaMenu()
            });
            alto.doLayout();
        }

        botaoIniciar = document.createElement('button');
        botaoIniciar.type = 'button';
        botaoIniciar.className = 'dbtIniciar dbtGatilhoBuscaMenu';
        botaoIniciar.hidden = true;
        const icone = document.createElement('i');
        icone.className = 'fa fa-search';
        botaoIniciar.appendChild(icone);
        botaoIniciar.addEventListener('click', () => alternarBuscaMenu());
        botaoIniciar.addEventListener('contextmenu', (e) => { e.preventDefault(); exibirMenuBarra(e); });
        containerBotoes.insertBefore(botaoIniciar, containerBotoes.firstChild);
        posicionarBotaoBuscaMenu();
    }

    function posicionarBotaoBuscaMenu() {
        if (!botaoIniciar) return;                    // ainda não criados
        const pos = POSICOES_BUSCA_MENU[config.buscaMenuPosicao] ? config.buscaMenuPosicao : 'barra';
        const naBarra = pos === 'barra' && barraVisivel;
        botaoIniciar.hidden = !naBarra;
        botaoIniciar.title = dicaBuscaMenu();
        containerBotoes.classList.toggle('dbtComIniciar', naBarra);
        const ajustar = (id, visivel, barra) => {
            const b = Ext.getCmp(id);
            if (!b) return;
            if (b.setTooltip) b.setTooltip(dicaBuscaMenu());
            if (b.isVisible() !== visivel) { b.setVisible(visivel); barra.doLayout(); }
        };
        ajustar('barraTarefasBuscaMenuStatus', pos === 'status' || (pos === 'barra' && !barraVisivel), oW5Portal.statusbar);
        if (logoPortal && logoPortal.isVisible() === (pos === 'alto')) logoPortal.setVisible(pos !== 'alto');
        ajustar('barraTarefasBuscaMenuAlto', pos === 'alto', oW5Portal.toolbar);
    }

    // O botão da busca que está à vista (para o painel abrir junto dele)
    function gatilhoBuscaMenuVisivel() {
        const candidatos = [botaoIniciar && !botaoIniciar.hidden ? botaoIniciar : null];
        ['barraTarefasBuscaMenuStatus', 'barraTarefasBuscaMenuAlto'].forEach(id => {
            const b = Ext.getCmp(id);
            if (b && b.isVisible() && b.getEl()) candidatos.push(b.getEl().dom);
        });
        return candidatos.find(el => el && el.getBoundingClientRect().width > 0) || null;
    }

    function inicializar() {
        aplicarEstilos();

        alturaOriginalStatusbar = oW5Portal.statusbar.getHeight();
        configurarContainer();
        adicionarBotoesStatusbar();
        adicionarBotoesBuscaMenu();
        protegerArrastoSobreIframes();
        configurarInstrumentacao();

        // Toda Ext.Window se registra no WindowMgr quando é criada; interceptamos isso para
        // pegar janelas novas (menu, workspaces, duplicadas...) sem precisar de MutationObserver.
        const registrarOriginal = Ext.WindowMgr.register;
        Ext.WindowMgr.register = function(janela) {
            const resultado = registrarOriginal.apply(this, arguments);
            // Um erro aqui nunca pode chegar ao portal (interromperia a abertura das janelas)
            try {
                registrarJanela(janela);
            } catch (e) {
                console.error(`[${NOME_SCRIPT}] Erro ao registrar janela`, e);
            }
            return resultado;
        };

        // Janelas que já estavam abertas antes do script carregar
        Ext.WindowMgr.each((janela) => {
            try {
                registrarJanela(janela);
            } catch (e) {
                console.error(`[${NOME_SCRIPT}] Erro ao registrar janela`, e);
            }
        });

        reiniciarMonitorFluxos();
        verificarFluxosEmBreve();

        // Aviso e tutorial na primeira vez (até o usuário marcar "Não mostrar novamente")
        setTimeout(() => {
            mostrarBoasVindas();
            quandoSemJanelas(mostrarAvisoTelemetria);   // uma vez só, depois das boas-vindas (se aparecerem)
        }, 1500);
        iniciarTelemetria();
    }

    // Espera o portal terminar de montar o layout (viewport e barra de status renderizados)
    function aguardarPortal(tentativas = 0) {
        const pronto = typeof Ext !== 'undefined' && Ext.WindowMgr &&
              typeof oW5Portal !== 'undefined' && oW5Portal.viewport &&
              oW5Portal.statusbar && oW5Portal.statusbar.rendered;
        if (pronto) {
            inicializar();
        } else if (tentativas < 120) {
            setTimeout(() => aguardarPortal(tentativas + 1), 250);
        } else {
            // Não é o portal DealerNet (ou ele não terminou de carregar): não faz nada nesta página
            console.info(`[${NOME_SCRIPT}] Portal DealerNet não encontrado nesta página; nada foi alterado.`);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Lista de fluxos do DealerNet (tela "Definições" da Caixa de Entrada, novembro de 2026)
    // [nome, código do processo]
    // ---------------------------------------------------------------------------------------------

    function listaFluxosPadrao() {
        return [
            ["ACOMPANHAMENTO PROCESSO", "FLX_AcompanhamentoProcesso"],
            ["AGENDAMENTO DA OFICINA", "FLX_Agendamento"],
            ["AGENDAMENTO DA OFICINA", "FLX_AgendamentoAgenda"],
            ["AUTORIZAR ALTERAÇÕES NO AGENDAMENTO DA OFICINA", "FLX_AgendamentoAutorizar"],
            ["CANCELAR AGENDAMENTO DA OFICINA", "FLX_AgendamentoCancelar"],
            ["AGENDAMENTO DA OFICINA", "FLX_AgendamentoUsuario"],
            ["AGENDAMENTO DA OFICINA", "FLX_AgendamentoUsuarioResponsavel"],
            ["AGENDAMENTO DA OFICINA", "FLX_AgendamentoV2"],
            ["ALTERAÇÃO DE AGENDAMENTO VIA WS", "FLX_AgendamentoViaWS"],
            ["ANIVERSÁRIO", "FLX_Aniversario"],
            ["IMPORTAÇÃO ARQUIVO TABMEC", "FLX_ArquivoTabMec"],
            ["AVISO ASSINATURA ELETRÔNICA", "FLX_AssinaturaEletronica"],
            ["ATENDIMENTOS EM ATRASO", "FLX_AtendimentoAtraso"],
            ["ATENDIMENTO AVALIAÇÃO USADO", "FLX_AtendimentoAvalUsado"],
            ["BUSCA DE ATENDIMENTO", "FLX_AtendimentoBusca"],
            ["ATENDIMENTO COLABORAÇÃO PÓS-VENDAS", "FLX_AtendimentoColaboracao"],
            ["ATENDIMENTO CONTATO", "FLX_AtendimentoContato"],
            ["ATENDIMENTO CONTATO", "FLX_AtendimentoContatoV2"],
            ["ATENDIMENTO CONTATO WEB", "FLX_AtendimentoContatoWeb"],
            ["ATENDIMENTO FOLLOWUP", "FLX_AtendimentoFollowUp"],
            ["INTERVALOS DO ATENDIMENTO", "FLX_AtendimentoIntervalo"],
            ["ATENDIMENTO RECUPERAÇÃO", "FLX_AtendimentoRecuperacao"],
            ["ATENDIMENTO VALIDAÇÃO", "FLX_AtendimentoValidacao"],
            ["AUTORIZAÇÃO", "FLX_Autorizacao"],
            ["AUTORIZAÇÃO DE SERVIÇO", "FLX_AutorizacaoServico"],
            ["AUTORIZAÇÃO VENDAS PRODUTO COLIGADAS", "FLX_AutorizacaoVdaProdColigadas"],
            ["AUTORIZAR LANÇAMENTOS NÃO PROVENIENTES DE TRANSFERÊNCIA", "FLX_AutorizarLancamentoNaoTransferencia"],
            ["AVALIAÇÃO DE USADO", "FLX_AvaliacaoUsado"],
            ["PRORROGA AVALIAÇÃO DE USADO", "FLX_AvaliacaoUsadoProrroga"],
            ["REPAROS DA AVALIAÇÃO DE USADO", "FLX_AvaliacaoUsadoReparo"],
            ["AVISO", "FLX_Aviso"],
            ["AVISO DE COBRANÇA RECORRENTE NO CARTÃO DE CRÉDITO", "FLX_AvisoCobrancaRecorrente"],
            ["BAIXA AUTOMÁTICA DE TÍTULOS", "FLX_BaixaAutomatica"],
            ["AUTORIZA BANCO PEDIDO", "FLX_BancoPedido"],
            ["CÁLCULO ABC DE POPULARIDADE", "FLX_CalculoABC_Popularidade"],
            ["CÁLCULO ABC DE ESTOQUE E VENDA", "FLX_CalculoABCEstoqueVenda"],
            ["CÁLCULO AJ DE POPULARIDADE", "FLX_CalculoAJ"],
            ["CARTÃO RETORNO", "FLX_CartaoRetorno"],
            ["CIÊNCIA DA SOLICITAÇÃO DE TRANSFERÊNCIA", "FLX_CienciaSolicitacaoTransferencia"],
            ["EXECUÇÃO CLASSIFICAÇÃO ABC", "FLX_ClasABC"],
            ["ENVIO DE COBRANÇA AUTOMÁTICA POR E-MAIL E SMS", "FLX_CobrancaAutomatica"],
            ["CIENCIA CADASTRO CONDIÇÃO PAGAMENTO", "FLX_CondicaoPagamentoCiencia"],
            ["CONFIRMAÇÃO CADASTRO LGPD", "FLX_ConfirmacaoCadastroLGPD"],
            ["CONTABILIZAÇÃO", "FLX_Contabilizacao"],
            ["APROVAÇÃO DO CONTRATO", "FLX_Contrato"],
            ["APROVAÇÃO DO ABONO DO CONTRATO", "FLX_ContratoAbono"],
            ["APROVAÇÃO DE ADITIVO DO CONTRATO", "FLX_ContratoAditivo"],
            ["CONTROLE DATA INÍCIO FATURAMENTO DO CONTRATO", "FLX_ContratoDataInicioFaturamento"],
            ["APROVAÇÃO DIA VENCIMENTO DO CONTRATO", "FLX_ContratoDiaVencimento"],
            ["PARCELA DO CONTRATO", "FLX_ContratoParcela"],
            ["APROVAÇÃO DA ALTERAÇÃO DO VALOR DA PARCELA DO CONTRATO", "FLX_ContratoParcelaValor"],
            ["AUTORIZAÇÃO PESSOA DO CONTRATO", "FLX_ContratoPessoa"],
            ["APROVAÇÃO RESPONSÁVEL FATURAMENTO DO CONTRATO", "FLX_ContratoResponsavelFaturamento"],
            ["PLANILHAS DA CONTABILIDADE", "FLX_ctbPlanlco"],
            ["TIPOS DE CONTAS DA CONTABILIDADE", "FLX_ctbTpcon"],
            ["ALTERAÇÃO DE TÍTULO DIVERGENTE DO DDA", "FLX_DDA"],
            ["GERAR DOCUMENTAÇÃO DE NOTA FISCAL", "FLX_Documentacao"],
            ["NOTIFICAÇÃO DE EXCLUSÃO DE ARQUIVO", "FLX_DocumentosStorageServer"],
            ["AUTORIZAÇÃO DE ENVIO DA GNRE", "FLX_Dootax"],
            ["DOWNLOAD ARQUIVOS", "FLX_DownloadArquivoSped"],
            ["AUTORIZA ENCONTRO DE CONTAS", "FLX_EncontroContas"],
            ["ENCONTRO DE CONTAS AUTOMÁTICO NA DEVOLUÇÃO DE VENDAS", "FLX_EncontroContasAutomaticoCiencia"],
            ["EXPORTAÇÃO DO SPED DA CONTABILIDADE", "FLX_ExportacaoSPEDCont"],
            ["DOWNLOAD EXPORTAÇÃO RESSARCIMENTO ICMS ST", "FLX_ExpRessarcIcmsST"],
            ["FASTRENTAL ANÁLISE", "FLX_FastRentalAnalise"],
            ["FASTRENTAL AVISO ASSINATURA DE CONTRATO", "FLX_FastRentalAssinatura"],
            ["FASTRENTAL AVISO ENCERRAMENTO CONTRATO", "FLX_FastRentalAvisoEncerramentoContrato"],
            ["FASTRENTAL ENCERRAMENTO", "FLX_FastRentalEncerramento"],
            ["FAST RENTAL MANUTENÇÃO", "FLX_FastRentalManutencao"],
            ["FASTRENTAL AVISO DA MEDIÇÃO", "FLX_FastRentalMedicaoAViso"],
            ["FASTRENTAL AUTORIZAÇÃO OS", "FLX_FastRentalOSAutorizar"],
            ["FASTRENTAL AUTORIZAÇÃO PAGAMENTO", "FLX_FastRentalOSPagamento"],
            ["FASTRENTAL RESCISÃO", "FLX_FastRentalRescisao"],
            ["FASTRENTAL SUBSTITUIÇÃO", "FLX_FastRentalSubstituicao"],
            ["FASTRENTAL SUSPENSÃO", "FLX_FastRentalSuspensao"],
            ["GERAÇÃO DE FATURA", "FLX_FaturaGeracao"],
            ["FATURAMENTO EM LOTE", "FLX_FaturamentoLote"],
            ["FECHAMENTO CAIXA", "FLX_FechamentoCaixa"],
            ["AUTORIZAÇÃO FECHAMENTO DE CAIXA DATA FUTURA OU RETROATIVA", "FLX_FechamentoCaixaAutorizacao"],
            ["FICHA RAZÃO AVULSO", "FLX_FichaRazaoAvulso"],
            ["FORD", "FLX_FordFacil"],
            ["GERAR NOTA FISCAL POR CONTA E ORDEM", "FLX_GeraNFPorContaOrdem"],
            ["GERAÇÃO DE GNRE", "FLX_GNRE"],
            ["GRAVAR ARQUIVO", "FLX_GravarArquivo"],
            ["FLUXO IMPORTAÇÃO LISTA DE PREÇO PRODUTOS.", "FLX_IMP_ListaPrecoProduto"],
            ["FLUXO IMPORTAÇÃO LISTA PREÇO CHERY GLD.", "FLX_IMP_ListaPrecoProdutoCheryGLD"],
            ["FLUXO DE IMPORTAÇÃO DE LISTA DE PREÇO VEÍCULOS", "FLX_IMP_ListaPrecoVeiculos"],
            ["IMPORTAÇÃO", "FLX_Importacao"],
            ["FLUXO IMPORTAÇÃO LISTA DE PREÇOS.", "FLX_ImportaListaPrecos"],
            ["IMPORTAÇÃO LISTA DE PREÇOS IVECO EATON", "FLX_ImportaLPIvecoEATON"],
            ["FLUXO IMPORTAÇÃO LISTA DE PREÇOS", "FLX_ImportaLPMasseyF"],
            ["FLUXO IMPORTAÇÃO LISTA DE PREÇOS STELLANTIS", "FLX_ImportaLPStellantis"],
            ["IMPRESSÃO DE CUPOM FISCAL", "FLX_ImprimirCupomFiscal"],
            ["IMPRIMIR DOSSIÊ DA FINALIDADE DE COMPRA", "FLX_ImprimirDossie"],
            ["IMPRIMIR PEDIDO", "FLX_ImprimirPedido"],
            ["INVENTÁRIO", "FLX_Inventario"],
            ["INVENTÁRIO NOTA FISCAL", "FLX_InventarioNotaFiscal"],
            ["ITEM AVULSO", "FlX_ItemAvulso"],
            ["NOTIFICAÇÃO DE IMPORTAÇÃO DE KIT", "FLX_KitImportados"],
            ["AUTORIZAÇÃO DO PARCELAMENTO DO LINK DE PAGAMENTO", "FLX_LinkPagamento"],
            ["LINK TEF PAGAMENTO", "FLX_LinkTefAprovarPagamento"],
            ["LISTA SEPARAÇÃO", "FLX_ListaSeparacao"],
            ["LISTA SEPARAÇÃO DIVERGÊNCIA", "FLX_ListaSeparacaoDivergencia"],
            ["LISTA SEPARAÇÃO RECEBIMENTO", "FLX_ListaSeparacaoRecebe"],
            ["LOTE CONTÁBIL", "FLX_LoteContabil"],
            ["MANUTENÇÃO FAMÍLIA", "FLX_ManutencaoFamilia"],
            ["ENCERRAMENTO AUTOMÁTICO DE MARCAÇÕES DE TEMPO", "FLX_MarcacaoPendente"],
            ["MARKUP DE PRODUTOS", "FLX_Markup"],
            ["COMPLETA DADOS DO MODELO DE VEÍCULO", "FLX_ModeloVeiculo"],
            ["COMPLETA DADOS DO NOVO MODELO DE VEÍCULO", "FLX_ModeloVeiculoNovo"],
            ["PROCESSAMENTO ARQUIVOS GLOBAIS GM DOWNLOAD", "FLX_MonitorArquivosGlobaisGM"],
            ["CIENCIA ERRO MONITOR INTEGRAÇÃO", "FLX_MonitorErroCiencia"],
            ["AJUSTE DE ESTOQUE", "FLX_MovimentoEstoque"],
            ["NEGOCIAÇÃO", "FLX_Negociacao"],
            ["NEGOCIAÇÃO PROPOSTA", "FLX_Negociacao_Proposta"],
            ["NOTA FISCAL ALTERAÇÃO PRODUTO", "FLX_NFAlteracaoProduto"],
            ["CANCELA NOTA FISCAL", "FLX_NFCancela"],
            ["CANCELAMENTO EXTEMPORÂNEO NOTA FISCAL", "FLX_NFCancelarExtemporaneo"],
            ["CANCELA NOTA FISCAL", "FLX_NFCancelaV2"],
            ["CANCELA NOTA FISCAL VN", "FLX_NFCancelaVN"],
            ["AUTORIZAÇÃO DE DEVOLUÇÃO DE NOTA FISCAL", "FLX_NFDevolucao"],
            ["NFE ITEM AVULSO", "FLX_NFEItemAvulso"],
            ["NOTA FISCAL DE ENTRADA", "FLX_NFEntrada"],
            ["NOTA FISCAL DE ENTRADA", "FLX_NFEntradaV2"],
            ["NOTA FISCAL DE ENTRADA", "FLX_NFEntradaV3"],
            ["NF ENTRADA DE VEÍCULO USADO", "FLX_NFEntradaVeiculoUsado"],
            ["RECEBIMENTO NO CAIXA", "FLX_NFRecebeCaixa"],
            ["GERAR NOTA FISCAL DE RETORNO DA REMESSA", "FLX_NFRemessaRetorno"],
            ["NOTA FISCAL COM TITULO VENCIDO", "FLX_NFTituloVencido"],
            ["NOTA FISCAL TITULO VENCIDO", "FLX_NFTituloVencidoV2"],
            ["EMITIR NOTA FISCAL", "FLX_NFVendaBalcao"],
            ["LIMITE MÁXIMO NOTA FISCAL EM TRÂNSITO", "FLX_NotaFiscalLimiteMaxTransito"],
            ["ABASTECIMENTO DE VEÍCULO", "FLX_OficinaAbastecimentoVeiculo"],
            ["ABERTURA DE O.S.", "FLX_OficinaAbrirOS"],
            ["CANCELAR ITENS DO KIT NA OS", "FLX_OficinaCancelaItensKit"],
            ["IMPRIMIR CARTA PROTESTO / VISTORIA DE VEÍCULO", "FLX_OficinaCartaMontadoraProtesto"],
            ["AUTORIZA DESCONTO DA OFICINA", "FLX_OficinaDesconto"],
            ["AUTORIZA DESCONTO DA OFICINA V2", "FLX_OficinaDescontoV2"],
            ["DESVINCULAÇÃO DE NOTA FISCAL DE O.S.", "FLX_OficinaDesvinculaNota"],
            ["DEVOLUÇÃO DE VEÍCULO", "FLX_OficinaDevolucaoVeiculoRomaneio"],
            ["RECEBIMENTO DE GARANTIA DA OFICINA", "FLX_OficinaGarantia"],
            ["OFICINA LIBERA BLOQUEIO", "FLX_OficinaLiberaBloqueio"],
            ["MARCAÇÃO DE TEMPO NA OFICINA (INATIVO)", "FLX_OficinaMarcacao"],
            ["ORÇAMENTO DA OFICINA", "FLX_OficinaOrcamento"],
            ["ORÇAMENTO DE AVARIAS", "FLX_OficinaOrcamentoAvaria"],
            ["AUTORIZAR MARGEM NEGATIVA DE PRODUTO NA OS", "FLX_OficinaProdutoMargem"],
            ["RECEPÇÃO DA OFICINA", "FLX_OficinaRecepcao"],
            ["AUTORIZA TRANSFERÊNCIA DE REQUISIÇÃO DA OFICINA", "FLX_OficinaReqTransf"],
            ["REQUISIÇÃO DA OFICINA", "FLX_OficinaRequisicao"],
            ["CANCELAMENTO DA REQUISIÇÃO DA OFICINA", "FLX_OficinaRequisicaoCancela"],
            ["SOLICITA VIA REQUISIÇÃO DA OFICINA", "FLX_OficinaRequisicaoVia"],
            ["GARANTIA DE SERVIÇO DA OFICINA", "FLX_OficinaServGarantia"],
            ["AUTORIZA TRANSFERÊNCIA DA OFICINA", "FLX_OficinaTransferencia"],
            ["AUTORIZAR SERVIÇO DE TERCEIRO COM MARGEM NEGATIVA", "FLX_OfiServTercMargem"],
            ["DESCADASTRO LGPD", "FLX_OptOutDescadastroLGPD"],
            ["ORÇAMENTO DE MODELO", "FLX_OrcamentoModelo"],
            ["ORDEM DE SERVIÇO", "FLX_OS"],
            ["NOTIFICAÇÃO DE OS DE ABERTA", "FLX_OSAberta"],
            ["AUTORIZAR ITENS DE OS BASEADO NO PERFIL DE ACESSO", "FLX_OSAprovacaoPerfil"],
            ["AUTORIZA ABERTURA OS VU", "FLX_OSAutorizaAbertVU"],
            ["ENCERRA TIPO DE OS", "FLX_OSAutorizaEncerramento"],
            ["VALIDA KM/HR OS", "FLX_OSAutorizaKM"],
            ["AUTORIZAR ANÁLISE DE DIGITALIZAÇÃO FINANCEIRA OFICINA", "FLX_OSDigFinOfi"],
            ["AUTORIZA FATURAMENTO ENTRE COLIGADAS", "FLX_OSFaturamentoColigadas"],
            ["AUTORIZAR UTILIZAÇÃO DE R.A. DE TERCEIROS", "FLX_OSRecAntecipado"],
            ["OFICINA TIPO DE OS", "FLX_OSTipoOS"],
            ["ABRIR TIPO DE OS", "FLX_OSTipoOSAbertura"],
            ["ACOMPANHAMENTO DO TEMPO DE EXECUÇÃO DA O.S.", "FLX_OSTipoOSAcompanhamento"],
            ["ACOMPANHAMENTO DO TEMPO DE EXECUÇÃO DA O.S.", "FLX_OSTipoOSAcompanhamentoV2"],
            ["OFICINA TIPO DE OS PARCELA MÍNIMA", "FLX_OSTipoOSAutorizacaoParcelaMinima"],
            ["CANCELAMENTO DE TIPO DE OS", "FLX_OSTipoOSCancelar"],
            ["ENCERRA TIPO DE OS", "FLX_OSTipoOSEncerra"],
            ["AUTORIZAR FATURAMENTO APÓS DIA LIMITE DA OS", "FLX_OSTipoOSFatAposDiaLimite"],
            ["PAGAMENTO DIA", "FLX_PagamentoDia"],
            ["AUTORIZAÇÃO DE PAGAMENTO ELETRÔNICO", "FLX_PagamentoDiaCreditoDebito"],
            ["PAGAMENTO/TRANSFERÊNCIA", "FLX_PagTransf"],
            ["BORDERÔ AGRUPADO GNRE'S AUTOMÁTICO", "FLX_PagTransfDootaxAgrupado"],
            ["PROVISÃO DEVEDORES DUVIDOSOS", "FLX_PDD"],
            ["AUTORIZA PEDIDO DE COMPRA", "FLX_PedidoCompra"],
            ["AVALIAR PEDIDO DE COMPRA MDI", "FLX_PedidoCompraMDI"],
            ["AVISO DE PESQUISA", "FLX_PesquisaAviso"],
            ["AVISO DE PESQUISA", "FLX_PesquisaAvisoV2"],
            ["ENVIA EMAIL PARA PESQUISA", "FLX_PesquisaEmail"],
            ["PESQUISA EMAIL CRIA RAC", "FLX_PesquisaEmailRAC"],
            ["ANÁLISE DE CRÉDITO", "FLX_PessoaAnaliseCredito"],
            ["ANÁLISE DE CRÉDITO", "FLX_PessoaAnaliseCreditoDarCiencia"],
            ["PESSOA ANIVERSARIANTE", "FLX_PessoaAniversario"],
            ["DUPLICAR E-MAIL", "FLX_PessoaAprovaEmailDuplicado"],
            ["APROVAÇÃO DE ALTERAÇÃO DE EMAIL OU TELEFONE", "FLX_PessoaAutorizaAlteracaoCadastro"],
            ["INCLUSÃO OU ALTERAÇÃO DO BANCO E CHAVE PIX", "FLX_PessoaBancoChavePix"],
            ["REVISÃO DO CADASTRO DE PESSOA", "FLX_PessoaRevisao"],
            ["ALTERAR SEGMENTO DE MERCADO", "FLX_PessoaSegMercado"],
            ["PORTARIA", "FLX_Portaria"],
            ["BLOQUEIO AVULSO DE PRODUTO", "FLX_ProdutoBloqueioAvulso"],
            ["PRORROGAR BLOQUEIO DE PRODUTO", "FLX_ProdutoBloqueioProrrogacao"],
            ["AUTORIZAÇÃO DE ALTERAÇÃO DA DESCRIÇÃO DO PRODUTO", "FLX_ProdutoDescricaoAlterar"],
            ["PRODUTO COM ESTOQUE ZERADO", "FLX_ProdutoEstoqueZerado"],
            ["AUTORIZA PEDIDO DE VENDA", "FLX_ProdutoPedidoAut"],
            ["AUTORIZA COMERCIAL PEDIDO", "FLX_ProdutoPedidoCOM"],
            ["AUTORIZAÇÃO DE PARCELA MÍNIMA NO BALCÃO", "FLX_ProdutoPedidoParcelaMinima"],
            ["VALIDADE DO PEDIDO DE VENDA", "FLX_ProdutoPedidoVal"],
            ["VENDA BALCÃO VAREJO E CD", "FLX_ProdutoPedidoVarejo"],
            ["PROMOÇÃO FÁBRICA", "FLX_ProdutoPromocaoFabrica"],
            ["PROPOSTA DE VEÍCULO", "FLX_Proposta"],
            ["INFORMAR ATUALIZAÇÃO DA PROPOSTA", "FLX_PropostaAtualizacao"],
            ["AUTORIZAR DECONTO DA PROPOSTA", "FLX_PropostaAutorizaDesconto"],
            ["CANCELAR PROPOSTA", "FLX_PropostaCancelar"],
            ["ENTREGA DE VEÍCULO DA PROPOSTA", "FLX_PropostaEntrega"],
            ["ENTREGA DE VEÍCULO DA PROPOSTA", "FLX_PropostaEntregaV2"],
            ["OFERECER F&I PARA A PROPOSTA DE VEÍCULO", "FLX_PropostaOferecerFeI"],
            ["PREPARAÇÃO DE ENTREGA DE VEÍCULO", "FLX_PropostaPreparacao"],
            ["PROPOSTA REABERTURA", "FLX_PropostaReabertura"],
            ["PROPOSTA DE VEÍCULO", "FLX_PropostaV2"],
            ["PRORROGAÇÃO OU CANCELAMENTO DE PROPOSTA", "FLX_PropostaValidade"],
            ["RAC DA OFICINA", "FLX_Rac"],
            ["RAC DA OFICINA", "FLX_RacV2"],
            ["RAC DA OFICINA", "FLX_RacV3"],
            ["CONTABILIDADE MALA DIRETA", "FLX_RazaoContabilExcel"],
            ["RECEPÇÃO DE CLIENTE", "FLX_Recepcao"],
            ["CANCELAMENTO DE RECIBO", "FLX_ReciboCancela"],
            ["SOLICITAÇÃO DE VIA DO RECIBO", "FLX_ReciboVia"],
            ["REQUISIÇÃO DE COMPRA", "FLX_RequisicaoCompra"],
            ["REQUISIÇÃO DE COMPRA - AUTORIZAÇÃO POR ALÇADA/DEPARTAMENTO", "FLX_RequisicaoCompraAlcada"],
            ["ANTECIPAR REQUISIÇÃO DE COMPRA", "FLX_RequisicaoCompraAntecipa"],
            ["RECEBIMENTO DE PRODUTO DA RC", "FLX_RequisicaoCompraRecebe"],
            ["REQUISIÇÃO DE COMPRA", "FLX_RequisicaoCompraV2"],
            ["REQUISIÇÃO DE COMPRA", "FLX_RequisicaoCompraV3"],
            ["CANCELAMENTO CONTRATO", "FLX_RevisaoNaMedidaCancela"],
            ["ROMANEIO", "FLX_Romaneio"],
            ["SOLICITAÇÃO DE TRANSFERÊNCIA", "FLX_SolicitacaoTransferencia"],
            ["AUTORIZA SOLICITAÇÃO DE TRANSFERÊNCIA", "FLX_SolicitacaoTransferenciaAutoriza"],
            ["DOWNLOAD ARQUIVO SPED", "FLX_SPEDDownloadArquivo"],
            ["DOWNLOAD ARQUIVO SPED PIS COFINS", "FLX_SPEDPisCofinsDownloadArquivo"],
            ["SOLICITAÇÃO PREPARAÇÃO VEÍCULO NOVO", "FLX_SPVN_CD"],
            ["SUGESTAO DE COMPRA", "FLX_SugestaoCompra"],
            ["AUTORIZAR TESOURARIA", "FLX_TesourariaAutoriza"],
            ["DESCONCILIAR TESOURARIA", "FLX_TesourariaDesconciliar"],
            ["TESOURARIA ACOMPANHAMENTO INDIVIDUAL", "FLX_TesourariaIndividual"],
            ["TESOURARIA NÃO CONCILIADO", "FLX_TesourariaNaoConciliado"],
            ["TEST DRIVE DE VEÍCULO", "FLX_TestDrive"],
            ["UTILIZAÇÃO DE SALDO DA FICHA RAZÃO", "FLX_TipoFichaRazaoSaldo"],
            ["EMITIR NOTA FISCAL DE OFICINA", "FLX_TipoOsEmiNfOfi"],
            ["TÍTULO AVULSO", "FLX_TituloAvulso"],
            ["TÍTULO AVULSO APROVAÇÃO POR ALÇADA", "FLX_TituloAvulsoPDC"],
            ["CANCELAMENTO DE TÍTULO ENVIADO AO BANCO", "FLX_TituloCancela"],
            ["TÍTULO EM ATRASO", "FLX_TituloEmAtraso"],
            ["AUTORIZA MOVIMENTO TÍTULO", "FLX_TituloMovAutoriza"],
            ["PRORROGAÇÃO DO TÍTULO", "FLX_TituloProrrogacao"],
            ["TRANSFERÊNCIA DE ATENDIMENTO", "FLX_TransferenciaAtendimento"],
            ["AUTORIZAÇÃO DE MOVIMENTO DO VEÍCULO SEM OS", "FLX_VECMovimentoAutoriza"],
            ["FOTO DO VEÍCULO", "FLX_VeiculoFoto"],
            ["INDICAÇÃO DE VENDA DE VEÍCULO", "FLX_VeiculoIndicacao"],
            ["INFORMAÇÕES DO VEÍCULO", "FLX_VeiculoInformacao"],
            ["PREENCHIMENTO DE INFORMAÇÕES DO VEÍCULO AVALIAÇÃO", "FLX_VeiculoInformacaoAvaliacao"],
            ["PREÇO DE VEÍCULO USADO", "FLX_VeiculoPrecoUsado"],
            ["PROMOÇÃO DE VEÍCULO", "FLX_VeiculoPromocao"],
            ["RESERVA DE VEÍCULO", "FLX_VeiculoReserva"],
            ["RESERVA DE VEÍCULO INTEGRAÇÃO", "FLX_VeiculoReservaIntegracao"],
            ["TRANSFERÊNCIA DO VEÍCULO", "FLX_VeiculoTransferencia"],
            ["VENDA PERDIDA", "FLX_VendaPerdida"]
        ];
    }

    // Com @run-at document-start (para o tema já pintar a página), o portal ainda não existe aqui
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => aguardarPortal());
    else aguardarPortal();
})();
