import { formatDate as dfnsFormatDate } from 'date-fns'

export function formatDate(date: Date): string {
	return dfnsFormatDate(date, 'yyyy-MM-dd')
}
