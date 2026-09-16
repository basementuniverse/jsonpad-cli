import type { Command } from 'commander';
import type { Auth } from '../config.ts';
import type { Context } from '../context.ts';
import { apiError } from '../errors.ts';
import {
  addOutputOptions,
  formatBytes,
  formatDate,
  formatNumber,
  printRecord,
  resolveOutputFormat,
  type OutputOptions,
} from '../output.ts';
import type { TokenPermission, TokenSelf } from '../sdk.ts';

export function defineWhoami(command: Command, context: Context): Command {
  return addOutputOptions(
    command
      .summary("Show the token you're using, its plan's limits and usage")
      .description(
        "Show the token you're using: what it can do, its plan's limits, and the account's usage this month"
      )
      .action((options: OutputOptions) => whoami(context, options))
  );
}

export function describePermission(permission: TokenPermission): string {
  const scopes = [
    ['lists', permission.listIds],
    ['items', permission.itemIds],
    ['indexes', permission.indexIds],
    ['identities', permission.identityIds],
    ['groups', permission.groups],
  ] as const;
  const scope = scopes
    .filter(([, values]) => values && values.length > 0)
    .map(([name, values]) => `${name}: ${values!.join(', ')}`);

  return [
    permission.mode,
    permission.action,
    ...(permission.resourceType ? [permission.resourceType] : []),
    ...(scope.length > 0 ? [`(${scope.join('; ')})`] : []),
  ].join(' ');
}

function describeLimit(
  used: number,
  limit: number | null,
  format: (value: number) => string
): string {
  return limit === null
    ? `${format(used)} (no limit)`
    : `${format(used)} of ${format(limit)}`;
}

export function whoamiDetails(
  context: Context,
  self: TokenSelf,
  auth: Auth,
  identity: string | null = null
): [string, string][] {
  const { dim, yellow, red } = context.colours;
  const { token, plan, usage } = self;

  const status = [
    token.locked ? red('locked') : null,
    token.activated ? null : red('deactivated'),
    token.expiresAt
      ? token.expiresAt.getTime() < Date.now()
        ? red(`expired ${formatDate(token.expiresAt)}`)
        : `expires ${formatDate(token.expiresAt)}`
      : null,
  ].filter(Boolean);

  const rate = [
    plan.maxRequestsPerMinute !== null
      ? `${formatNumber(plan.maxRequestsPerMinute)} requests per minute`
      : null,
    plan.rateLimit !== null ? `${plan.rateLimit}ms between requests` : null,
  ].filter(Boolean);

  const requests = [
    describeLimit(usage.requestCount, usage.requestAllowance, formatNumber),
    ...(usage.requestsRemaining !== null
      ? [`${formatNumber(usage.requestsRemaining)} left`]
      : []),
    ...(usage.credits > 0 ? [`${formatNumber(usage.credits)} credits`] : []),
  ];

  const rows: [string, string][] = [
    ['Token', `${token.name} ${dim(token.id)}`],
    ['Status', status.length > 0 ? status.join(', ') : 'active'],
    [
      'Using',
      auth.source.type === 'profile'
        ? `profile ${auth.source.name}`
        : 'JSONPAD_TOKEN',
    ],
    ['API', auth.apiUrl],
    ...(identity !== null ? [['Identity', identity] as [string, string]] : []),
    ['IPs', token.ips && token.ips.length > 0 ? token.ips.join(', ') : 'any'],
    ['Plan', plan.name],
    ['Rate limit', rate.length > 0 ? rate.join(', ') : 'none'],
    [
      'Requests',
      `${requests.join(', ')} ${dim(
        `(${formatDate(usage.periodStart)} to ${formatDate(usage.periodEnd)})`
      )}`,
    ],
    [
      'Storage',
      describeLimit(usage.storageBytes, usage.storageAllowance, formatBytes),
    ],
  ];

  if (usage.degraded) {
    rows.push([
      'Degraded',
      yellow(
        'yes: the allowance and credits have run out, so writes are refused and reads are slower'
      ),
    ]);
  }

  rows.push(['Permissions', '']);
  for (const permission of token.permissions) {
    rows.push(['', describePermission(permission)]);
  }
  if (token.permissions.length === 0) {
    rows.push(['', dim('none')]);
  }

  return rows;
}

export async function whoami(
  context: Context,
  options: OutputOptions
): Promise<void> {
  const format = resolveOutputFormat(context, options);
  const jsonpad = context.createClient();
  let self: TokenSelf;

  try {
    self = await jsonpad.fetchSelfToken();
  } catch (error) {
    throw apiError(error, context.auth?.apiUrl);
  }

  // Items commands act as the identity in JSONPAD_IDENTITY_TOKEN, which is
  // easy to forget is set, so a table says which identity that is
  let identity: string | null = null;
  if (context.identity && format === 'table') {
    try {
      const found = await jsonpad.fetchSelfIdentity();
      identity = `${found.group ? `${found.group}/` : ''}${found.name} ${context.colours.dim(
        `${found.id}, from JSONPAD_IDENTITY_TOKEN`
      )}`;
    } catch (error) {
      identity = context.colours.red(
        `JSONPAD_IDENTITY_TOKEN is set, but isn't valid: ${apiError(error).message}`
      );
    }
  }

  printRecord(context, format, self, {
    id: record => record.token.id,
    details: record => whoamiDetails(context, record, context.auth!, identity),
  });
}
