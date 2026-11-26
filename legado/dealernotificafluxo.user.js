// ==UserScript==
// @name         DealerNotificaFluxo
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  DESCONTINUADO: agora é a extensão Dealer/Fluxo (Chrome Web Store). Notifica o usuário sobre novos fluxos no DealerNet.
// @author       Igor Lima
// @match        http*://*.dealernetworkflow.com.br/Portal/default.html
// @match        http*://*.dealernetworkflow.com.br/WP_Fluxo.aspx
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/519058/DealerNotificaFluxo.user.js
// @updateURL https://update.greasyfork.org/scripts/519058/DealerNotificaFluxo.meta.js
// ==/UserScript==

/*
    Este código foi gerado por um modelo de IA. Embora tenha sido projetado para ser funcional,
    pode ser necessário realizar uma revisão, testes ou modificações para atender às suas necessidades específicas.
    Verifique o código quanto à correção e adequação antes de utilizá-lo em ambientes de produção.
*/

(function() {
    'use strict';

    const MARCA_LEGADO = 'dnfLegadoNotifica';
    // ---------------------------------------------------------------------------------------------
    // Mudança para a extensão Dealer/Fluxo. Este script (e o DealerNotificaFluxo / DealerBarraDeTarefas) virou
    // a extensão Dealer/Fluxo e não recebe mais atualizações. Mostra um aviso uma vez só (localStorage) e, se a
    // extensão já estiver instalada, não roda (senão a barra e os avisos de fluxos ficam em dobro).
    // Os dois scripts antigos têm este mesmo trecho: cada um se marca na página (data-dnf-legado-*) e o aviso,
    // mostrado por quem chegar primeiro, cita os que estiverem instalados.
    // ---------------------------------------------------------------------------------------------
    const PAGINA_LEGADO = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const LINK_CHROME = 'https://chromewebstore.google.com/detail/dealerfluxo/dgnlfhccofihphmfacpjbgmodbcligaf';
    const LINK_FIREFOX = 'https://addons.mozilla.org/pt-BR/firefox/addon/dealer-fluxo';
    const SCRIPTS_LEGADO = [['dnfLegadoBarra', 'DealerBarraDeTarefas'], ['dnfLegadoNotifica', 'DealerNotificaFluxo']];
    try { document.documentElement.dataset[MARCA_LEGADO] = '1'; } catch (e) { /* nada */ }

    function dealerFluxoInstalado() {
        try { if (PAGINA_LEGADO.top.__dealerFluxoCarregado) return true; } catch (e) { /* nada */ }
        try {
            const d = PAGINA_LEGADO.top.document;
            return !!(d.getElementById('barraTarefasBotaoStatus') || d.getElementById('barraDeTarefasEstilos'));
        } catch (e) {
            return false;
        }
    }

    // Espera o portal ficar pronto e mais um pouco (a extensão começa junto com a página)
    function quandoPortalPronto(fn) {
        let tentativas = 0;
        const esperar = () => {
            let pronto = false;
            try { const p = PAGINA_LEGADO.top.oW5Portal; pronto = !!(p && p.statusbar && p.statusbar.rendered); } catch (e) { /* nada */ }
            if (!pronto && ++tentativas < 80) { setTimeout(esperar, 250); return; }
            setTimeout(fn, 1500);
        };
        esperar();
    }

    function avisoLegado(instalado) {
        if (window.top !== window) return;                       // só na página principal do portal
        const chave = instalado ? 'DealerFluxo.legado.avisoInstalado' : 'DealerFluxo.legado.avisoMudanca';
        try { if (localStorage.getItem(chave)) return; } catch (e) { /* sem localStorage: mostra */ }
        const raiz = document.documentElement;
        if (raiz.dataset.dnfLegadoAviso) return;                 // o outro script antigo já mostrou
        raiz.dataset.dnfLegadoAviso = '1';
        const nomes = SCRIPTS_LEGADO.filter(([marca]) => raiz.dataset[marca]).map(([, nome]) => nome);
        const varios = nomes.length > 1;
        const listaNomes = nomes.map(n => `<b>${n}</b>`).join(' e ');
        const recursos = [
            'Barra de tarefas com as janelas abertas, com aparência personalizável (formatos, cores e efeitos)',
            'Atalhos de teclado que funcionam em qualquer tela',
            'Aviso de novos fluxos, com som opcional e escolha de quais fluxos avisar',
            'Avisos em vermelho das telas em destaque, com botão para copiar o texto',
            'Busca nas listas de opções com muitos itens',
            'Na impressão da OS, os documentos abrem em janelas, prontos para imprimir',
            'Temas de cores claros e escuros, fonte e tamanho do texto (versão alfa)',
            'Funciona também em endereços próprios do DealerNet'
        ];
        const titulo = instalado ? 'O Dealer/Fluxo já está instalado' : `${varios ? 'Estes scripts viraram' : 'Este script virou'} o Dealer/Fluxo`;
        const corpo = instalado ? `
            <p>A extensão <b>Dealer/Fluxo</b> já está instalada neste navegador, então ${listaNomes} ${varios ? 'não vão' : 'não vai'}
               rodar, para nada ficar em dobro.</p>
            <p>${varios ? 'Eles não são mais necessários' : 'Ele não é mais necessário'}: desative ${varios ? 'os dois' : 'o script'} no Tampermonkey
               (clique no ícone do Tampermonkey e desligue ${listaNomes}).</p>
            ${nomes.includes('DealerNotificaFluxo') ? '<p>O aviso de novos fluxos agora fica no Dealer/Fluxo: engrenagem (canto inferior direito) &gt; <b>Notificação de fluxos...</b> (vem desligado).</p>' : ''}` : `
            <p>${listaNomes} ${varios ? 'agora fazem' : 'agora faz'} parte de uma extensão para o navegador, o <b>Dealer/Fluxo</b>,
               com muito mais recursos:</p>
            <ul>${recursos.map(r => `<li>${r}</li>`).join('')}</ul>
            <p><b>Instale:</b> <a href="${LINK_CHROME}" target="_blank" rel="noopener">Chrome e Edge (Chrome Web Store)</a>
               &nbsp;·&nbsp; Firefox: em breve em <a href="${LINK_FIREFOX}" target="_blank" rel="noopener">addons.mozilla.org</a></p>
            <p>Depois de instalar, desative ${varios ? 'estes scripts' : 'este script'} no Tampermonkey (clique no ícone do Tampermonkey e
               desligue ${listaNomes}) e recarregue a página (F5), para não rodarem os dois juntos.</p>
            <p>Se preferir, pode continuar usando ${varios ? 'os scripts: eles continuam' : 'o script: ele continua'} funcionando, só não
               ${varios ? 'recebem' : 'recebe'} mais atualizações.</p>`;
        const fundo = document.createElement('div');
        fundo.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
        const caixa = document.createElement('div');
        caixa.style.cssText = 'max-width:560px;margin:16px;padding:18px 22px 14px;background:#ffffff;color:#222222;border-radius:8px;' +
            'box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.5 Arial,Tahoma,sans-serif;max-height:90vh;overflow:auto';
        caixa.innerHTML = `
            <div style="font-size:17px;font-weight:bold;color:#15428b;margin-bottom:8px">${titulo}</div>
            ${corpo}
            <p style="color:#777777;font-size:11px;margin-bottom:0">Este aviso aparece só uma vez.</p>
            <div style="text-align:right;margin-top:10px"><button type="button" style="font:bold 13px Arial,sans-serif;padding:6px 18px;
                border:0;border-radius:4px;background:#15428b;color:#ffffff;cursor:pointer">Entendi</button></div>`;
        caixa.querySelectorAll('p, ul').forEach(el => { el.style.margin = '0 0 8px'; });
        caixa.querySelectorAll('ul').forEach(el => { el.style.paddingLeft = '22px'; el.style.listStyle = 'disc outside'; });
        caixa.querySelectorAll('li').forEach(el => { el.style.display = 'list-item'; el.style.listStyle = 'disc outside'; });
        caixa.querySelectorAll('a').forEach(a => { a.style.color = '#15428b'; });
        fundo.appendChild(caixa);
        const fechar = () => {
            try {
                localStorage.setItem(chave, '1');
                if (instalado) localStorage.setItem('DealerFluxo.legado.avisoMudanca', '1');   // já sabe da mudança
            } catch (e) { /* nada */ }
            fundo.remove();
        };
        caixa.querySelector('button').addEventListener('click', fechar);
        fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
        document.body.appendChild(fundo);
    }


    // Configuração do script
    const configuracao = {
        //Fluxos a serem procurados e notificados, em formato regex, sempre seguindo o padrão: /^nomedofluxo\(\d+\)$/
        procurarFluxos: [
            /^.*\(\d+\)$/, //Regex para ser notificado sobre todos os fluxos
            //    /^Duplicar E-mail \(\d+\)$/,
            //    /^Recebimento de Garantia da Oficina \(\d+\)$/,
            //    /^Requisição da Oficina \(\d+\)$/,
        ],

        notificacaoHabilitada: true, //Ativa/desativa a notificação, mantendo o realçamento do botão de Administração
        margemTopo: 60, //Margem em pixels do topo da página, usado para notificações,
        notificacaoTempo: 5000, //Tempo (em ms) que a notificação permanece na tela
        pausarNotificacaoAoPassarMouse: true, // Pausar timeout da notificação ao passar o mouse
        intervaloAtualizacaoFluxos: 60000, // Intervalo (em ms) para atualizar os fluxos
        intervaloVerificacaoNotificacao: 10000, // Intervalo que o script procura novos fluxos para notificar
        idBotao: 'ext-gen26', //Botão da barra superior que será realçado ao encontrar fluxos
        textoBotao: 'Administração', //Texto do botão
        classeIframe: 'W5Portal_Window_Frame', //Classe do iframe contendo a página inicial
        idTabelaFluxo: 'W0038GridfluxoContainerTbl', //Tabela contendo os fluxos
        intervaloVerificacaoIframe: 1000 // Intervalo para verificar se o iframe foi carregado
    };

    let botaoModificado = false;
    let fluxosNotificados = new Set();
    let contagemFluxos = new Map();

    // Função auxiliar para dividir texto em fluxos individuais
    const separarFluxosIndividuais = (texto) => {
        // Regex para encontrar todos os matches de "Nome do Fluxo (N)"
        const regexFluxoIndividual = /[^()]+\(\d+\)/g;
        return texto.match(regexFluxoIndividual) || [];
    };

    // Função auxiliar para modificar o botão de administração e atualizar o tooltip
    const modificarBotao = (fluxos) => {
        const botao = document.getElementById(configuracao.idBotao);
        if (botao && botao.textContent.includes(configuracao.textoBotao)) {
            // Adicionar ícone de sino, se não estiver presente
            if (!botao.querySelector('.icone-sino')) {
                const iconeSino = document.createElement('span');
                iconeSino.innerHTML = '📢';
                iconeSino.style.marginRight = '5px';
                iconeSino.classList.add('icone-sino');
                botao.prepend(iconeSino);
                botao.style.fontWeight = 'bold';
                botao.style.color = 'red';
                botaoModificado = true;
            }

            // Atualizar tooltip com fluxos encontrados e suas contagens
            const tooltipFluxos = Array.from(contagemFluxos.entries())
            .map(([fluxo, count]) => `${fluxo}`)
            .join('\n');
            botao.title = tooltipFluxos;
        }
    };

    // Reverter o botão de administração para o estado original
    const reverterBotao = () => {
        const botao = document.getElementById(configuracao.idBotao);
        if (botao && botao.querySelector('.icone-sino')) {
            botao.querySelector('.icone-sino').remove();
            botao.style.fontWeight = 'normal';
            botao.style.color = '';
            botao.title = '';
            botaoModificado = false;
        }
    };

    // Notificar o usuário sobre os fluxos encontrados
    const mostrarNotificacao = (fluxos) => {
        const notificacao = document.createElement('div');
        notificacao.style = `
            position: fixed; right: 0; top: ${configuracao.margemTopo}px;
            background: #FFF;
            color: black; padding: 15px 20px;
            border-radius: 8px 0px 0px 8px;
            max-width: 350px; z-index: 9999; font-family: 'Arial', sans-serif;
            box-shadow: 0 8px 15px rgba(0, 0, 0, 0.2);
            transform: translateX(100%); transition: transform 0.5s ease-in-out, opacity 0.3s ease-in-out;
            opacity: 0;
            border: 1px solid #999;
            cursor: pointer;
        `;

        // Variáveis para controlar o tempo de exibição e o timeout
        let tempoRestante = configuracao.notificacaoTempo;
        let timeoutSaida;
        let inicioTempo;

        // Função para iniciar o timeout de saída
        const iniciarTimeoutSaida = () => {
            inicioTempo = Date.now();
            timeoutSaida = setTimeout(() => {
                notificacao.style.transform = 'translateX(100%)';
                notificacao.style.opacity = '0';
                setTimeout(() => notificacao.remove(), 500); // Remover notificação após animação de saída
            }, tempoRestante);
        };

        // Fechar a notificação ao clicar
        notificacao.onclick = () => {
            notificacao.style.transform = 'translateX(100%)';
            notificacao.style.opacity = '0';
            setTimeout(() => notificacao.remove(), 500); // Remover notificação após animação de saída
        };

        // Adicionar tratamento de pausa com mouse, se habilitado
        if (configuracao.pausarNotificacaoAoPassarMouse) {
            notificacao.addEventListener('mouseenter', () => {
                if (timeoutSaida) {
                    clearTimeout(timeoutSaida);
                    tempoRestante -= (Date.now() - inicioTempo);
                }
            });

            notificacao.addEventListener('mouseleave', () => {
                if (tempoRestante > 0) {
                    iniciarTimeoutSaida();
                }
            });
        }

        // Título
        const titulo = document.createElement('strong');
        titulo.style = 'font-size: 18px; display: block; font-weight: bold; margin-bottom: 5px;';
        titulo.textContent = '🔔 Novos fluxos encontrados';
        notificacao.appendChild(titulo);

        // Corpo
        const corpo = document.createElement('div');
        corpo.style = 'font-size: 14px; white-space: pre-wrap; line-height: 1.4;';
        corpo.textContent = Array.from(fluxos).join('\n');
        notificacao.appendChild(corpo);

        document.body.appendChild(notificacao);

        // Animação de entrada
        setTimeout(() => {
            notificacao.style.transform = 'translateX(0)';
            notificacao.style.opacity = '1';
        }, 100);

        // Iniciar timeout de saída
        iniciarTimeoutSaida();
    };

    // Verificar a tabela de fluxos e aplicar lógica
    const verificarFluxos = (iframe) => {
        const docIframe = iframe.contentDocument || iframe.contentWindow.document;
        if (!docIframe) return;

        const tabela = docIframe.getElementById(configuracao.idTabelaFluxo);
        const fluxosAtualizados = new Set(); // Novo conjunto para rastrear apenas fluxos que mudaram

        if (tabela) {
            const celulas = tabela.getElementsByTagName('td');
            const contagemAtualFluxos = new Map();

            // Iterar sobre as células da tabela
            for (let celula of celulas) {
                const textoCelula = celula.textContent.trim();

                configuracao.procurarFluxos.forEach(padrao => {
                    // Para regex genéricas como /^.*\(\d+\)$/, separar em fluxos individuais
                    if (padrao.toString() === '/^.*\\(\\d+\\)$/') {
                        const fluxosIndividuais = separarFluxosIndividuais(textoCelula);
                        fluxosIndividuais.forEach(fluxo => {
                            const correspondenciaContagem = fluxo.match(/\((\d+)\)/);
                            const contagem = correspondenciaContagem ? parseInt(correspondenciaContagem[1]) : 1;
                            const contagemAnterior = contagemFluxos.get(fluxo) || 0;

                            // Adicionar ao conjunto de fluxos atualizados apenas se a contagem aumentou
                            if (contagem > contagemAnterior) {
                                fluxosAtualizados.add(fluxo);
                            }

                            contagemAtualFluxos.set(fluxo, contagem);
                        });
                    } else {
                        // Para regex específicas, manter o comportamento original
                        const correspondencia = textoCelula.match(padrao);
                        if (correspondencia) {
                            const nomeFluxo = correspondencia[0];
                            const correspondenciaContagem = textoCelula.match(/\((\d+)\)/);
                            const contagem = correspondenciaContagem ? parseInt(correspondenciaContagem[1]) : 1;
                            const contagemAnterior = contagemFluxos.get(nomeFluxo) || 0;

                            if (contagem > contagemAnterior) {
                                fluxosAtualizados.add(nomeFluxo);
                            }

                            contagemAtualFluxos.set(nomeFluxo, contagem);
                        }
                    }
                });
            }

            // Atualizar o botão se houver qualquer fluxo (para manter o visual de alerta)
            if (contagemAtualFluxos.size > 0) {
                modificarBotao(contagemAtualFluxos);
            } else {
                reverterBotao();
                contagemFluxos.clear();
                fluxosNotificados.clear();
            }

            // Notificar apenas se houver fluxos realmente atualizados
            if (fluxosAtualizados.size > 0 && configuracao.notificacaoHabilitada) {
                mostrarNotificacao(fluxosAtualizados);
            }

            // Atualizar as contagens depois de processar tudo
            contagemFluxos = new Map(contagemAtualFluxos);
        }
    };

    // Detectar quando o iframe foi totalmente carregado
    const esperarCarregamentoIframe = () => {
        const iframe = document.querySelector(`.${configuracao.classeIframe}`);
        if (iframe) {
            iframe.onload = () => verificarFluxos(iframe);
            verificarFluxos(iframe);
        }
    };

    // Verificar continuamente a presença do iframe e monitorar fluxos
    const verificarContinuamenteIframe = () => {
        const intervaloId = setInterval(() => {
            const iframe = document.querySelector(`.${configuracao.classeIframe}`);
            if (iframe) {
                clearInterval(intervaloId);
                esperarCarregamentoIframe();
            }
        }, configuracao.intervaloVerificacaoIframe);
    };

    // Lógica principal do script baseada na página atual
    // Só roda se a extensão Dealer/Fluxo não estiver instalada (ela já tem o aviso de fluxos)
    const site = window.location.pathname;
    quandoPortalPronto(() => {
        if (dealerFluxoInstalado()) {
            if (site === '/Portal/default.html') {
                console.info('[DealerNotificaFluxo] A extensão Dealer/Fluxo está instalada; este script não vai rodar. Desative-o no Tampermonkey.');
                setTimeout(() => avisoLegado(true), 1000);
            }
            return;
        }
        if (site === '/Portal/default.html') {
            verificarContinuamenteIframe();
            setInterval(verificarContinuamenteIframe, configuracao.intervaloVerificacaoNotificacao);
            setTimeout(() => avisoLegado(false), 1000);
        } else if (site === '/WP_Fluxo.aspx') {
            setInterval(() => gx.evt.execEvt('W0038E\'DOATUALIZAR\'.', this), configuracao.intervaloAtualizacaoFluxos);
        }
    });
})();