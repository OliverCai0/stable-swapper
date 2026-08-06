/**
 * Terminal presentation helpers for the migration-verify demo phases.
 *
 * Colour and animation turn themselves off when stdout is not a TTY, or when
 * NO_COLOR is set, so piping a run to a file or into CI still yields plain text.
 * Set MIGRATION_VERIFY_DEMO_PACE=<ms> to slow the phases down for a live audience.
 */

const isTty = Boolean(process.stdout.isTTY);
const noColor = (process.env.NO_COLOR ?? "") !== "";
const forceColor = ["1", "true"].includes(process.env.FORCE_COLOR ?? "");

export const useColor = forceColor || (isTty && !noColor);
export const useAnimation =
  isTty && (process.env.MIGRATION_VERIFY_NO_ANIMATION ?? "") === "";

const BOX_WIDTH = 66;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function wrap(open: number, close: number): (text: string) => string {
  return (text: string) =>
    useColor ? `\u001b[${open}m${text}\u001b[${close}m` : text;
}

export const color = {
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
};

/** Visible length, ignoring ANSI escapes, so padding stays correct when colourised. */
function plainLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function boxLine(text: string): string {
  const inner = BOX_WIDTH - 4;
  const visible = plainLength(text);
  const clipped = visible > inner ? text.slice(0, inner - 1) + "…" : text;
  const pad = " ".repeat(Math.max(0, inner - plainLength(clipped)));
  return `${color.cyan("║")}  ${clipped}${pad}${color.cyan("║")}`;
}

export function banner(title: string, subtitle?: string): void {
  console.log();
  console.log(color.cyan("╔" + "═".repeat(BOX_WIDTH - 2) + "╗"));
  console.log(boxLine(color.bold(title)));
  if (subtitle) console.log(boxLine(color.dim(subtitle)));
  console.log(color.cyan("╚" + "═".repeat(BOX_WIDTH - 2) + "╝"));
}

export function section(title: string): void {
  console.log();
  console.log(color.bold(color.cyan(`▸ ${title}`)));
}

export function kv(label: string, value: string): void {
  console.log(`  ${color.gray(label.padEnd(14))} ${value}`);
}

export function ok(message: string): void {
  console.log(`  ${color.green("✔")} ${message}`);
}

export function info(message: string): void {
  console.log(`  ${color.blue("ℹ")} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${color.yellow("▲")} ${message}`);
}

export function fail(message: string): void {
  console.log(`  ${color.red("✘")} ${message}`);
}

export function note(message: string): void {
  console.log(`    ${color.gray(message)}`);
}

export function blank(): void {
  console.log();
}

function elapsedTag(startedAt: number): string {
  return color.gray(`(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
}

export interface Spinner {
  update(text: string): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

/** Animated progress for in-flight transactions; prints a single line when static. */
export function spinner(label: string): Spinner {
  const startedAt = Date.now();
  let text = label;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const render = () => {
    const glyph = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length];
    process.stdout.write(`\r  ${color.cyan(glyph)} ${text}`);
  };

  const clearLine = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (useAnimation) {
      const width = Math.min(process.stdout.columns ?? 80, 200);
      process.stdout.write("\r" + " ".repeat(width - 1) + "\r");
    }
  };

  if (useAnimation) {
    render();
    timer = setInterval(render, 80);
    timer.unref?.();
  }

  return {
    update(next: string) {
      text = next;
    },
    succeed(message?: string) {
      clearLine();
      console.log(
        `  ${color.green("✔")} ${message ?? text} ${elapsedTag(startedAt)}`
      );
    },
    fail(message?: string) {
      clearLine();
      console.log(
        `  ${color.red("✘")} ${message ?? text} ${elapsedTag(startedAt)}`
      );
    },
    stop: clearLine,
  };
}

/** Visualises an account growing in place: filled = original bytes, hatched = added. */
export function growthBar(from: number, to: number, width = 34): string {
  const filled = Math.max(
    1,
    Math.min(width - 1, Math.round((from / to) * width))
  );
  return (
    color.gray("▕") +
    color.green("█".repeat(filled)) +
    color.yellow("▒".repeat(width - filled)) +
    color.gray("▏")
  );
}

/** Optional delay so a live audience can follow along; no-op unless DEMO_PACE is set. */
export function pace(ms?: number): Promise<void> {
  const configured = Number(process.env.MIGRATION_VERIFY_DEMO_PACE ?? 0);
  if (!Number.isFinite(configured) || configured <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms ?? configured));
}

export function signatureLine(signature: string | null | undefined): void {
  console.log(
    signature
      ? `    ${color.gray("sig")} ${color.dim(signature)}`
      : `    ${color.gray("sig (none — rejected in simulation)")}`
  );
}
