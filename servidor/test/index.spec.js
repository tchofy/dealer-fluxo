import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { diaBrasilia, diaValido, dicaSegura } from '../src';

const enviar = (caminho, corpo, metodo = 'POST') =>
	SELF.fetch(`https://exemplo.workers.dev${caminho}`, {
		method: metodo,
		headers: { 'Content-Type': 'application/json' },
		body: metodo === 'POST' ? (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) : undefined,
	});
const tabela = async (nome) => (await env.DB.prepare(`SELECT * FROM ${nome}`).all()).results;
const PING = { versao: '3.12.0', navegador: 'chrome 131', dados: { tema: 'dracula' } };

beforeAll(async () => {
	await env.DB.exec('CREATE TABLE IF NOT EXISTS pings (dia TEXT NOT NULL, versao TEXT NOT NULL, navegador TEXT NOT NULL, dados TEXT NOT NULL)');
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS semicone (arquivo TEXT NOT NULL, versao_tema TEXT NOT NULL, situacao TEXT NOT NULL, dica TEXT NOT NULL, tela TEXT NOT NULL, relatos INTEGER NOT NULL, primeiro_dia TEXT NOT NULL, ultimo_dia TEXT NOT NULL, PRIMARY KEY (arquivo, versao_tema))"
	);
});
beforeEach(async () => {
	await env.DB.exec('DELETE FROM pings');
	await env.DB.exec('DELETE FROM semicone');
});

describe('/ping', () => {
	it('grava um ping válido sem IP nem localização, no dia de hoje', async () => {
		const r = await enviar('/ping', PING);
		expect(r.status).toBe(204);
		expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const [linha] = await tabela('pings');
		expect(linha).toEqual({ dia: diaBrasilia(), versao: '3.12.0', navegador: 'chrome 131', dados: '{"tema":"dracula","uso":{}}' });
	});

	it('usa o dia informado, se estiver nos últimos 30 dias', async () => {
		const ontem = diaBrasilia(Date.now() - 864e5);
		expect((await enviar('/ping', { ...PING, dia: ontem })).status).toBe(204);
		expect((await tabela('pings'))[0].dia).toBe(ontem);
		expect((await enviar('/ping', { ...PING, dia: diaBrasilia(Date.now() + 2 * 864e5) })).status).toBe(400);
		expect((await enviar('/ping', { ...PING, dia: diaBrasilia(Date.now() - 40 * 864e5) })).status).toBe(400);
		expect((await enviar('/ping', { ...PING, dia: '2026-02-30' })).status).toBe(400);
	});

	it('recusa formatos inválidos', async () => {
		expect((await enviar('/ping', 'não é json')).status).toBe(400);
		expect((await enviar('/ping', { ...PING, versao: 'x' })).status).toBe(400);
		expect((await enviar('/ping', { ...PING, navegador: '' })).status).toBe(400);
		expect((await enviar('/ping', { ...PING, dados: [1] })).status).toBe(400);
		expect((await enviar('/ping', { ...PING, dados: { x: 'a'.repeat(5000) } })).status).toBe(413);
	});
});

describe('/semicone', () => {
	const RELATO = {
		versao: '3.12.0',
		versaoTema: '1.16.0',
		itens: [
			['btnFoo.png', 'Gerar relatório', 'empresa.aspx', 'sem regra'],
			['icoBar.gif', 'Cliente 12345', 'pessoa.aspx', 'rótulo deduzido'],
		],
	};

	it('soma por imagem e versão do tema, e limpa dicas com números', async () => {
		expect((await enviar('/semicone', RELATO)).status).toBe(204);
		expect((await enviar('/semicone', RELATO)).status).toBe(204);
		expect((await enviar('/semicone', { ...RELATO, versaoTema: '1.17.0', itens: [RELATO.itens[0]] })).status).toBe(204);
		const linhas = (await tabela('semicone')).sort((a, b) => (a.arquivo + a.versao_tema).localeCompare(b.arquivo + b.versao_tema));
		expect(linhas.map((l) => [l.arquivo, l.versao_tema, l.relatos, l.dica])).toEqual([
			['btnFoo.png', '1.16.0', 2, 'Gerar relatório'],
			['btnFoo.png', '1.17.0', 1, 'Gerar relatório'],
			['icoBar.gif', '1.16.0', 2, ''],
		]);
	});

	it('recusa relatos inválidos', async () => {
		expect((await enviar('/semicone', { ...RELATO, versaoTema: 'x' })).status).toBe(400);
		expect((await enviar('/semicone', { ...RELATO, itens: [] })).status).toBe(400);
		expect((await enviar('/semicone', { ...RELATO, itens: [['../etc', '', 'a.aspx', 'sem regra']] })).status).toBe(400);
		expect((await enviar('/semicone', { ...RELATO, itens: [['a.png', '', 'a.aspx', 'outra']] })).status).toBe(400);
		expect(await tabela('semicone')).toEqual([]);
	});
});

describe('outros', () => {
	it('mostra a política de privacidade', async () => {
		const r = await enviar('/privacidade', null, 'GET');
		expect(r.status).toBe(200);
		expect(await r.text()).toContain('política de privacidade');
	});

	it('responde ao preflight e ignora outros caminhos e métodos', async () => {
		expect((await enviar('/ping', null, 'OPTIONS')).status).toBe(204);
		expect((await enviar('/ping', null, 'GET')).status).toBe(404);
		expect((await enviar('/outro', {})).status).toBe(404);
	});

	it('funções auxiliares', () => {
		expect(diaBrasilia(Date.parse('2026-11-24T02:30:00Z'))).toBe('2026-11-23');
		expect(diaValido(diaBrasilia())).toBe(true);
		expect(diaValido('ontem')).toBe(false);
		expect(dicaSegura('  Gerar   relatório ')).toBe('Gerar relatório');
		expect(dicaSegura('NF 123')).toBe('');
		expect(dicaSegura('a'.repeat(61))).toBe('');
	});
});
