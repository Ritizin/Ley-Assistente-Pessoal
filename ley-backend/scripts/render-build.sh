#!/usr/bin/env bash
set -euo pipefail

# Roda como Build Command do serviço de BACKEND no Render (native runtime,
# sem Docker). Duas partes:
#
# 1) build normal do TypeScript (igual sempre foi)
# 2) baixa o Piper (binário + espeak-ng-data) e a voz escolhida pra dentro de
#    ley-backend/vendor/piper — porque:
#    - o runtime nativo do Render tem ffmpeg, mas NÃO tem espeak-ng
#      (dependência do Piper pra fonemização); o pacote oficial do Piper já
#      vem com uma pasta espeak-ng-data própria, então não precisa do
#      pacote do sistema
#    - o filesystem do Render é efêmero (sem disco persistente pago): tudo
#      que não estiver num Persistent Disk some a cada deploy — então
#      baixamos de novo TODA build. É rápido (uns MB) e não depende de
#      disco persistente pra isso, só pro storage/ (sessão do WhatsApp + banco)
#
# Ajuste PIPER_VOICE se quiser trocar a voz (cadu/faber/jeff/edresson/tugão)
# — precisa bater com o PIPER_VOICE_MODEL_PATH configurado nas env vars do
# serviço no Render.

PIPER_VOICE="${PIPER_VOICE:-cadu}"
PIPER_VOICE_LOCALE="${PIPER_VOICE_LOCALE:-pt_BR}"
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/piper"

echo "==> Instalando dependências e compilando o backend..."
# --include=dev é necessário mesmo com NODE_ENV=production setado (usamos
# esse valor de propósito pra runtime) — sem isso, o npm ci pula os
# devDependencies (typescript, tsx, todos os @types/*), e o build quebra
# com "Could not find a declaration file for module 'X'" pra várias libs.
npm ci --include=dev

# Chama o compilador direto via `node .../tsc.js` em vez de `npm run build`
# (que roda o "tsc" cru esperando o PATH resolver certo). Motivo: em pelo
# menos um deploy real, isso resolveu pra um pacote de PIADA publicado no
# npm com o nome "tsc" (que só imprime uma mensagem e sai com status 0) em
# vez do compilador de verdade — o build passava como "successful" sem
# gerar nada em dist/, e o deploy só quebrava depois, no start ("Cannot
# find module dist/bootstrap.js"). Chamando o arquivo direto do
# node_modules instalado localmente, não tem ambiguidade nenhuma possível.
node node_modules/typescript/lib/tsc.js -p tsconfig.json

# checagem de sanidade: se por qualquer motivo o build "passar" sem gerar o
# arquivo de entrada de verdade, falha AGORA (build) em vez de falhar depois
# (start) com um erro bem mais confuso.
if [ ! -f "dist/bootstrap.js" ]; then
  echo "==> ERRO: dist/bootstrap.js não foi gerado pelo build do TypeScript." >&2
  echo "==> Isso não deveria acontecer — investiga o output do tsc acima." >&2
  exit 1
fi

echo "==> Preparando o Piper TTS em ${VENDOR_DIR}..."
mkdir -p "${VENDOR_DIR}/voices"

if [ ! -f "${VENDOR_DIR}/piper/piper" ]; then
  echo "  - baixando binário do Piper (linux x86_64)..."
  curl -fL -o /tmp/piper.tar.gz \
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
  tar -xzf /tmp/piper.tar.gz -C "${VENDOR_DIR}"
  rm -f /tmp/piper.tar.gz
else
  echo "  - binário do Piper já presente, pulando download"
fi

VOICE_FILE="${VENDOR_DIR}/voices/${PIPER_VOICE_LOCALE}-${PIPER_VOICE}-medium.onnx"
if [ ! -f "${VOICE_FILE}" ]; then
  echo "  - baixando voz ${PIPER_VOICE}..."
  curl -fL -o "${VOICE_FILE}" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/${PIPER_VOICE_LOCALE}/${PIPER_VOICE}/medium/${PIPER_VOICE_LOCALE}-${PIPER_VOICE}-medium.onnx"
  curl -fL -o "${VOICE_FILE}.json" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/${PIPER_VOICE_LOCALE}/${PIPER_VOICE}/medium/${PIPER_VOICE_LOCALE}-${PIPER_VOICE}-medium.onnx.json"
else
  echo "  - voz ${PIPER_VOICE} já presente, pulando download"
fi

echo "==> Testando se o Piper roda de verdade..."
echo "teste" | "${VENDOR_DIR}/piper/piper" --model "${VOICE_FILE}" --output_file /tmp/piper-build-test.wav
rm -f /tmp/piper-build-test.wav
echo "==> Piper OK. Build finalizado."
