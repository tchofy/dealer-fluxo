/*
    Dealer/Fluxo - ponte da telemetria entre a página e o fundo da extensão.

    O código do Dealer/Fluxo roda no contexto da página (mundo MAIN) e não tem acesso às APIs da extensão.
    Ele dispara "dealerfluxo:telemetria" no document com um JSON; este script (mundo isolado da extensão)
    repassa ao background.js e, se a mensagem tiver "id", devolve a resposta em "dealerfluxo:telemetria-resposta".
    Só estes tipos passam; o conteúdo é conferido e filtrado de novo no background.js.
*/
(() => {
    const api = globalThis.browser || globalThis.chrome;
    const TIPOS = new Set(['estado', 'contar', 'previa', 'situacao', 'abrirOpcoes']);
    document.addEventListener('dealerfluxo:telemetria', (evento) => {
        let msg;
        try { msg = JSON.parse(evento.detail); } catch (e) { return; }
        if (!msg || typeof msg !== 'object' || !TIPOS.has(msg.tipo)) return;
        const responder = (resposta) => {
            if (!msg.id) return;
            document.dispatchEvent(new CustomEvent('dealerfluxo:telemetria-resposta',
                { detail: JSON.stringify({ id: msg.id, resposta: resposta === undefined ? null : resposta }) }));
        };
        try {
            Promise.resolve(api.runtime.sendMessage({ tipo: 'telemetria', msg }))
                .then(r => responder(r && r.ok ? r.resultado : null), () => responder(null));
        } catch (e) {
            responder(null);   // extensão recarregada/atualizada com a página aberta
        }
    });
})();
