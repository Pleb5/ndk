import { EventTemplate, NostrEvent, Relay, VerifiedEvent } from "nostr-tools";
import type { NDKRelay, NDKRelayConnectionStats } from ".";
import { NDKRelayStatus } from ".";
import { runWithTimeout } from "../utils/timeout";
import { NDKEvent } from "../events/index.js";
import { NDK } from "../ndk/index.js";

const MAX_RECONNECT_ATTEMPTS = 5;

export class NDKRelayConnectivity {
    private ndkRelay: NDKRelay;
    private _status: NDKRelayStatus;
    public relay: Relay;
    private timeoutMs?: number;
    private connectedAt?: number;
    private _connectionStats: NDKRelayConnectionStats = {
        attempts: 0,
        success: 0,
        durations: [],
    };
    private debug: debug.Debugger;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    private ndk?: NDK;

    constructor(ndkRelay: NDKRelay, ndk?: NDK) {
        this.ndkRelay = ndkRelay;
        this._status = NDKRelayStatus.DISCONNECTED;
        this.relay = new Relay(this.ndkRelay.url);
        this.debug = this.ndkRelay.debug.extend("connectivity");
        this.ndk = ndk;

        this.relay.onnotice = (notice: string) => this.handleNotice(notice);
    }

    public async connect(timeoutMs?: number, reconnect = true): Promise<void> {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        timeoutMs ??= this.timeoutMs;
        if (!this.timeoutMs && timeoutMs) this.timeoutMs = timeoutMs;

        const connectHandler = () => {
            this.updateConnectionStats.connected();

            this._status = NDKRelayStatus.CONNECTED;
            this.ndkRelay.emit("connect");
            this.ndkRelay.emit("ready");
        };

        const disconnectHandler = () => {
            this.updateConnectionStats.disconnected();

            if (this._status === NDKRelayStatus.CONNECTED) {
                this._status = NDKRelayStatus.DISCONNECTED;

                this.handleReconnection();
            }
            this.ndkRelay.emit("disconnect");
        };

        const authHandler = async (challenge: string) => {
            const authPolicy = this.ndkRelay.authPolicy ?? this.ndk?.relayAuthDefaultPolicy;

            this.debug("Relay requested authentication", {
                havePolicy: !!authPolicy,
            });

            if (authPolicy) {
                if (this._status !== NDKRelayStatus.AUTHENTICATING) {
                    this._status = NDKRelayStatus.AUTHENTICATING;
                    const res = await authPolicy(this.ndkRelay, challenge);
                    this.debug("Authentication policy returned", !!res);

                    if (res instanceof NDKEvent) {
                        this.relay.auth(async (evt: EventTemplate): Promise<VerifiedEvent> => {
                            return res.rawEvent() as VerifiedEvent;
                        });
                    }

                    if (res === true) {
                        if (!this.ndk?.signer) {
                            throw new Error("No signer available for authentication");
                        } else if (this._status === NDKRelayStatus.AUTHENTICATING) {
                            this.debug("Authentication policy finished");
                            this.relay.auth(async (evt: EventTemplate): Promise<VerifiedEvent> => {
                                const event = new NDKEvent(this.ndk, evt as NostrEvent);
                                await event.sign();
                                return event.rawEvent() as VerifiedEvent;
                            });
                            this._status = NDKRelayStatus.CONNECTED;
                            this.ndkRelay.emit("authed");
                        }
                    }
                }
            } else {
                this.ndkRelay.emit("auth", challenge);
            }
        };

        try {
            this.updateConnectionStats.attempt();
            if (this._status === NDKRelayStatus.DISCONNECTED)
                this._status = NDKRelayStatus.CONNECTING;
            else this._status = NDKRelayStatus.RECONNECTING;

            this.relay.onclose = disconnectHandler;
            this.relay._onauth = authHandler;

            // We have to call bind here otherwise the relay object isn't available in the runWithTimeout function
            await runWithTimeout(
                this.relay.connect.bind(this.relay),
                timeoutMs,
                "Timed out while connecting"
            )
                .then(() => {
                    connectHandler();
                })
                .catch((e) => {
                    this.debug("Failed to connect", this.relay.url, e);
                });
        } catch (e) {
            // this.debug("Failed to connect", e);
            this._status = NDKRelayStatus.DISCONNECTED;
            if (reconnect) this.handleReconnection();
            else this.ndkRelay.emit("delayed-connect", 2 * 24 * 60 * 60 * 1000);
            throw e;
        }
    }

    public disconnect(): void {
        this._status = NDKRelayStatus.DISCONNECTING;
        if (!this.relay.connected) return;
        
        try {
            this.relay.close();
        } catch (e) {
            this.debug("Failed to disconnect", e);
            this._status = NDKRelayStatus.DISCONNECTED;
        }
    }

    get status(): NDKRelayStatus {
        return this._status;
    }

    public isAvailable(): boolean {
        return this._status === NDKRelayStatus.CONNECTED;
    }

    /**
     * Evaluates the connection stats to determine if the relay is flapping.
     */
    private isFlapping(): boolean {
        const durations = this._connectionStats.durations;
        if (durations.length % 3 !== 0) return false;

        const sum = durations.reduce((a, b) => a + b, 0);
        const avg = sum / durations.length;
        const variance =
            durations.map((x) => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) /
            durations.length;
        const stdDev = Math.sqrt(variance);
        const isFlapping = stdDev < 1000;

        return isFlapping;
    }

    private async handleNotice(notice: string) {
        this.ndkRelay.emit("notice", notice);
    }

    /**
     * Called when the relay is unexpectedly disconnected.
     */
    private handleReconnection(attempt = 0): void {
        if (this.reconnectTimeout) return;
        this.debug("Attempting to reconnect", { attempt });

        if (this.isFlapping()) {
            this.ndkRelay.emit("flapping", this._connectionStats);
            this._status = NDKRelayStatus.FLAPPING;
            return;
        }

        const reconnectDelay = this.connectedAt
            ? Math.max(0, 60000 - (Date.now() - this.connectedAt))
            : 5000 * (this._connectionStats.attempts + 1);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this._status = NDKRelayStatus.RECONNECTING;
            // this.debug(`Reconnection attempt #${attempt}`);
            this.connect()
                .then(() => {
                    this.debug("Reconnected");
                })
                .catch((err) => {
                    // this.debug("Reconnect failed", err);

                    if (attempt < MAX_RECONNECT_ATTEMPTS) {
                        setTimeout(() => {
                            this.handleReconnection(attempt + 1);
                        }, (1000 * (attempt + 1)) ^ 4);
                    } else {
                        this.debug("Reconnect failed");
                    }
                });
        }, reconnectDelay);

        this.ndkRelay.emit("delayed-connect", reconnectDelay);

        this.debug("Reconnecting in", reconnectDelay);
        this._connectionStats.nextReconnectAt = Date.now() + reconnectDelay;
    }

    /**
     * Utility functions to update the connection stats.
     */
    private updateConnectionStats = {
        connected: () => {
            this._connectionStats.success++;
            this._connectionStats.connectedAt = Date.now();
        },

        disconnected: () => {
            if (this._connectionStats.connectedAt) {
                this._connectionStats.durations.push(
                    Date.now() - this._connectionStats.connectedAt
                );

                if (this._connectionStats.durations.length > 100) {
                    this._connectionStats.durations.shift();
                }
            }
            this._connectionStats.connectedAt = undefined;
        },

        attempt: () => {
            this._connectionStats.attempts++;
        },
    };

    /**
     * Returns the connection stats.
     */
    get connectionStats(): NDKRelayConnectionStats {
        return this._connectionStats;
    }
}
