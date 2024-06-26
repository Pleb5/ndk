import NDK, { NDKEvent, NDKPrivateKeySigner, NDKSubscription } from "@nostr-dev-kit/ndk"
import NDKCacheAdapterDexie from "./index.js";

const ndk = new NDK()
ndk.signer = NDKPrivateKeySigner.generate();
ndk.cacheAdapter = new NDKCacheAdapterDexie();

describe("foundEvent", () => {
    beforeAll(async () => {
        // save event
        const event = new NDKEvent(ndk);
        event.kind = 1;
        event.tags.push(["a", "123"]);
        await event.sign();
        ndk.cacheAdapter!.setEvent(event, []);
    });
    
    it("correctly avoids reporting events that don't fully match NIP-01 filter", async () => {
        const subscription = new NDKSubscription(ndk, [{"#a": ["123"], "#t": ["hello"]}]);
        jest.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter!.query(subscription);
        expect(subscription.eventReceived).toBeCalledTimes(0);
    });

    it("correctly reports events that fully match NIP-01 filter", async () => {
        const subscription = new NDKSubscription(ndk, [{"#a": ["123"]}]);
        jest.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter!.query(subscription);
        expect(subscription.eventReceived).toBeCalledTimes(1);
    })
})