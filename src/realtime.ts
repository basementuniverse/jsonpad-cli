import realtime from '@basementuniverse/jsonpad-realtime-sdk';

export type { EventType } from '@basementuniverse/jsonpad-realtime-sdk';

// The realtime SDK's Node build is CommonJS, so an ES module only sees its
// exports object as the default import
export const JSONPadRealtime = realtime.default;
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
