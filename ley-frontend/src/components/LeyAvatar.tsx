// Avatar animado da Ley — um orbe de gradiente girando/pulsando, no mesmo
// espírito visual do indicador de voz (AudioVisualizer/VoiceModal), só que
// em CSS puro (leve o bastante pra repetir em cada mensagem do chat, sem
// precisar de canvas/AnalyserNode por avatar).

interface LeyAvatarProps {
  size?: number
  // "listening"/"speaking" deixam o pulso mais rápido/intenso — usado no
  // futuro se o VoiceModal quiser reaproveitar esse mesmo avatar como estado
  // ocioso antes de ligar o AudioVisualizer de verdade
  active?: boolean
}

export default function LeyAvatar({ size = 32, active = false }: LeyAvatarProps) {
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'conic-gradient(from 0deg, #2f8fff, #7c5cff, #5ec2ff, #2f56e0, #2f8fff)',
          animation: `ley-orb-spin ${active ? '3s' : '7s'} linear infinite, ley-orb-pulse ${
            active ? '1.6s' : '3.2s'
          } ease-in-out infinite`,
        }}
      />
      <div className="absolute inset-[15%] rounded-full bg-midnight-900/90 blur-[1px]" />
      <div
        className="absolute inset-[15%] rounded-full opacity-80"
        style={{
          background: 'radial-gradient(circle at 35% 30%, rgba(94,194,255,0.55), transparent 70%)',
        }}
      />
    </div>
  )
}
