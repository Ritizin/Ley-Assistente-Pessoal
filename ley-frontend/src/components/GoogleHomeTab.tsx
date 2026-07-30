import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'
import { Home, ExternalLink, LogOut, Thermometer, Wifi, WifiOff, Flame, Snowflake, Power } from 'lucide-react'

type GoogleHomeStatus = 'disconnected' | 'connected'

interface GoogleHomeDevice {
  id: string
  name: string
  type: string
  room: string | null
  online: boolean
  thermostatMode?: string
  thermostatSetpointCelsius?: number
  ambientTemperatureCelsius?: number
  ambientHumidityPercent?: number
}

interface GoogleHomeTabProps {
  onGoogleHomeEvent: (fn: (event: string, data: any) => void) => () => void
}

const API_URL = `${API_BASE_URL}/api/google-home`

export default function GoogleHomeTab({ onGoogleHomeEvent }: GoogleHomeTabProps) {
  const [status, setStatus] = useState<GoogleHomeStatus>('disconnected')
  const [devices, setDevices] = useState<GoogleHomeDevice[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API_URL}/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.status) setStatus(data.status)
        if (data?.devices) setDevices(data.devices)
      })
      .catch(() => {})

    const unsubscribe = onGoogleHomeEvent((event, data) => {
      if (event === 'status') {
        setStatus(data?.status ?? 'disconnected')
        if (data?.status === 'disconnected') setDevices([])
      } else if (event === 'devices') {
        setDevices(data?.devices ?? [])
      }
    })
    return unsubscribe
  }, [onGoogleHomeEvent])

  const handleConnect = () => {
    window.open(`${API_URL}/login`, '_blank')
  }

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/disconnect`, { method: 'POST' }).catch(() => {})
    setStatus('disconnected')
    setDevices([])
  }

  const setMode = async (deviceId: string, mode: 'HEAT' | 'COOL' | 'OFF') => {
    setBusyId(deviceId)
    try {
      await fetch(`${API_URL}/thermostat/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, mode }),
      })
    } catch {
      // silencioso — o próximo poll de dispositivos já corrige o estado exibido
    } finally {
      setBusyId(null)
    }
  }

  const adjustTemp = async (deviceId: string, celsius: number) => {
    setBusyId(deviceId)
    try {
      await fetch(`${API_URL}/thermostat/temperature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, celsius, mode: 'heat' }),
      })
    } catch {
      // idem
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-white/5 px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-white">Google Home</h1>
        <p className="text-sm text-slate-400">Controle termostatos e dispositivos Nest da sua casa</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 px-6 py-6">
        {status === 'disconnected' && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/5 bg-midnight-800/40 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-500/10 ring-1 ring-sky-500/30">
              <Home size={32} className="text-sky-400" />
            </div>
            <p className="font-medium text-white">Conectar o Google Home</p>
            <p className="max-w-xs text-sm text-slate-400">
              Abre uma aba pra você autorizar o acesso aos dispositivos Nest vinculados à sua casa no Google Home.
            </p>
            <button
              onClick={handleConnect}
              className="mt-2 flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400"
            >
              <ExternalLink size={16} />
              Conectar Google Home
            </button>
          </div>
        )}

        {status === 'connected' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-end">
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5"
              >
                <LogOut size={14} />
                Desconectar
              </button>
            </div>

            {devices.length === 0 && (
              <p className="text-center text-sm text-slate-500">
                Nenhum dispositivo encontrado. Confira se a estrutura foi selecionada durante a autorização.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {devices.map((device) => (
                <div key={device.id} className="rounded-2xl border border-white/5 bg-midnight-800/40 p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-white">{device.name}</p>
                      {device.room && <p className="text-xs text-slate-500">{device.room}</p>}
                    </div>
                    {device.online ? (
                      <Wifi size={16} className="text-emerald-400" />
                    ) : (
                      <WifiOff size={16} className="text-slate-600" />
                    )}
                  </div>

                  {device.type === 'THERMOSTAT' && (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2 text-sm text-slate-300">
                        <Thermometer size={16} className="text-sky-400" />
                        {device.ambientTemperatureCelsius != null
                          ? `${device.ambientTemperatureCelsius.toFixed(1)}°C ambiente`
                          : 'Sem leitura'}
                        {device.thermostatSetpointCelsius != null &&
                          ` · alvo ${device.thermostatSetpointCelsius.toFixed(1)}°C`}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setMode(device.id, 'HEAT')}
                          disabled={busyId === device.id}
                          className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-orange-300 hover:bg-white/5 disabled:opacity-50"
                        >
                          <Flame size={14} /> Aquecer
                        </button>
                        <button
                          onClick={() => setMode(device.id, 'COOL')}
                          disabled={busyId === device.id}
                          className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-sky-300 hover:bg-white/5 disabled:opacity-50"
                        >
                          <Snowflake size={14} /> Resfriar
                        </button>
                        <button
                          onClick={() => setMode(device.id, 'OFF')}
                          disabled={busyId === device.id}
                          className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 disabled:opacity-50"
                        >
                          <Power size={14} /> Desligar
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => adjustTemp(device.id, (device.thermostatSetpointCelsius ?? 20) - 1)}
                          disabled={busyId === device.id}
                          className="rounded-lg border border-white/10 px-3 py-1 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50"
                        >
                          −
                        </button>
                        <button
                          onClick={() => adjustTemp(device.id, (device.thermostatSetpointCelsius ?? 20) + 1)}
                          disabled={busyId === device.id}
                          className="rounded-lg border border-white/10 px-3 py-1 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )}

                  {device.type !== 'THERMOSTAT' && (
                    <p className="text-xs text-slate-500">
                      {device.type === 'CAMERA' && 'Câmera Nest — visualização ainda não disponível no painel.'}
                      {device.type === 'DOORBELL' && 'Campainha Nest — visualização ainda não disponível no painel.'}
                      {device.type !== 'CAMERA' && device.type !== 'DOORBELL' && 'Dispositivo conectado.'}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <p className="text-center text-[11px] text-slate-500">
              Também dá pra falar com a Ley: "coloca a temperatura em 22 graus", "liga o aquecimento", "qual a temperatura da casa"...
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
