export function notImplemented(e?: Event) {
	if (e) {
		e.preventDefault()
		e.stopPropagation()
	}
	alert('Not implemented!')
}
