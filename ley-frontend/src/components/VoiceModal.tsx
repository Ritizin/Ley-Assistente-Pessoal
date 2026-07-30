import React, { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE_URL } from '../config/api'
import { X, MonitorUp, MonitorOff, Circle, Square as StopIcon } from 'lucide-react';
import { AudioVisualizer } from './AudioVisualizer';

interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSendMessage: (message: string, imageBase64?: string) => Promise<string | void>;
  sessionId?: string;
}

const API_BASE = API_BASE_URL;

// comandos de voz que encerram a gravação de tela sem precisar chamar o backend —
// mais rápido e confiável do que dar uma volta pelo modelo pra uma ação puramente local
const STOP_SCREEN_RECORDING_RE = /\b(para|parar|pare)\s+de\s+grava[r]?\s+(a\s+)?tela\b/i;

export const VoiceModal: React.FC<VoiceModalProps> = ({ isOpen, onClose, onSendMessage, sessionId }) => {
  const [status, setStatus] = useState<'listening' | 'processing' | 'speaking' | 'error'>('listening');
  const [transcript, setTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const [activeAnalyser, setActiveAnalyser] = useState<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const isClosingRef = useRef<boolean>(false);
  const isListeningActiveRef = useRef<boolean>(false);
  const transcriptRef = useRef<string>('');
  const voicesCacheRef = useRef<SpeechSynthesisVoice[]>([]);

  // --- compartilhamento e gravação de tela ---
  const [screenSharing, setScreenSharing] = useState(false);
  const [showRecordPrompt, setShowRecordPrompt] = useState(false);
  const [screenRecording, setScreenRecording] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenRecorderRef = useRef<MediaRecorder | null>(null);
  const screenChunksRef = useRef<Blob[]>([]);
  const screenSharingRef = useRef(false); // espelha o state pra usar dentro de closures (onend do STT)
  const screenRecordingRef = useRef(false);

  // Mantém o transcript sincronizado com a ref para evitar stale closures
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  // Chrome carrega as vozes de forma assíncrona — sem isso, getVoices() às vezes
  // retorna array vazio na primeira chamada e a voz Jarvis nunca é selecionada
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) voicesCacheRef.current = voices;
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  // Selecionar voz masculina grave (estilo Jarvis)
  const getJarvisVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (!('speechSynthesis' in window)) return null;
    const voices = voicesCacheRef.current.length > 0 ? voicesCacheRef.current : window.speechSynthesis.getVoices();
    const ptVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('pt'));
    const pool = ptVoices.length > 0 ? ptVoices : voices; // fallback: qualquer voz disponível

    if (pool.length === 0) return null;

    const preferredNames = [
      'Daniel', 'Jorge', 'Luciano', 'Ricardo', 'Felipe', 'Antonio',
      'Google português do Brasil', 'Microsoft Daniel', 'Microsoft Duarte',
    ];
    for (const name of preferredNames) {
      const match = pool.find((v) => v.name.includes(name));
      if (match) return match;
    }

    const femaleMarkers = [
      'maria', 'francisca', 'helena', 'luciana', 'fernanda', 'female', 'catarina',
      'samantha', 'zira', 'susan', 'karen', 'victoria', 'tessa', 'moira', 'veena',
      'ava', 'allison', 'siri', 'joana', 'ines', 'monica', 'paulina', 'kyoko',
    ];
    const nonFemale = pool.find((v) => !femaleMarkers.some((m) => v.name.toLowerCase().includes(m)));

    // se não achou nenhuma voz masculina confiável, não arrisca devolver uma
    // feminina qualquer (pool[0]) — melhor ficar em silêncio do que soar errado
    return nonFemale ?? null;
  }, []);

  // Inicializa microfone + Web Audio API para o visualizador (escuta)
  const setupAudio = useCallback(async () => {
    try {
      if (!audioContextRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(micAnalyser);

        // analyser separado pra reagir à voz da Ley (evita loop/feedback com o mic)
        const ttsAnalyser = audioCtx.createAnalyser();
        ttsAnalyser.fftSize = 256;

        audioContextRef.current = audioCtx;
        micAnalyserRef.current = micAnalyser;
        ttsAnalyserRef.current = ttsAnalyser;
        setActiveAnalyser(micAnalyser);
      }
    } catch (err) {
      console.error('Erro ao acessar microfone:', err);
      setErrorMessage('Não foi possível acessar o microfone.');
      setStatus('error');
    }
  }, []);

  // Compartilhamento de tela (PC apenas — navegadores mobile não suportam
  // getDisplayMedia de forma confiável; ver aviso na UI)
  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      screenSharingRef.current = true;
      setScreenSharing(true);
      setShowRecordPrompt(true);

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      screenVideoRef.current = video;

      // se o usuário parar o compartilhamento pelo próprio navegador (barra
      // do Chrome "Parar apresentação"), limpa o estado aqui também
      stream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());
    } catch (err) {
      console.error('Erro ao compartilhar tela:', err);
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
      screenRecorderRef.current.stop();
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenVideoRef.current = null;
    screenSharingRef.current = false;
    screenRecordingRef.current = false;
    setScreenSharing(false);
    setScreenRecording(false);
    setShowRecordPrompt(false);
  }, []);

  const startScreenRecording = useCallback(() => {
    if (!screenStreamRef.current) return;
    screenChunksRef.current = [];

    const recorder = new MediaRecorder(screenStreamRef.current, { mimeType: 'video/webm' });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) screenChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(screenChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ley-gravacao-tela-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };

    recorder.start();
    screenRecorderRef.current = recorder;
    screenRecordingRef.current = true;
    setScreenRecording(true);
    setShowRecordPrompt(false);
  }, []);

  const stopScreenRecording = useCallback(() => {
    screenRecorderRef.current?.stop();
    screenRecorderRef.current = null;
    screenRecordingRef.current = false;
    setScreenRecording(false);
  }, []);

  // captura o frame atual da tela compartilhada como JPEG base64 (sem o
  // prefixo data:) pra mandar junto com a próxima mensagem pro modelo de visão.
  // Reduz pra no máximo 1280px de largura: o modelo de visão não precisa da
  // resolução nativa da tela (que em telas 1440p/4K gerava um base64 de vários
  // MB, disparando timeouts e — antes do fix de bodyLimit no backend — erro
  // 413 no /api/chat) e a conversa fica bem mais rápida.
  const MAX_FRAME_WIDTH = 1280;

  const captureScreenFrame = useCallback((): string | null => {
    const video = screenVideoRef.current;
    if (!video || video.readyState < 2) return null;

    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // qualidade reduzida: é só pro modelo "ver", não precisa de resolução alta
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    return dataUrl.split(',')[1] ?? null;
  }, []);


  const speakWithBrowser = useCallback((text: string, onEndCallback: () => void) => {
    if (!('speechSynthesis' in window)) {
      onEndCallback();
      return;
    }

    window.speechSynthesis.cancel();

    const jarvisVoice = getJarvisVoice();
    if (!jarvisVoice) {
      // nenhuma voz masculina/confiável disponível no navegador — melhor ficar
      // em silêncio (texto ainda aparece na tela) do que arriscar soar com a
      // voz errada. Isso só acontece se ElevenLabs E Piper também falharam.
      console.warn('[TTS] Nenhuma voz nativa masculina/confiável encontrada — pulando fala do navegador (silencioso).');
      onEndCallback();
      return;
    }

    setActiveAnalyser(micAnalyserRef.current); // sem stream de áudio pra analisar aqui

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = jarvisVoice;

    utterance.pitch = 0.8; // grave
    utterance.rate = 0.98; // ritmo calmo, estilo Jarvis

    utterance.onstart = () => {
      if (!isClosingRef.current) setStatus('speaking');
    };
    utterance.onend = () => {
      if (!isClosingRef.current) onEndCallback();
    };
    utterance.onerror = (e) => {
      console.error('Erro na síntese de voz nativa:', e);
      if (!isClosingRef.current) onEndCallback();
    };

    window.speechSynthesis.speak(utterance);
  }, [getJarvisVoice]);

  // Tenta ElevenLabs primeiro; em QUALQUER falha (401/402/rede/404) cai pro navegador
  // de forma transparente, sem travar a tela nem interromper a conversa
  const speakResponse = useCallback((text: string, onEndCallback: () => void) => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionId }),
        });

        if (!res.ok) {
          let detail = '';
          try { detail = await res.text(); } catch { /* corpo vazio/ilegível, segue sem detalhe */ }
          console.error(
            `[TTS] ElevenLabs falhou (HTTP ${res.status}) — caindo pra voz nativa do navegador.`,
            detail || '(sem corpo de resposta)'
          );
          throw new Error(`tts-http-${res.status}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioRef.current = audio;

        // conecta o áudio da Ley ao analyser dedicado pro orbe reagir também ao falar
        if (audioContextRef.current && ttsAnalyserRef.current) {
          const source = audioContextRef.current.createMediaElementSource(audio);
          source.connect(ttsAnalyserRef.current);
          ttsAnalyserRef.current.connect(audioContextRef.current.destination);
          setActiveAnalyser(ttsAnalyserRef.current);
        }

        audio.onplay = () => {
          if (!isClosingRef.current) setStatus('speaking');
        };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          currentAudioRef.current = null;
          if (!isClosingRef.current) onEndCallback();
        };
        audio.onerror = (e) => {
          console.error('[TTS] Elemento <audio> falhou ao reproduzir a voz do Ley — caindo pra voz nativa do navegador:', e);
          URL.revokeObjectURL(url);
          currentAudioRef.current = null;
          if (!isClosingRef.current) speakWithBrowser(text, onEndCallback);
        };

        await audio.play();
      } catch (err) {
        // loga o motivo real (rede caiu, blob inválido, audio.play() bloqueado, etc)
        // antes de cair pra voz nativa — sem isso a troca de voz acontecia muda
        console.error('[TTS] Falha ao reproduzir áudio do Ley (ElevenLabs/Piper) — caindo pra voz nativa do navegador:', err);
        if (!isClosingRef.current) speakWithBrowser(text, onEndCallback);
      }
    })();
  }, [sessionId, speakWithBrowser]);

  // Inicia escuta (STT) com trava contra loop e erro 'aborted'
  const startListening = useCallback(() => {
    if (isClosingRef.current || isListeningActiveRef.current) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setErrorMessage('Navegador sem suporte ao reconhecimento de voz. Use Chrome ou Edge.');
      setStatus('error');
      return;
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* noop */ }
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isListeningActiveRef.current = true;
      if (!isClosingRef.current) {
        setStatus('listening');
        setActiveAnalyser(micAnalyserRef.current);
        setTranscript('');
      }
    };

    recognition.onresult = (event: any) => {
      const currentText = Array.from(event.results)
        .map((result: any) => result[0].transcript)
        .join('');
      setTranscript(currentText);
    };

    recognition.onerror = (event: any) => {
      isListeningActiveRef.current = false;
      if (event.error === 'aborted') return; // interrupção esperada (fechar/reiniciar), ignora

      console.warn('Erro do SpeechRecognition:', event.error);
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        setErrorMessage('Acesso ao microfone foi negado.');
        setStatus('error');
      }
    };

    recognition.onend = async () => {
      isListeningActiveRef.current = false;
      if (isClosingRef.current) return;

      const currentTranscript = transcriptRef.current;

      if (currentTranscript.trim()) {
        // comando local: "parar de gravar tela" — ação puramente do navegador,
        // não precisa (e não deve) passar pelo modelo/backend pra isso
        if (screenRecordingRef.current && STOP_SCREEN_RECORDING_RE.test(currentTranscript)) {
          stopScreenRecording();
          speakResponse('Parei de gravar a tela. Salvei o vídeo pra você.', () => {
            if (!isClosingRef.current) startListening();
          });
          return;
        }

        setStatus('processing');
        try {
          const frame = screenSharingRef.current ? captureScreenFrame() : undefined;
          const reply = await onSendMessage(currentTranscript, frame ?? undefined);
          if (reply && typeof reply === 'string' && !isClosingRef.current) {
            speakResponse(reply, () => { if (!isClosingRef.current) startListening(); });
          } else if (!isClosingRef.current) {
            startListening();
          }
        } catch (err) {
          console.error('Erro ao enviar mensagem:', err);
          if (!isClosingRef.current) {
            speakResponse('Desculpe, ocorreu um erro ao processar sua solicitação.', () => {
              if (!isClosingRef.current) startListening();
            });
          }
        }
      } else if (!isClosingRef.current) {
        setTimeout(() => { if (!isClosingRef.current) startListening(); }, 300);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      isListeningActiveRef.current = false;
    }
  }, [onSendMessage, speakResponse, stopScreenRecording, captureScreenFrame]);

  // Libera microfone/áudio/recognition — NÃO fecha o modal (usado no cleanup do efeito)
  const releaseResources = useCallback(() => {
    isListeningActiveRef.current = false;

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* noop */ }
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    micAnalyserRef.current = null;
    ttsAnalyserRef.current = null;

    // encerra compartilhamento/gravação de tela junto — não faz sentido
    // continuar gravando com o modal de voz fechado
    if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
      screenRecorderRef.current.stop();
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenVideoRef.current = null;
    screenSharingRef.current = false;
    screenRecordingRef.current = false;
    setScreenSharing(false);
    setScreenRecording(false);
    setShowRecordPrompt(false);
  }, []);

  // Fecha o modal de fato — só é chamado por ação explícita do usuário (X / ESC)
  const handleClose = useCallback(() => {
    isClosingRef.current = true;
    releaseResources();
    onClose();
  }, [onClose, releaseResources]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // FIX do bug "abre e fecha": o cleanup deste efeito só libera recursos —
  // nunca chama onClose(). Antes, o cleanup chamava handleClose() (que chama
  // onClose()) toda vez que o efeito re-executava, fechando o modal sozinho
  // logo após abrir.
  useEffect(() => {
    if (isOpen) {
      isClosingRef.current = false;
      setupAudio();
      if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
      startListening();
    } else {
      isClosingRef.current = true;
      releaseResources();
    }

    return () => {
      isClosingRef.current = true;
      releaseResources();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-slate-950 via-[#070b19] to-black text-white p-6 transition-all duration-300">
      <div className="w-full flex justify-between items-center">
        <div className="flex items-center gap-2">
          <button
            onClick={screenSharing ? stopScreenShare : startScreenShare}
            title={screenSharing ? 'Parar compartilhamento de tela' : 'Compartilhar tela (só no PC)'}
            className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
              screenSharing
                ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            {screenSharing ? <MonitorOff className="w-4 h-4" /> : <MonitorUp className="w-4 h-4" />}
            {screenSharing ? 'Compartilhando' : 'Compartilhar tela'}
          </button>

          {screenRecording && (
            <span className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-2 text-xs font-medium text-red-300 ring-1 ring-red-500/30">
              <Circle className="w-2.5 h-2.5 fill-red-400 text-red-400 animate-pulse" />
              Gravando tela
            </span>
          )}
        </div>

        <button
          onClick={handleClose}
          className="p-3 rounded-full text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors cursor-pointer"
          title="Fechar modo de voz (ESC)"
        >
          <X className="w-7 h-7" />
        </button>
      </div>

      {showRecordPrompt && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <span>Quer que o Ley grave sua tela?</span>
          <button
            onClick={startScreenRecording}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-400 cursor-pointer"
          >
            Gravar
          </button>
          <button
            onClick={() => setShowRecordPrompt(false)}
            className="rounded-lg px-3 py-1.5 text-xs text-sky-200/70 hover:text-sky-100 cursor-pointer"
          >
            Agora não
          </button>
        </div>
      )}

      {screenRecording && (
        <button
          onClick={stopScreenRecording}
          className="mt-2 flex items-center gap-1.5 self-center rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 cursor-pointer"
        >
          <StopIcon className="w-3.5 h-3.5" />
          Parar gravação (ou fale "parar de gravar tela")
        </button>
      )}

      <div className="flex-1 flex flex-col items-center justify-center w-full my-auto">
        <AudioVisualizer
          analyser={activeAnalyser}
          isActive={status === 'listening' || status === 'speaking'}
        />

        <div className="mt-8 text-center max-w-xl px-4 min-h-[80px]">
          {status === 'listening' && (
            <p className="text-sky-400/90 text-lg font-medium animate-pulse">
              {transcript ? `"${transcript}"` : 'Ouvindo...'}
            </p>
          )}
          {status === 'processing' && (
            <p className="text-slate-300 text-lg font-medium animate-pulse">Pensando...</p>
          )}
          {status === 'speaking' && (
            <p className="text-sky-300 text-lg font-medium">Ley respondendo...</p>
          )}
          {status === 'error' && (
            <p className="text-red-400 text-base font-medium">
              {errorMessage || 'Ocorreu um erro com o áudio.'}
            </p>
          )}
        </div>
      </div>

      <div className="text-xs text-slate-500 font-light pb-2">
        Modo Mão-Livre Ley Ativo • Fale naturalmente
      </div>
    </div>
  );
};

export default VoiceModal;
