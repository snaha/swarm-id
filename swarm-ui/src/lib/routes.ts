export default {
	HOME: `/`,
	CONNECT: `/connect`,
	PASSKEY_NEW: `/passkey/new`,
	ETH_NEW: `/eth/new`,
	IDENTITY_NEW: `/identity/new`,
	IDENTITY: (id: string) => `/identity/${id}`,
	IDENTITY_APPS: (id: string) => `/identity/${id}/apps`,
	IDENTITY_STAMPS: (id: string) => `/identity/${id}/stamps`,
	IDENTITY_SETTINGS: (id: string) => `/identity/${id}/settings`,
} as const
