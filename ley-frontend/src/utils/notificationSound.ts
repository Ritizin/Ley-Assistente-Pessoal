// Som de notificação (dois "beeps" em sequência) tocado quando chega uma
// mensagem nova do WhatsApp. Gerado 100% via Web Audio API — sem precisar
// de nenhum arquivo .mp3/.wav no projeto (não depende de asset estático,
// então funciona direto após o deploy no Render sem configuração extra).

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  return audioCtx
}

// Navegadores bloqueiam áudio antes de qualquer interação do usuário
// (autoplay policy). Como o painel já exige clicar em "Entrar com Google"
// pra logar, esse clique já libera o AudioContext pro resto da sessão —
// só temos que garantir que ele não fique suspenso.
function ensureResumed(ctx: AudioContext) {
  if (ctx.state === 'suspended') {
    void ctx.resume()
  }
}

function playTone(ctx: AudioContext, frequency: number, startTime: number, duration: number) {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(frequency, startTime)

  // envelope curto (attack/release) pra não estourar/clicar no início e fim
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02)
  gain.gain.linearRampToValueAtTime(0, startTime + duration)

  oscillator.connect(gain)
  gain.connect(ctx.destination)

  oscillator.start(startTime)
  oscillator.stop(startTime + duration)
}

// Toca o som de notificação: dois tons curtos e ascendentes, no estilo de
// aviso de mensagem recebida.
export function playNotificationSound(): void {
  try {
    const ctx = getAudioContext()
    ensureResumed(ctx)

    const now = ctx.currentTime
    playTone(ctx, 740, now, 0.12) // primeiro "bip"
    playTone(ctx, 990, now + 0.12, 0.16) // segundo "bip", mais agudo
  } catch (err) {
    // ambiente sem suporte a Web Audio (raro) — falha silenciosamente,
    // não deve quebrar o recebimento da mensagem em si
    console.error('Não foi possível tocar o som de notificação', err)
  }
}
