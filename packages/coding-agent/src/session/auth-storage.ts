/**
 * Re-exports from @zag/zag-ai.
 * All credential storage types and the AuthStorage class now live in the ai package.
 */

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	CredentialOrigin,
	CredentialOriginKind,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthCredential,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	StoredAuthCredential,
} from "@zag/zag-ai";
export { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@zag/zag-ai";
export type { SnapshotResponse } from "@zag/zag-ai/auth-broker/types";
