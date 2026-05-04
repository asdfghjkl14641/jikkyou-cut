// Wrapper around Electron's `powerSaveBlocker` for the auto-record
// feature. Engaging the blocker tells the OS "don't put the system
// to sleep" — Windows will keep the CPU + network alive even past
// the user's idle-timeout, which is exactly what we want for an
// overnight recording session.
//
// Type chosen: `prevent-app-suspension`. We deliberately do NOT use
// `prevent-display-sleep` because:
//   - The user is asleep — they don't need the monitor on.
//   - 8 hours of CRT/LCD-on isn't free.
//   - app-suspension keeps CPU + network active, which is all we need.
// The Electron docs explicitly note that on Windows, app-suspension
// also prevents system sleep, so this single flag covers our use case.
//
// Reference-counted by recording. Two concurrent recordings hold
// the blocker; the second's stop() doesn't release until the first
// also stops. This way a manual stop on one creator doesn't release
// the blocker while another is still recording.

import { powerSaveBlocker } from 'electron';

let blockerId: number | null = null;
let activeReasons: Set<string> = new Set();

function ensureBlocker(): void {
  if (blockerId != null && powerSaveBlocker.isStarted(blockerId)) return;
  blockerId = powerSaveBlocker.start('prevent-app-suspension');
  console.log(`[power-save] blocker started: id=${blockerId}`);
}

function releaseBlocker(): void {
  if (blockerId == null) return;
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  console.log(`[power-save] blocker stopped (was id=${blockerId})`);
  blockerId = null;
}

// Reference-count style API. `reason` is a unique tag per consumer
// (e.g. `recording:twitch:hiiragi_tsurugi`). The blocker stays
// engaged as long as at least one tag is acquired. Idempotent —
// calling acquire() with a tag that's already active is a no-op.
export function acquire(reason: string): void {
  if (activeReasons.has(reason)) return;
  activeReasons.add(reason);
  ensureBlocker();
  console.log(`[power-save] acquire: ${reason} (active=${activeReasons.size})`);
}

export function release(reason: string): void {
  if (!activeReasons.has(reason)) return;
  activeReasons.delete(reason);
  console.log(`[power-save] release: ${reason} (active=${activeReasons.size})`);
  if (activeReasons.size === 0) {
    releaseBlocker();
  } else {
    console.log(
      `[power-save] blocker still active: ${activeReasons.size} consumer(s) — [${[...activeReasons].join(', ')}]`,
    );
  }
}

// Belt-and-braces shutdown. Called from app's will-quit so a stuck
// blocker doesn't leak past the process.
export function releaseAll(): void {
  if (activeReasons.size === 0 && blockerId == null) return;
  console.log(`[power-save] release-all: ${activeReasons.size} consumer(s)`);
  activeReasons.clear();
  releaseBlocker();
}

// For diagnostics + UI status display.
export function getStatus(): { active: boolean; reasons: string[]; blockerId: number | null } {
  return {
    active: activeReasons.size > 0,
    reasons: [...activeReasons],
    blockerId,
  };
}
