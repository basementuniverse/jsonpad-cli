/**
 * Shell completion
 *
 * `jsonpad completion <shell>` outputs a small script for the shell, which
 * asks `jsonpad __complete <words...>` for candidates every time Tab is
 * pressed. The candidates come from the command definitions, so they always
 * match the installed version
 */
import { Argument, type Command, type Option } from 'commander';
import type { Context } from './context.ts';

export const COMPLETE_COMMAND = '__complete';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;

export type Shell = (typeof SHELLS)[number];

function isHidden(item: Command | Option): boolean {
  return 'hidden' in item ? !!item.hidden : !!(item as any)._hidden;
}

/**
 * A command's options, and those of the commands above it (e.g. the global
 * options), which commander accepts anywhere
 */
function optionsFor(command: Command): Option[] {
  const options: Option[] = [];

  for (
    let current: Command | null = command;
    current;
    current = current.parent
  ) {
    options.push(...current.options.filter(option => !isHidden(option)));
  }

  return options;
}

function findOption(command: Command, flag: string): Option | undefined {
  return optionsFor(command).find(
    option => option.long === flag || option.short === flag
  );
}

function findSubcommand(command: Command, name: string): Command | undefined {
  return command.commands.find(
    child => child.name() === name || child.aliases().includes(name)
  );
}

/**
 * The subcommand that runs when a command group is given no subcommand, e.g.
 * `list` for `jsonpad items`
 */
function defaultSubcommand(command: Command): Command | undefined {
  const name = (command as any)._defaultCommandName as string | null;

  return name ? findSubcommand(command, name) : undefined;
}

/**
 * The candidates for the word being completed, given the words before it
 *
 * `words` is everything after `jsonpad`, with the (possibly empty) word being
 * completed last. No candidates means the shell should complete file names,
 * which suits arguments like `items import <file>` and options like `--out`
 */
export function completions(program: Command, words: string[]): string[] {
  const current = words.length > 0 ? words[words.length - 1] : '';
  let command = program;
  let positionals = 0;
  let optionTakingValue: Option | undefined;

  for (const word of words.slice(0, -1)) {
    if (optionTakingValue) {
      optionTakingValue = undefined;
      continue;
    }

    if (word.startsWith('-') && word !== '-') {
      // An option a group doesn't have belongs to its default subcommand
      if (!word.includes('=') && !findOption(command, word)) {
        command = defaultSubcommand(command) ?? command;
      }

      const option = word.includes('=') ? undefined : findOption(command, word);
      if (option && (option.required || option.optional)) {
        optionTakingValue = option;
      }
      continue;
    }

    const subcommand =
      positionals === 0 ? findSubcommand(command, word) : undefined;
    if (subcommand) {
      command = subcommand;
      continue;
    }

    // Anything else is an argument, which a group passes to its default
    // subcommand
    if (positionals === 0 && command.commands.length > 0) {
      command = defaultSubcommand(command) ?? command;
    }
    positionals++;
  }

  if (optionTakingValue) {
    return (optionTakingValue.argChoices ?? []).filter(choice =>
      choice.startsWith(current)
    );
  }

  if (current.startsWith('-')) {
    const withDefault = [command, defaultSubcommand(command)].filter(
      (candidate): candidate is Command => !!candidate
    );

    return [
      ...new Set([
        ...withDefault.flatMap(candidate =>
          optionsFor(candidate)
            .map(option => option.long)
            .filter(
              (flag): flag is string => !!flag && flag.startsWith(current)
            )
        ),
        ...('--help'.startsWith(current) ? ['--help'] : []),
      ]),
    ];
  }

  if (positionals === 0 && command.commands.length > 0) {
    return command.commands
      .filter(child => !isHidden(child))
      .map(child => child.name())
      .filter(name => name.startsWith(current));
  }

  const argument = command.registeredArguments[positionals];
  return (argument?.argChoices ?? []).filter(choice =>
    choice.startsWith(current)
  );
}

/**
 * The completion script for a shell
 */
export function completionScript(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return `# jsonpad completion for bash
# Add this to ~/.bashrc:
#   eval "$(jsonpad completion bash)"

_jsonpad_completion() {
  local IFS=$'\\n'
  COMPREPLY=($(jsonpad ${COMPLETE_COMMAND} "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}

complete -o default -F _jsonpad_completion jsonpad
`;

    case 'zsh':
      return `#compdef jsonpad
# jsonpad completion for zsh
# Add this to ~/.zshrc, after compinit:
#   eval "$(jsonpad completion zsh)"

_jsonpad() {
  local -a candidates
  candidates=("\${(@f)$(jsonpad ${COMPLETE_COMMAND} "\${(@)words[2,CURRENT]}" 2>/dev/null)}")

  if [[ -n "\${candidates[1]}" ]]; then
    compadd -- "\${candidates[@]}"
  else
    _files
  fi
}

compdef _jsonpad jsonpad
`;

    case 'fish':
      return `# jsonpad completion for fish
# Save this as ~/.config/fish/completions/jsonpad.fish:
#   jsonpad completion fish > ~/.config/fish/completions/jsonpad.fish

function __jsonpad_complete
    set -l candidates (jsonpad ${COMPLETE_COMMAND} (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)
    if test (count $candidates) -gt 0
        printf '%s\\n' $candidates
    else
        __fish_complete_path (commandline -ct)
    end
end

complete -c jsonpad -e
complete -c jsonpad -f -a '(__jsonpad_complete)'
`;
  }
}

export function defineCompletion(command: Command, context: Context): Command {
  return command
    .description(
      'Output a script that completes jsonpad commands and options when you press Tab'
    )
    .addArgument(new Argument('<shell>', 'The shell').choices(SHELLS))
    .addHelpText(
      'after',
      `
Setup:
  bash  Add to ~/.bashrc:  eval "$(jsonpad completion bash)"
  zsh   Add to ~/.zshrc, after compinit:  eval "$(jsonpad completion zsh)"
  fish  Run:  jsonpad completion fish > ~/.config/fish/completions/jsonpad.fish`
    )
    .action((shell: Shell) => {
      context.stdout.write(completionScript(shell));
    });
}
