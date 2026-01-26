const routes = {
	HOME: '/' as const,
	CONNECT: '/(app)/connect' as const,
	ACCOUNT_NEW: '/(app)/account/new' as const,
	PASSKEY_NEW: '/(app)/passkey/new' as const,
	ETH_NEW: '/(app)/eth/new' as const,
	IDENTITY_NEW: '/(app)/identity/new' as const,
	IDENTITY: '/(app)/identity/[id]' as const,
	IDENTITY_APPS: '/(app)/identity/[id]/apps' as const,
	IDENTITY_STAMPS: '/(app)/identity/[id]/stamps' as const,
	IDENTITY_STAMPS_NEW: '/(app)/identity/[id]/stamps/new' as const,
	IDENTITY_SETTINGS: '/(app)/identity/[id]/settings' as const,
}

export default routes
