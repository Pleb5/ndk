import type {
    CashuPaymentInfo,
    NDKEventId,
    NDKPaymentConfirmationCashu,
    NDKPaymentConfirmationLN,
    NDKSubscription,
    NDKTag,
    NDKZapDetails,
} from "@nostr-dev-kit/ndk";
import NDK, { NDKEvent, NDKKind, NDKPrivateKeySigner, NDKRelaySet } from "@nostr-dev-kit/ndk";
import type { NostrEvent } from "@nostr-dev-kit/ndk";
import { NDKCashuToken, proofsTotalBalance } from "./token.js";
import { NDKCashuDeposit } from "./deposit.js";
import createDebug from "debug";
import type { MintUrl } from "./mint/utils.js";
import { NDKCashuPay } from "./pay.js";
import type { Proof } from "@cashu/cashu-ts";
import { CashuMint, CashuWallet } from "@cashu/cashu-ts";
import { NDKWalletChange } from "./history.js";
import { checkTokenProofs } from "./validate.js";
import { NDKWallet, NDKWalletBalance, NDKWalletEvents, NDKWalletStatus } from "../wallet/index.js";
import { EventEmitter } from "tseep";
import { decrypt } from "./decrypt.js";

const d = createDebug("ndk-wallet:cashu:wallet");

type NDKCashuWalletEvents = NDKWalletEvents & {
    rollover_done: (
        destroyedTokens: NDKCashuToken[],
        createdToken: NDKCashuToken | undefined
    ) => void;
    rollover_failed: (
        usedTokens: NDKCashuToken[],
        movedProofs: Proof[],
        changes: Proof[],
        mint: string
    ) => void;
    received_proofs: (proofs: Proof[], mint: MintUrl) => void;
    found_spent_token: () => void;
};

/**
 * This class tracks state of a NIP-60 wallet
 */
export class NDKCashuWallet extends EventEmitter<NDKCashuWalletEvents> implements NDKWallet {
    readonly type = "nip-60";

    public tokens: NDKCashuToken[] = [];
    public usedTokenIds = new Set<NDKEventId>();
    private knownTokens: Set<NDKEventId> = new Set();
    private skipPrivateKey: boolean = false;
    public p2pk: string | undefined;
    private sub?: NDKSubscription;
    public ndk: NDK;

    public status: NDKWalletStatus = NDKWalletStatus.INITIAL;

    static kind = NDKKind.CashuWallet;
    static kinds = [NDKKind.CashuWallet];

    public privateTags: NDKTag[] = [];
    public publicTags: NDKTag[] = [];

    public _event?: NDKEvent;
    public walletId: string = "unset";

    constructor(ndk: NDK, event?: NDKEvent) {
        super();
        if (!ndk) throw new Error("no ndk instance");
        this.ndk = ndk;
        if (!event) {
            event = new NDKEvent(ndk);
            event.kind = NDKKind.CashuWallet;
            event.dTag = Math.random().toString(36).substring(3);
            event.tags = [];
        }
        
        this.event = event;
        this.event.ndk = ndk;
    }

    set event(e: NDKEvent) {
        this.walletId = e.dTag!;
        this._event = e;
    }

    get event(): NDKEvent {
        if (!this._event) throw new Error("wallet event not ready");
        return this._event;
    }

    tagId() {
        return this.event.tagId();
    }

    /**
     * Returns the tokens that are available for spending
     */
    get availableTokens(): NDKCashuToken[] {
        return this.tokens.filter((t) => !this.usedTokenIds.has(t.id));
    }

    /**
     * Adds a token to the list of used tokens
     * to make sure it's proofs are no longer available
     */
    public addUsedTokens(token: NDKCashuToken[]) {
        for (const t of token) {
            this.usedTokenIds.add(t.id);
        }
        this.emit("balance_updated");
    }

    public checkProofs = checkTokenProofs.bind(this);

    static async from(event: NDKEvent): Promise<NDKCashuWallet | undefined> {
        if (!event.ndk) throw new Error("no ndk instance on event");
        const wallet = new NDKCashuWallet(event.ndk, event);
        if (wallet.isDeleted) return;

        const prevContent = wallet.event.content;
        wallet.publicTags = wallet.event.tags;
        try {
            await decrypt(wallet.event);
            wallet.privateTags = JSON.parse(wallet.event.content);
        } catch (e) {
            throw e;
        }
        wallet.event.content ??= prevContent;

        await wallet.getP2pk();

        return wallet;
    }

    get allTags(): NDKTag[] {
        return this.privateTags.concat(this.publicTags);
    }

    private setPrivateTag(name: string, value: string | string[]) {
        this.privateTags = this.privateTags.filter((t) => t[0] !== name);
        if (Array.isArray(value)) {
            for (const v of value) {
                this.privateTags.push([name, v]);
            }
        } else {
            this.privateTags.push([name, value]);
        }
    }

    private getPrivateTags(name: string): string[] {
        return this.privateTags.filter((t) => t[0] === name).map((t) => t[1]);
    }

    private getPrivateTag(name: string): string | undefined {
        return this.privateTags.find((t) => t[0] === name)?.[1];
    }

    private setPublicTag(name: string, value: string | string[]) {
        this.publicTags = this.publicTags.filter((t) => t[0] !== name);
        if (Array.isArray(value)) {
            for (const v of value) {
                this.publicTags.push([name, v]);
            }
        } else {
            this.publicTags.push([name, value]);
        }
    }

    private getPublicTags(name: string): string[] {
        return this.publicTags.filter((t) => t[0] === name).map((t) => t[1]);
    }

    set relays(urls: WebSocket["url"][]) {
        this.setPrivateTag("relay", urls);
    }

    get relays(): WebSocket["url"][] {
        return this.getPrivateTags("relay");
    }

    set mints(urls: string[]) {
        this.setPublicTag("mint", urls);
    }

    get mints(): string[] {
        return this.getPublicTags("mint");
    }

    set name(value: string) {
        this.setPrivateTag("name", value);
    }

    get name(): string | undefined {
        return this.getPrivateTag("name") ?? this.event.tagValue("name");
    }

    get unit(): string {
        return this.getPrivateTag("unit") ?? "sats";
    }

    set unit(unit: string) {
        this.setPrivateTag("unit", unit);
    }

    /**
     * Returns the p2pk of this wallet
     */
    async getP2pk(): Promise<string | undefined> {
        if (this.p2pk) return this.p2pk;
        if (this.privkey) {
            const signer = new NDKPrivateKeySigner(this.privkey);
            const user = await signer.user();
            this.p2pk = user.pubkey;
            return this.p2pk;
        }
    }

    /**
     * Returns the private key of this wallet
     */
    get privkey(): string | undefined {
        const privkey = this.getPrivateTag("privkey");
        if (privkey) return privkey;

        if (this.event.ndk?.signer instanceof NDKPrivateKeySigner) {
            return this.event.ndk.signer.privateKey;
        }
    }

    set privkey(privkey: string | undefined | false) {
        if (privkey) {
            this.setPrivateTag("privkey", privkey ?? false);
        } else {
            this.skipPrivateKey = privkey === false;
            this.p2pk = undefined;
        }
    }

    /**
     * Whether this wallet has been deleted
     */
    get isDeleted(): boolean {
        if (!this.event?.tags) return false;
        return this.event.tags.some((t) => t[0] === "deleted");
    }

    async publish() {
        if (!this.isDeleted) {
            // if we haven't been instructed to skip the private key
            // and we don't have one, generate it
            if (!this.skipPrivateKey && !this.privkey) {
                const signer = NDKPrivateKeySigner.generate();
                this.privkey = signer.privateKey;
            }

            // set the tags to the public tags
            this.event.tags = this.publicTags;

            // ensure we don't have a privkey in the public tags
            for (const tag of this.event.tags) {
                if (tag[0] === "privkey") {
                    throw new Error("privkey should not be in public tags!");
                }
            }

            // encrypt private tags
            this.event.content = JSON.stringify(this.privateTags);
            const user = await this.event.ndk!.signer!.user();
            await this.event.encrypt(user, undefined, "nip44");
        }

        return this.event.publishReplaceable(this.relaySet);
    }

    get relaySet(): NDKRelaySet | undefined {
        if (this.relays.length === 0) return undefined;

        return NDKRelaySet.fromRelayUrls(this.relays, this.event.ndk!);
    }

    /**
     * Prepares a deposit
     * @param amount
     * @param mint
     * @param unit
     *
     * @example
     * const wallet = new NDKCashuWallet(...);
     * const deposit = wallet.deposit(1000, "https://mint.example.com", "sats");
     * deposit.on("success", (token) => {
     *   console.log("deposit successful", token);
     * });
     * deposit.on("error", (error) => {
     *   console.log("deposit failed", error);
     * });
     *
     * // start monitoring the deposit
     * deposit.start();
     */
    public deposit(amount: number, mint?: string, unit?: string): NDKCashuDeposit {
        const deposit = new NDKCashuDeposit(this, amount, mint, unit);
        deposit.on("success", (token) => {
            this.addToken(token);
        });
        return deposit;
    }

    public async addHistoryItem(
        direction: "in" | "out",
        amount: number,
        token?: NDKCashuToken
    ) {
        const historyEvent = new NDKWalletChange(this.event.ndk);
        historyEvent.tag(this.event);
        await historyEvent.sign();
        historyEvent.publish(this.relaySet);
    }

    /**
     * Pay a LN invoice with this wallet
     */
    async lnPay(
        { pr }: { pr: string },
        useMint?: MintUrl
    ): Promise<NDKPaymentConfirmationLN | undefined> {
        const pay = new NDKCashuPay(this, { pr });
        const result = await pay.payLn(useMint);
        if (!result) return;
        return { ...result };
    }

    /**
     * Swaps tokens to a specific amount, optionally locking to a p2pk.
     * @param amount
     */
    async cashuPay(payment: NDKZapDetails<CashuPaymentInfo>): Promise<NDKPaymentConfirmationCashu> {
        const { amount, unit, mints, p2pk } = payment;
        const pay = new NDKCashuPay(this, { amount, unit, mints, p2pk });
        return pay.payNut();
    }

    async redeemNutzap(nutzap: NDKEvent) {
        // this.emit("nutzap:seen", nutzap);

        try {
            const mint = nutzap.tagValue("u");
            if (!mint) throw new Error("missing mint");
            const proofs = JSON.parse(nutzap.content);
            console.log(proofs);

            const _wallet = new CashuWallet(new CashuMint(mint));
            const res = await _wallet.receiveTokenEntry(
                { proofs, mint },
                {
                    privkey: this.privkey,
                }
            );

            if (res) {
                // this.emit("nutzap:redeemed", nutzap);
            }

            const tokenEvent = new NDKCashuToken(this.event.ndk);
            tokenEvent.proofs = proofs;
            tokenEvent.mint = mint;
            tokenEvent.wallet = this;
            await tokenEvent.sign();
            tokenEvent.publish(this.relaySet);
            console.log("new token event", tokenEvent.rawEvent());

            const historyEvent = new NDKWalletChange(this.event.ndk);
            historyEvent.addRedeemedNutzap(nutzap);
            historyEvent.tag(this.event);
            historyEvent.tag(tokenEvent, NDKWalletChange.MARKERS.CREATED);
            await historyEvent.sign();
            historyEvent.publish(this.relaySet);
        } catch (e) {
            console.trace(e);
            // this.emit("nutzap:failed", nutzap, e);
        }
    }

    /**
     * Generates a new token event with proofs to be stored for this wallet
     * @param proofs Proofs to be stored
     * @param mint Mint URL
     * @param nutzap Nutzap event if these proofs are redeemed from a nutzap
     * @returns
     */
    async saveProofs(proofs: Proof[], mint: MintUrl, nutzap?: NDKEvent) {
        this.emit("received_proofs", proofs, mint);

        const tokenEvent = new NDKCashuToken(this.event.ndk);
        tokenEvent.proofs = proofs;
        tokenEvent.mint = mint;
        tokenEvent.wallet = this;

        await tokenEvent.sign();

        // we can add it to the wallet here
        this.addToken(tokenEvent);

        tokenEvent.publish(this.relaySet).catch((e) => {
            console.error("failed to publish token", e, tokenEvent.rawEvent());
        });

        if (nutzap) {
            const historyEvent = new NDKWalletChange(this.event.ndk);
            historyEvent.addRedeemedNutzap(nutzap);
            historyEvent.tag(this.event);
            historyEvent.tag(tokenEvent, NDKWalletChange.MARKERS.CREATED);
            await historyEvent.sign();
            historyEvent.publish(this.relaySet);
        }

        return tokenEvent;
    }

    public addToken(token: NDKCashuToken) {
        if (!this.knownTokens.has(token.id)) {
            this.knownTokens.add(token.id);
            this.tokens.push(token);
            this.emit("balance_updated");
        }
    }

    /**
     * Removes a token that has been deleted
     */
    public removeTokenId(id: NDKEventId) {
        if (!this.knownTokens.has(id)) return false;

        this.tokens = this.tokens.filter((t) => t.id !== id);
        this.emit("balance_updated");
    }

    async delete(reason?: string, publish = true): Promise<NDKEvent> {
        this.event.content = "";
        this.event.tags = [["d", this.walletId], ["deleted"]];
        if (publish) this.event.publishReplaceable();

        return this.event.delete(reason, publish);
    }

    /**
     * Gets all tokens, grouped by mint
     */
    get mintTokens(): Record<MintUrl, NDKCashuToken[]> {
        const tokens: Record<MintUrl, NDKCashuToken[]> = {};

        for (const token of this.tokens) {
            if (token.mint) {
                tokens[token.mint] ??= [];
                tokens[token.mint].push(token);
            }
        }

        return tokens;
    }

    async balance(): Promise<NDKWalletBalance[] | undefined> {
        if (this.status === NDKWalletStatus.LOADING) {
            const balance = this.getPrivateTag("balance");
            if (balance)
                return [
                    {
                        amount: Number(balance),
                        unit: this.unit,
                    },
                ];
        }

        // aggregate all token balances
        const proofBalances = proofsTotalBalance(this.tokens.map((t) => t.proofs).flat());
        return [
            {
                amount: proofBalances,
                unit: this.unit,
            },
        ];
    }

    /**
     * Writes the wallet balance to relays
     */
    async updateBalance() {
        const balance = (await this.balance())?.[0].amount;
        if (!balance) return;

        this.setPrivateTag("balance", balance.toString() ?? "0");
        d("publishing balance (%d)", balance);
        this.publish();
    }

    public mintBalance(mint: MintUrl) {
        return proofsTotalBalance(
            this.tokens
                .filter((t) => t.mint === mint)
                .map((t) => t.proofs)
                .flat()
        );
    }

    get mintBalances(): Record<MintUrl, number> {
        const balances: Record<MintUrl, number> = {};

        for (const token of this.tokens) {
            if (token.mint) {
                balances[token.mint] ??= 0;
                balances[token.mint] += token.amount;
            }
        }

        return balances;
    }
}
