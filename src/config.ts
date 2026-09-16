import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { CliError, EXIT_NOT_FOUND } from './errors.ts';

export const DEFAULT_API_URL = 'https://api.jsonpad.io';

export type Profile = {
  token: string;
  apiUrl?: string;
};

export type Config = {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
};

/**
 * Where the token for a command came from
 */
export type AuthSource =
  { type: 'environment' } | { type: 'profile'; name: string };

export type Auth = {
  token: string;
  apiUrl: string;
  source: AuthSource;
};

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new CliError(
      `"${name}" isn't a valid profile name. Use letters, numbers, - and _`
    );
  }
}

/**
 * The config file's path: JSONPAD_CONFIG if it's set, otherwise
 * jsonpad/config.json in the platform's config directory
 */
export function configPath(context: Context): string {
  const { env } = context;

  if (env.JSONPAD_CONFIG) {
    return path.resolve(context.cwd, env.JSONPAD_CONFIG);
  }

  if (context.platform === 'win32') {
    const appData =
      env.APPDATA || path.join(context.homedir(), 'AppData', 'Roaming');

    return path.join(appData, 'jsonpad', 'config.json');
  }

  const configHome =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(context.homedir(), '.config');

  return path.join(configHome, 'jsonpad', 'config.json');
}

/**
 * Read the config file. A missing file is an empty config
 */
export function readConfig(context: Context): Config {
  const file = configPath(context);
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { profiles: {} };
    }

    throw new CliError(`Can't read ${file}: ${error.message}`);
  }

  if (context.platform !== 'win32') {
    const mode = fs.statSync(file).mode;

    if ((mode & 0o077) !== 0) {
      context.error(
        `${context.colours.yellow('warning')}: ${file} can be read by other users, and it contains API tokens. Run chmod 600 ${file}`
      );
    }
  }

  let config: any;
  try {
    config = JSON.parse(text);
  } catch (error: any) {
    throw new CliError(`Can't parse ${file}: ${error.message}`);
  }

  const profiles = config?.profiles;
  const validProfiles =
    profiles &&
    typeof profiles === 'object' &&
    !Array.isArray(profiles) &&
    Object.values(profiles).every(
      (profile: any) =>
        profile &&
        typeof profile.token === 'string' &&
        (profile.apiUrl === undefined || typeof profile.apiUrl === 'string')
    );

  if (
    !config ||
    typeof config !== 'object' ||
    !validProfiles ||
    (config.defaultProfile !== undefined &&
      typeof config.defaultProfile !== 'string')
  ) {
    throw new CliError(
      `${file} isn't a valid config file. Fix it, or delete it and add your profiles again`
    );
  }

  return config;
}

/**
 * Write the config file, readable only by the current user
 */
export function writeConfig(context: Context, config: Config): string {
  const file = configPath(context);
  const temporaryFile = `${file}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

    // Write a new file and move it into place, so that a failed write can't
    // leave a half-written config behind
    fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, file);
  } catch (error: any) {
    fs.rmSync(temporaryFile, { force: true });
    throw new CliError(`Can't write ${file}: ${error.message}`);
  }

  return file;
}

/**
 * Work out which token and API URL a command uses
 *
 * In order:
 * 1. a profile chosen with --profile, or JSONPAD_PROFILE
 * 2. JSONPAD_TOKEN (and JSONPAD_API_URL)
 * 3. the default profile
 *
 * --api-url overrides the API URL from any of these. A profile's own API URL
 * takes precedence over JSONPAD_API_URL, because a profile's token and URL
 * belong together
 */
export function resolveAuth(context: Context): Auth {
  const { env, globalOptions } = context;
  const chosenProfile = globalOptions.profile || env.JSONPAD_PROFILE;
  const apiUrl = (url: string | undefined) =>
    globalOptions.apiUrl || url || env.JSONPAD_API_URL || DEFAULT_API_URL;

  if (!chosenProfile && env.JSONPAD_TOKEN) {
    return {
      token: env.JSONPAD_TOKEN,
      apiUrl: apiUrl(undefined),
      source: { type: 'environment' },
    };
  }

  // The config file is only read when it's needed, so a command run with
  // JSONPAD_TOKEN (e.g. in CI) doesn't depend on it
  const config = readConfig(context);
  const name = chosenProfile || config.defaultProfile;

  if (!name) {
    throw new CliError(
      'Set the JSONPAD_TOKEN environment variable to an API token'
    );
  }

  const profile = config.profiles[name];
  if (!profile) {
    throw new CliError(
      chosenProfile
        ? `There's no profile named "${name}". Run jsonpad config list to see your profiles`
        : `The default profile "${name}" doesn't exist. Run jsonpad config use <profile> to choose another one`,
      EXIT_NOT_FOUND
    );
  }

  return {
    token: profile.token,
    apiUrl: apiUrl(profile.apiUrl),
    source: { type: 'profile', name },
  };
}

/**
 * Show enough of a token to recognise it
 */
export function maskToken(token: string): string {
  return token.length > 8 ? `••••${token.slice(-4)}` : '••••';
}
