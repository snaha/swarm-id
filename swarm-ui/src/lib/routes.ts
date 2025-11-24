export default {
	HOME: `/`,
	CONNECT: `/connect`,
	PASSKEY_NEW: `/passkey/new`,
	ETH_NEW: `/eth/new`,
	IDENTITY_NEW: `/identity/new`,
	IDENTITY: (id: string) => `/identity/${id}`,
} as const
