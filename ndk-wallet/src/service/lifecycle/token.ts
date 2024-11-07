import type { NDKEvent, NDKRelay } from "@nostr-dev-kit/ndk";
import { NDKCashuToken } from "../../cashu/token";
import type NDKWalletLifecycle from ".";
import type { NDKCashuWallet } from "../../cashu/wallet";
import { CashuMint, CashuWallet } from "@cashu/cashu-ts";

async function handleToken(this: NDKWalletLifecycle, event: NDKEvent, relay?: NDKRelay) {
    if (this.knownTokens.has(event.id)) return;
    this.knownTokens.add(event.id);

    const token = await NDKCashuToken.from(event);
    if (!token || !token.mint) return;

    // check if token contains any spent proof
    // if so then  discard this token
    const _wallet = new CashuWallet(new CashuMint(token.mint));
    const spentProofs = await _wallet.checkProofsSpent(token.proofs);
    if (spentProofs.length > 0) return;

    const walletId = token.walletId;
    let wallet: NDKCashuWallet | undefined;
    if (walletId) wallet = this.wallets.get(walletId);
    wallet ??= this.defaultWallet;

    if (!wallet) {
        this.debug("no wallet found for token %s", token.id);
        this.orphanedTokens.set(token.id, token);
    } else {
        wallet.addToken(token);
    }
}

export default handleToken;
