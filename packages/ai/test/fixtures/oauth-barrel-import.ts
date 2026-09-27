import { getOAuthProviders as rootGetOAuthProviders, refreshOAuthToken as rootRefreshOAuthToken } from "@zag/zag-ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@zag/zag-ai/registry/oauth";
import "@zag/zag-ai/providers/anthropic";
import "@zag/zag-ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
