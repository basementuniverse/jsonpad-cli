import { createRequire } from 'node:module';
import realtime from '@basementuniverse/jsonpad-realtime-sdk';

export type { EventType } from '@basementuniverse/jsonpad-realtime-sdk';

// Like the SDK, the realtime SDK is a UMD build, so an ES module only sees its
// exports object as the default import
const RealtimeClientClass = realtime.default;

/**
 * The realtime SDK's build contains socket.io-client's browser build, which
 * connects with XMLHttpRequest. Node doesn't have one, so without this the
 * client never connects (and never says why). xmlhttprequest-ssl is what
 * socket.io-client's own Node build uses
 */
function provideXMLHttpRequest(): void {
  if (!('XMLHttpRequest' in globalThis)) {
    const require = createRequire(import.meta.url);

    (globalThis as any).XMLHttpRequest =
      require('xmlhttprequest-ssl').XMLHttpRequest;
  }
}

export const JSONPadRealtime = new Proxy(RealtimeClientClass, {
  construct(target, args) {
    provideXMLHttpRequest();

    return Reflect.construct(target, args);
  },
});
export type JSONPadRealtime = InstanceType<typeof JSONPadRealtime>;
export type RealtimeErrorEvent = InstanceType<
  typeof realtime.RealtimeErrorEvent
>;

/**
 * What jsonpad listen uses from a realtime client, so that tests can pass a
 * fake one
 */
export type RealtimeClient = Pick<
  JSONPadRealtime,
  'listen' | 'close' | 'addEventListener'
>;

export const REALTIME_EVENT_TYPES = [
  'list-created',
  'list-updated',
  'list-deleted',
  'item-created',
  'item-updated',
  'item-restored',
  'item-deleted',
] as const;
