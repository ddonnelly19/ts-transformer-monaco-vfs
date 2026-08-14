export function getStorageItem(key: string, fallback = ''): string {
	if (typeof window === 'undefined') {
		return fallback
	}
	try {
		return window.localStorage.getItem(key) ?? fallback
	} catch {
		return fallback
	}
}

export function setStorageItem(key: string, value: string): void {
	if (typeof window === 'undefined') {
		return
	}
	try {
		window.localStorage.setItem(key, value)
	} catch {
		// Ignore storage failures (quota exceeded, blocked access, etc.).
	}
}


