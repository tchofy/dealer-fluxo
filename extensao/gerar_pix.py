#!/usr/bin/env python3
"""
Gera o QR code do Pix da aba "Café" das configurações e grava no ../userscript.js, entre os marcadores
"// ==== Pix (gerado por extensao/gerar_pix.py" e "// ==== fim do Pix ====".

    pip install segno          (só para rodar este script; a extensão não usa biblioteca de QR)
    python3 gerar_pix.py

Para trocar a chave: cole o novo "Pix copia e cola" em PIX abaixo e rode de novo. O script confere o CRC do
código (os 4 últimos caracteres) antes de gravar. O QR vai como PNG (data URI) dentro do código, já no tamanho em
que aparece, com um número inteiro de pixels por módulo: o navegador não precisa redimensionar (nada de borrão).
"""
import os
import re
import struct
import zlib
import sys

PIX = ("00020126580014BR.GOV.BCB.PIX01367cd8e5d6-030c-487a-b111-ea27ee04777e5204000053039865802BR"
       "5918Igor Lima Sant Ana6009SAO PAULO621405104XrDyyVUOS6304A637")

PIXELS_POR_MODULO = 4      # QR versão 8 = 49 módulos + 4 de margem de cada lado = 57 -> 228 px

AQUI = os.path.dirname(os.path.abspath(__file__))
USERSCRIPT = os.path.join(AQUI, "..", "userscript.js")
INICIO = "// ==== Pix (gerado por extensao/gerar_pix.py, não editar aqui) ===="
FIM = "// ==== fim do Pix ===="


def crc16(texto):
    """CRC16-CCITT (0x1021, início 0xFFFF), o usado pelo Pix."""
    crc = 0xFFFF
    for byte in texto.encode("utf-8"):
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return f"{crc:04X}"


def png_preto_e_branco(matriz):
    """PNG de 1 bit (0 = branco, 1 = preto) em base64, sem bibliotecas de imagem."""
    import base64
    altura, largura = len(matriz), len(matriz[0])
    linhas = b""
    for linha in matriz:
        bits = "".join("0" if v else "1" for v in linha)          # paleta em tons de cinza: 0 = preto, 1 = branco
        bits += "0" * (-len(bits) % 8)
        linhas += b"\x00" + int(bits, 2).to_bytes(len(bits) // 8, "big")
    def bloco(tipo, dados):
        return struct.pack(">I", len(dados)) + tipo + dados + struct.pack(">I", zlib.crc32(tipo + dados) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n" + bloco(b"IHDR", struct.pack(">IIBBBBB", largura, altura, 1, 0, 0, 0, 0))
           + bloco(b"IDAT", zlib.compress(linhas, 9)) + bloco(b"IEND", b""))
    return base64.b64encode(png).decode("ascii")


def main():
    try:
        import segno
    except ImportError:
        raise SystemExit("Instale o segno: pip install segno")
    if not PIX.startswith("000201") or PIX[-8:-4] != "6304" or crc16(PIX[:-4]) != PIX[-4:]:
        raise SystemExit(f"Código Pix inválido (CRC esperado {crc16(PIX[:-4])}, no código {PIX[-4:]})")

    qr = segno.make(PIX, error="m", micro=False)
    # Preto no branco, com a margem branca que os leitores precisam (o tema de cores não mexe em imagens data:).
    # Cada módulo vira um bloco de PIXELS_POR_MODULO x PIXELS_POR_MODULO (vizinho mais próximo, sem suavizar).
    matriz = [[1 if m else 0 for m in linha] for linha in qr.matrix_iter(scale=PIXELS_POR_MODULO, border=4)]
    tamanho = len(matriz)
    uri = "data:image/png;base64," + png_preto_e_branco(matriz)

    with open(USERSCRIPT, encoding="utf-8") as f:
        texto = f.read()
    i, j = texto.find(INICIO), texto.find(FIM)
    if i < 0 or j < i:
        raise SystemExit("Marcadores do Pix não encontrados em userscript.js")
    recuo = re.search(r"([ \t]*)$", texto[:i]).group(1)
    bloco = (f"{INICIO}\n"
             f"{recuo}const PIX_COPIA_E_COLA = '{PIX}';\n"
             f"{recuo}const PIX_QR = '{uri}';   // versão {qr.version}, correção M\n"
             f"{recuo}const PIX_QR_TAMANHO = {tamanho};   // px, mostrado sem redimensionar\n"
             f"{recuo}")
    novo = texto[:i] + bloco + texto[j:]
    if novo != texto:
        with open(USERSCRIPT, "w", encoding="utf-8") as f:
            f.write(novo)
        print(f"userscript.js: Pix atualizado (QR versão {qr.version}, {len(uri)} caracteres)")
    else:
        print("userscript.js: Pix já estava atualizado")


if __name__ == "__main__":
    sys.exit(main())
