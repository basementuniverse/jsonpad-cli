import type { Command } from 'commander';
import {
  configPath,
  maskToken,
  readConfig,
  validateProfileName,
  writeConfig,
  type Config,
} from '../config.ts';
import type { Context } from '../context.ts';
import { CliError, EXIT_NOT_FOUND } from '../errors.ts';
import { canPrompt, confirm, promptSecret, readStdin } from '../input.ts';
import {
  addOutputOptions,
  printRecords,
  resolveOutputFormat,
  type OutputOptions,
} from '../output.ts';

type ProfileSummary = {
  name: string;
  apiUrl: string | null;
  token: string;
  default: boolean;
};

export function defineConfig(command: Command, context: Context): Command {
  command.description(
    "Manage profiles: saved API tokens, so you don't need JSONPAD_TOKEN"
  );

  command
    .command('set-profile')
    .summary('Add or update a profile')
    .description(
      "Add or update a profile. The token is asked for in a terminal, or read from stdin (e.g. from a password manager). The global --api-url option sets the profile's API URL"
    )
    .argument('<name>', 'The profile name')
    .option('--default', 'Make this the default profile')
    .action((name: string, options: { default?: boolean }, self: Command) =>
      setProfile(context, name, {
        ...options,
        apiUrl: self.optsWithGlobals().apiUrl,
      })
    );

  command
    .command('use')
    .description('Choose the default profile')
    .argument('<name>', 'The profile name')
    .action((name: string) => useProfile(context, name));

  addOutputOptions(
    command
      .command('list')
      .alias('ls')
      .description('List profiles (tokens are masked)')
      .action((options: OutputOptions) => listProfiles(context, options))
  );

  command
    .command('remove')
    .alias('rm')
    .description('Remove a profile')
    .argument('<name>', 'The profile name')
    .option('-y, --yes', "Don't ask for confirmation")
    .action((name: string, options: { yes?: boolean }) =>
      removeProfile(context, name, options)
    );

  command
    .command('path')
    .description(
      'Show where the config file is (set JSONPAD_CONFIG to use a different file)'
    )
    .action(() => context.log(configPath(context)));

  return command;
}

function requireProfile(config: Config, name: string) {
  const profile = config.profiles[name];

  if (!profile) {
    throw new CliError(
      `There's no profile named "${name}". Run jsonpad config list to see your profiles`,
      EXIT_NOT_FOUND
    );
  }

  return profile;
}

async function readToken(
  context: Context,
  name: string,
  existing: boolean
): Promise<string> {
  if (canPrompt(context)) {
    return (
      await promptSecret(
        context,
        existing
          ? `API token for ${name} (leave empty to keep the current one): `
          : `API token for ${name}: `
      )
    ).trim();
  }

  return (await readStdin(context)).trim();
}

export async function setProfile(
  context: Context,
  name: string,
  options: { default?: boolean; apiUrl?: string }
): Promise<void> {
  validateProfileName(name);

  if (options.apiUrl !== undefined) {
    try {
      new URL(options.apiUrl);
    } catch {
      throw new CliError(`--api-url must be a URL, e.g. http://localhost:3000`);
    }
  }

  const config = readConfig(context);
  const existing = config.profiles[name];
  const token = await readToken(context, name, !!existing);

  if (!token && !existing) {
    throw new CliError(
      canPrompt(context)
        ? 'A profile needs an API token'
        : `A profile needs an API token. Pass it on stdin, e.g. jsonpad config set-profile ${name} < token.txt`
    );
  }

  config.profiles[name] = {
    token: token || existing!.token,
    ...((options.apiUrl ?? existing?.apiUrl)
      ? { apiUrl: options.apiUrl ?? existing!.apiUrl }
      : {}),
  };

  const isDefault = options.default || !config.defaultProfile;
  if (isDefault) {
    config.defaultProfile = name;
  }

  const file = writeConfig(context, config);

  context.error(
    `${existing ? 'Updated' : 'Added'} profile ${context.colours.bold(name)}${
      isDefault ? ' (the default)' : ''
    } in ${file}`
  );
  context.error(
    context.colours.dim(
      `Run jsonpad whoami${isDefault ? '' : ` --profile ${name}`} to check the token`
    )
  );
}

export async function useProfile(
  context: Context,
  name: string
): Promise<void> {
  const config = readConfig(context);
  requireProfile(config, name);

  config.defaultProfile = name;
  writeConfig(context, config);

  context.error(`The default profile is now ${context.colours.bold(name)}`);
}

export async function listProfiles(
  context: Context,
  options: OutputOptions
): Promise<void> {
  const format = resolveOutputFormat(context, options);
  const config = readConfig(context);
  const profiles: ProfileSummary[] = Object.entries(config.profiles).map(
    ([name, profile]) => ({
      name,
      apiUrl: profile.apiUrl ?? null,
      token: maskToken(profile.token),
      default: name === config.defaultProfile,
    })
  );

  printRecords(context, format, profiles, {
    id: profile => profile.name,
    columns: [
      { header: '', value: profile => (profile.default ? '*' : '') },
      { header: 'NAME', value: profile => profile.name },
      { header: 'TOKEN', value: profile => profile.token },
      {
        header: 'API URL',
        value: profile => profile.apiUrl ?? context.colours.dim('(default)'),
      },
    ],
    empty: 'No profiles. Add one with jsonpad config set-profile <name>',
  });
}

export async function removeProfile(
  context: Context,
  name: string,
  options: { yes?: boolean }
): Promise<void> {
  const config = readConfig(context);
  requireProfile(config, name);

  await confirm(context, {
    question: `Remove the profile ${name}?`,
    yes: options.yes,
  });

  delete config.profiles[name];
  const wasDefault = config.defaultProfile === name;
  if (wasDefault) {
    delete config.defaultProfile;
  }

  writeConfig(context, config);

  context.error(`Removed profile ${context.colours.bold(name)}`);
  if (wasDefault && Object.keys(config.profiles).length > 0) {
    context.error(
      context.colours.dim(
        'It was the default profile. Choose another with jsonpad config use <name>'
      )
    );
  }
}
