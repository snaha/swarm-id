type LogType = 'info' | 'error' | 'warn'

interface LogEntry {
  time: string
  type: LogType
  message: string
}

let entries = $state<LogEntry[]>([])

export const logStore = {
  get entries() {
    return entries
  },

  log(message: string, type: LogType = 'info') {
    const time = Date.now()
    const timeStr = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).format(time)
    entries = [...entries, { time: timeStr, type, message }]
    console.log(`[${type}]`, message)
  },

  clear() {
    entries = []
  },
}
