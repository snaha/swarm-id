export function notImplemented(e: Event) {
	e.preventDefault()
	e.stopPropagation()
	alert('Not implemented!')
}
