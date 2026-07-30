import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyser, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resolução interna fixa de alta definição
    const size = 700;
    canvas.width = size;
    canvas.height = size;

    const centerX = size / 2;
    const centerY = size / 2;
    const baseRadius = size * 0.38; // Raio gigante (~266px)

    const bufferLength = analyser ? analyser.frequencyBinCount : 0;
    const dataArray = analyser ? new Uint8Array(bufferLength) : new Uint8Array(0);

    let phase = 0;

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);

      ctx.clearRect(0, 0, size, size);

      let averageVolume = 0;
      if (analyser && isActive) {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        averageVolume = sum / bufferLength;
      }

      const normVolume = Math.min(1, averageVolume / 128);
      phase += 0.03 + normVolume * 0.05;

      // Glow de fundo / Aura azul neon
      const bgGlow = ctx.createRadialGradient(centerX, centerY, baseRadius * 0.2, centerX, centerY, baseRadius * 1.4);
      bgGlow.addColorStop(0, `rgba(56, 189, 248, ${0.1 + normVolume * 0.25})`);
      bgGlow.addColorStop(0.5, `rgba(14, 165, 233, ${0.05 + normVolume * 0.15})`);
      bgGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = bgGlow;
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseRadius * 1.4, 0, Math.PI * 2);
      ctx.fill();

      // Anel Toroidal / Torus Principal
      const numPoints = 120;
      ctx.save();
      ctx.translate(centerX, centerY);

      // Desenhar camada externa
      ctx.beginPath();
      for (let i = 0; i <= numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        const wave = Math.sin(angle * 6 + phase) * (8 + normVolume * 25);
        const freqIndex = Math.floor((i / numPoints) * (bufferLength / 2));
        const freqVal = dataArray[freqIndex] || 0;
        const radius = baseRadius + wave + (freqVal / 255) * 35;

        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      ctx.strokeStyle = `rgba(56, 189, 248, ${0.8 + normVolume * 0.2})`;
      ctx.lineWidth = 3 + normVolume * 4;
      ctx.shadowColor = '#0ea5e9';
      ctx.shadowBlur = 20 + normVolume * 25;
      ctx.stroke();

      // Desenhar camada interna pulsante
      ctx.beginPath();
      for (let i = 0; i <= numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        const wave = Math.cos(angle * 8 - phase) * (5 + normVolume * 15);
        const radius = baseRadius * 0.82 + wave;

        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      ctx.strokeStyle = `rgba(186, 230, 253, ${0.6 + normVolume * 0.4})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 12;
      ctx.stroke();

      // Núcleo brilhante central (Orbe)
      const coreRadius = baseRadius * 0.22 + normVolume * 18;
      const coreGlow = ctx.createRadialGradient(0, 0, 2, 0, 0, coreRadius);
      coreGlow.addColorStop(0, '#ffffff');
      coreGlow.addColorStop(0.4, '#38bdf8');
      coreGlow.addColorStop(1, 'rgba(14, 165, 233, 0)');

      ctx.beginPath();
      ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
      ctx.fillStyle = coreGlow;
      ctx.fill();

      ctx.restore();
    };

    draw();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [analyser, isActive]);

  return (
    <div className="relative flex items-center justify-center w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-[min(85vmin,700px)] h-[min(85vmin,700px)] object-contain"
      />
    </div>
  );
};
