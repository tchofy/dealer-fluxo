# Gera os ícones da extensão (16/32/48/128 px) a partir de icones/original.png.
# Para trocar o ícone: substitua icones/original.png (quadrado, de preferência 512 px ou mais) e rode
#   python3 gerar_icones.py && python3 build.py
from PIL import Image, ImageDraw
import os

AQUI = os.path.dirname(os.path.abspath(__file__))
ORIGINAL = os.path.join(AQUI, "icones", "original.png")
CANTO = 0.18  # raio dos cantos arredondados, em proporção do lado

original = Image.open(ORIGINAL).convert("RGBA")
lado = min(original.size)
original = original.crop(((original.width - lado) // 2, (original.height - lado) // 2,
                          (original.width + lado) // 2, (original.height + lado) // 2))

# A Chrome Web Store pede o de 128 px com o desenho em 96x96 e 16 px transparentes de cada lado
# (https://developer.chrome.com/docs/webstore/images#icons); os menores ocupam o quadrado todo.
MARGEM = {128: 16}


def icone(tamanho):
    img = original.resize((tamanho, tamanho), Image.LANCZOS)
    # Cantos arredondados (máscara desenhada grande e reduzida, para ficar suave)
    escala = 8
    mascara = Image.new("L", (tamanho * escala, tamanho * escala), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, tamanho * escala - 1, tamanho * escala - 1],
                                              radius=int(tamanho * escala * CANTO), fill=255)
    mascara = mascara.resize((tamanho, tamanho), Image.LANCZOS)
    alfa = Image.composite(img.getchannel("A"), Image.new("L", img.size, 0), mascara)
    img.putalpha(alfa)
    return img


for tamanho in (16, 32, 48, 128):
    margem = MARGEM.get(tamanho, 0)
    img = Image.new("RGBA", (tamanho, tamanho), (0, 0, 0, 0))
    img.paste(icone(tamanho - 2 * margem), (margem, margem))
    img.save(os.path.join(AQUI, "icones", f"icone{tamanho}.png"), optimize=True)
    print(f"icones/icone{tamanho}.png" + (f" (desenho {tamanho - 2 * margem} px + {margem} px transparentes)" if margem else ""))
