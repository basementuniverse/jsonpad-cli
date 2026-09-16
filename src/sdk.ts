import sdk from '@basementuniverse/jsonpad-sdk';

export type {
  Identity,
  Index,
  Item,
  List,
  PaginatedResponse,
  MoveListsChange,
  MoveListsResult,
  ResponseMeta,
  SyncSchemaChange,
  SyncSchemaDocument,
  SyncSchemaResult,
  TokenPermission,
  TokenSelf,
} from '@basementuniverse/jsonpad-sdk';

// The SDK is a UMD build, which Node loads as CommonJS, so an ES module only
// sees its exports object as the default import
export const JSONPad = sdk.default;
export const { IndexBuildError, JSONPadError } = sdk;

export type JSONPad = InstanceType<typeof JSONPad>;
