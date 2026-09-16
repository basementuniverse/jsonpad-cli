export type Colours = Record<
  'green' | 'yellow' | 'red' | 'cyan' | 'dim' | 'bold',
  (text: string) => string
>;

export function createColours(enabled: boolean): Colours {
  const colour = (code: number) => (text: string) =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

  return {
    green: colour(32),
    yellow: colour(33),
    red: colour(31),
    cyan: colour(36),
    dim: colour(2),
    bold: colour(1),
  };
}

/**
 * Show a value from a change as JSON, shortened to fit on one line
 */
export function formatValue(value: unknown): string {
  const json = JSON.stringify(value);

  return json !== undefined && json.length > 60
    ? `${json.slice(0, 57)}...`
    : String(json);
}

export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
