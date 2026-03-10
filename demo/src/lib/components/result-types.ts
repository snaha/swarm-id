type ResultVariant = 'default' | 'success' | 'warning'

interface ResultEntry {
  label?: string
  value: string
}

export interface ResultData {
  title: string
  titleVariant?: ResultVariant
  entries?: ResultEntry[]
  code?: string
  codeDark?: boolean
  status?: string
  statusVariant?: ResultVariant
  footnote?: string
}
