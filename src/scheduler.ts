import { log } from "./logger.js";

export interface ScheduledTask {
  name: string;
  stop(): void;
}

/**
 * 一定間隔でタスクを実行する。前回の実行が終わってから interval 待つ（重複実行しない）。
 * 例外は捕捉してログに出し、ループは止めない。
 */
export function every(name: string, intervalMs: number, fn: () => Promise<void>, opts: { immediate?: boolean } = {}): ScheduledTask {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async (): Promise<void> => {
    if (stopped) return;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      log.error(`[${name}] 失敗`, err);
    }
    if (stopped) return;
    const elapsed = Date.now() - started;
    log.debug(`[${name}] 完了 ${elapsed}ms`);
    timer = setTimeout(run, Math.max(250, intervalMs));
  };

  timer = setTimeout(run, opts.immediate === false ? intervalMs : 0);
  return {
    name,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
