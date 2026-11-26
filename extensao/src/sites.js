/*
    Dealer/Fluxo - popup do botão da extensão e página de configurações (mesmo código).
    popup.html: mostra a aba atual (ativar neste site) e a lista de sites.
    opcoes.html: só a lista de sites.
*/
const PADRAO_EMBUTIDO = { host: /(^|\.)dealernetworkflow\.com\.br$/i, caminho: /^\/Portal\/default\.html/i };
const modo = document.body.dataset.modo;
const $ = (s) => document.querySelector(s);
let recemAtivado = false;  // a página está recarregando: não sugere recarregar

function el(tag, props = {}, ...filhos) {
    const e = Object.assign(document.createElement(tag), props);
    filhos.forEach(f => e.append(f));
    return e;
}

// Padrão de match (sem porta, como o navegador trata) -> RegExp
function padraoParaRegex(padrao) {
    const m = padrao.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
    if (!m) return null;
    const esc = (t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const esquema = m[1] === '*' ? 'https?' : m[1];
    const host = m[2] === '*' ? '[^/]+' : m[2].startsWith('*.') ? `([^/]+\\.)?${esc(m[2].slice(2))}` : esc(m[2]);
    const caminho = esc(m[3]).replace(/\*/g, '.*');
    return new RegExp(`^${esquema}://${host}(:\\d+)?${caminho}$`, 'i');
}

function siteDaUrl(url) {
    const u = new URL(url);
    return {
        origem: `${u.protocol}//${u.hostname}/*`,
        padrao: `${u.protocol}//${u.hostname}${u.pathname}*`
    };
}

function descricaoSite(padrao) {
    return padrao.replace(/^https?:\/\//, '').replace(/\*$/, '');
}

async function lerSites() {
    const { sites = [] } = await chrome.storage.local.get('sites');
    return sites;
}

async function abaAlvo() {
    const id = new URLSearchParams(location.search).get('aba');  // usado pelos testes automáticos
    if (id) return chrome.tabs.get(Number(id));
    const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
    return aba;
}

// A página parece o portal DealerNet? (olha só o HTML; roda isolado da página)
async function examinarAba(aba) {
    try {
        const [r] = await chrome.scripting.executeScript({
            target: { tabId: aba.id },
            func: () => ({
                portal: !!(document.querySelector('script[src*="W5Portal"]') || document.getElementById('W5-minimized-menu')),
                carregado: !!document.getElementById('barraTarefasBotaoStatus')
            })
        });
        return r.result;
    } catch (e) {
        return null;  // página do navegador, loja de extensões, etc.
    }
}

// ---------------------------------------------------------------------------------------------
// Aba atual (só no popup)
// ---------------------------------------------------------------------------------------------

async function mostrarAbaAtual() {
    const area = $('#abaAtual');
    if (!area) return;
    const aba = await abaAlvo();
    const sites = await lerSites();
    area.replaceChildren();

    if (!aba || !/^https?:/.test(aba.url || '')) {
        area.append(el('p', { className: 'dica', textContent: 'Entre no DealerNet nesta aba e, na página que abre depois do login, clique de novo neste botão.' }));
        return;
    }
    const url = new URL(aba.url);
    const embutido = PADRAO_EMBUTIDO.host.test(url.hostname) && PADRAO_EMBUTIDO.caminho.test(url.pathname);
    const adicionado = sites.find(s => { const r = padraoParaRegex(s.padrao); return r && r.test(aba.url); });
    const exame = await examinarAba(aba);

    if (embutido || adicionado) {
        area.append(el('p', { className: 'estado ativo', textContent: '✔ O Dealer/Fluxo está ativo neste site.' }));
        if (!recemAtivado && exame && exame.portal && !exame.carregado) {
            area.append(el('p', { className: 'dica', textContent: 'Se a barra não apareceu, recarregue a página (F5).' }));
        }
        return;
    }

    const site = siteDaUrl(aba.url);
    // Guarda antes do clique: no Firefox o popup fecha quando aparece o pedido de permissão,
    // e quem termina a ativação é a parte de fundo da extensão.
    await chrome.storage.local.set({ pendente: { ...site, aba: aba.id } });

    const portal = exame && exame.portal;
    area.append(el('p', {
        className: 'estado',
        textContent: portal ? 'Esta é a página que abre depois do login no DealerNet.' :
            'Esta não parece ser a página que abre depois do login no DealerNet. Entre no DealerNet, espere a página abrir e clique de novo neste botão.'
    }));
    const botao = el('button', {
        id: 'ativar',
        className: portal ? 'principal' : 'secundario',
        textContent: portal ? 'Ativar Dealer/Fluxo neste site' : 'Ativar mesmo assim'
    });
    area.append(botao);
    area.append(el('p', { className: 'dica' },
        'O navegador vai pedir permissão para acessar ', el('b', { textContent: url.hostname }),
        '. O Dealer/Fluxo só roda em ', el('b', { textContent: descricaoSite(site.padrao) }), '.'));

    botao.addEventListener('click', () => {
        // permissions.request precisa ser a primeira coisa no clique (sem await antes)
        chrome.permissions.request({ origins: [site.origem] }).then(async (ok) => {
            if (!ok) {
                mostrarMensagem('Permissão negada. O Dealer/Fluxo não foi ativado neste site.', true);
                return;
            }
            await chrome.runtime.sendMessage({ tipo: 'concluirPendente' });
            recemAtivado = true;
            mostrarMensagem('Ativado! A página do DealerNet foi recarregada.');
            atualizarTudo();
        }, (e) => mostrarMensagem(`Não foi possível pedir a permissão: ${e.message || e}`, true));
    });
}

// ---------------------------------------------------------------------------------------------
// Lista de sites
// ---------------------------------------------------------------------------------------------

async function mostrarSites() {
    const lista = $('#sites');
    const sites = await lerSites();
    lista.replaceChildren(
        el('li', { className: 'fixo' },
            el('span', { className: 'endereco', textContent: '*.dealernetworkflow.com.br' }),
            el('span', { className: 'rotulo', textContent: 'padrão' }))
    );
    for (const site of sites) {
        const remover = el('button', { className: 'remover', textContent: 'Remover', title: 'Desativar o Dealer/Fluxo neste site' });
        remover.dataset.id = site.id;
        remover.addEventListener('click', async () => {
            remover.disabled = true;
            await chrome.runtime.sendMessage({ tipo: 'remover', id: site.id });
            mostrarMensagem(`Removido: ${descricaoSite(site.padrao)}. Recarregue a página do DealerNet (F5) para desligar a barra.`);
            atualizarTudo();
        });
        lista.append(el('li', {},
            el('span', { className: 'endereco', textContent: descricaoSite(site.padrao), title: site.padrao }),
            remover));
    }
    $('#semSites').hidden = sites.length > 0;
}

function mostrarMensagem(texto, erro = false) {
    const m = $('#mensagem');
    m.textContent = texto;
    m.className = erro ? 'erro' : 'ok';
    m.hidden = false;
}

function atualizarTudo() {
    mostrarAbaAtual();
    mostrarSites();
}

$('#versao').textContent = `v${chrome.runtime.getManifest().version}`;
const linkOpcoes = $('#abrirOpcoes');
if (linkOpcoes) {
    linkOpcoes.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });
}
// Firefox: permissões de dados da extensão (estatísticas de uso e imagens sem ícone do tema).
// O pedido de permissão precisa vir de um clique numa página da extensão, por isso fica aqui.
async function mostrarDadosFirefox() {
    const secao = $('#dadosFirefox');
    if (!secao) return;
    let dados;
    try { dados = (await chrome.permissions.getAll()).data_collection; } catch (e) { dados = undefined; }
    if (!Array.isArray(dados)) return;                  // não é o Firefox (ou é anterior ao 140)
    secao.hidden = false;
    const tem = (tipo) => dados.includes(tipo);
    $('#estadoUso').textContent = tem('technicalAndInteraction') ? 'permitido' : 'não permitido';
    $('#estadoSemIcone').textContent = tem('websiteContent') ? 'permitido' : 'não permitido';
    $('#permitirSemIcone').hidden = tem('websiteContent');
    $('#retirarSemIcone').hidden = !tem('websiteContent');
}
if (modo === 'opcoes') {
    const permitir = $('#permitirSemIcone'), retirar = $('#retirarSemIcone');
    if (permitir) permitir.addEventListener('click', () => {
        chrome.permissions.request({ data_collection: ['websiteContent'] }).then(mostrarDadosFirefox, mostrarDadosFirefox);
    });
    if (retirar) retirar.addEventListener('click', () => {
        chrome.permissions.remove({ data_collection: ['websiteContent'] }).then(mostrarDadosFirefox, mostrarDadosFirefox);
    });
    if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(mostrarDadosFirefox);
    if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(mostrarDadosFirefox);
    mostrarDadosFirefox();
}

chrome.storage.onChanged.addListener((mudancas) => { if (mudancas.sites) mostrarSites(); });
chrome.runtime.sendMessage({ tipo: 'sincronizar' }).catch(() => {});
atualizarTudo();
